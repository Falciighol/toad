//! The load engine: client setup, workers, stop/drain state machine, snapshots.
//!
//! Load model: N closed-loop workers (send → read full body → repeat). With an RPS cap,
//! every request gets a ticket with an intended send time from the shared
//! [`Dispatcher`] and latency is measured from that time (coordinated-omission
//! corrected); raw service time is recorded alongside.
//!
//! Stopping: a user Stop, the duration deadline, or the request budget "halts" the run
//! (no new requests). In-flight requests get `drain_grace` (2 s) to finish; whatever is
//! still running after that is aborted and counted as cancelled.

use crate::limiter::{active_workers_at, worker_start_offset, Dispatcher, Schedule};
use crate::metrics::{percentiles, shard_count, Aggregator, BottleneckDetector, Outcome, Shards};
use crate::models::*;
use crate::safety::{is_loopback, ResolvedTarget};
use std::collections::HashSet;
use std::error::Error as StdError;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task::JoinSet;
use tokio::time::{sleep, sleep_until, Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("invalid configuration: {}", .0.iter().map(|e| format!("{}: {}", e.field, e.message)).collect::<Vec<_>>().join("; "))]
    Invalid(Vec<FieldError>),
    #[error("could not build HTTP client: {0}")]
    Client(String),
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub run_id: String,
    pub limits: Limits,
    /// Addresses resolved during the safety check; the run is pinned to them.
    pub pinned: Option<ResolvedTarget>,
    /// Extra hosts redirects may follow to (besides the origin host and loopback literals).
    pub approved_hosts: HashSet<String>,
    pub drain_grace: Duration,
    pub tick: Duration,
}

impl RunOptions {
    pub fn new(run_id: impl Into<String>) -> Self {
        RunOptions {
            run_id: run_id.into(),
            limits: Limits::default(),
            pinned: None,
            approved_hosts: HashSet::new(),
            drain_grace: Duration::from_secs(2),
            tick: Duration::from_millis(250),
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn normalize_host(h: &str) -> String {
    h.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase()
}

fn is_loopback_literal(host: &str) -> bool {
    host == "localhost" || host.parse::<IpAddr>().is_ok_and(is_loopback)
}

fn build_client(load: &LoadSpec, origin_host: &str, opts: &RunOptions) -> Result<reqwest::Client, EngineError> {
    let redirect = if load.follow_redirects {
        let origin = origin_host.to_string();
        let approved = opts.approved_hosts.clone();
        reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 5 {
                return attempt.error("too many redirects (max 5)");
            }
            let host = attempt.url().host_str().map(normalize_host).unwrap_or_default();
            if host == origin || approved.contains(&host) || is_loopback_literal(&host) {
                attempt.follow()
            } else {
                attempt.error(format!("redirect to unapproved host {host} blocked"))
            }
        })
    } else {
        reqwest::redirect::Policy::none()
    };
    let mut b = reqwest::Client::builder()
        .pool_max_idle_per_host(load.concurrency as usize)
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_nodelay(true)
        .user_agent(concat!("toad/", env!("CARGO_PKG_VERSION")))
        .danger_accept_invalid_certs(load.allow_invalid_certs)
        .redirect(redirect);
    if let Some(p) = &opts.pinned {
        if p.host.parse::<IpAddr>().is_err() {
            b = b.resolve_to_addrs(&p.host, &p.addrs);
        }
    }
    b.build().map_err(|e| EngineError::Client(e.to_string()))
}

fn build_request(client: &reqwest::Client, spec: &RequestSpec, timeout: Duration) -> Result<reqwest::Request, EngineError> {
    let method = reqwest::Method::from_bytes(spec.method.as_str().as_bytes()).expect("static method");
    let mut rb = client.request(method, spec.url.trim()).timeout(timeout);
    let (mut has_ct, mut has_auth) = (false, false);
    for h in spec.headers.iter().filter(|h| h.enabled && !h.name.trim().is_empty()) {
        let name = h.name.trim();
        has_ct |= name.eq_ignore_ascii_case("content-type");
        has_auth |= name.eq_ignore_ascii_case("authorization");
        rb = rb.header(name, &h.value);
    }
    // An explicit Authorization header wins over the bearer field.
    if let Some(token) = spec.bearer.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        if !has_auth {
            rb = rb.bearer_auth(token);
        }
    }
    if let Some(body) = spec.body.as_ref().filter(|b| !b.content.is_empty()) {
        if body.kind == BodyKind::Json && !has_ct {
            rb = rb.header(reqwest::header::CONTENT_TYPE, "application/json");
        }
        rb = rb.body(body.content.clone().into_bytes());
    }
    rb.build().map_err(|e| EngineError::Client(e.to_string()))
}

/// Walk an error's source chain, looking inside `io::Error` wrappers too.
fn chain_any(err: &(dyn StdError + 'static), f: &dyn Fn(&(dyn StdError + 'static)) -> bool) -> bool {
    let mut cur = Some(err);
    while let Some(e) = cur {
        if f(e) {
            return true;
        }
        if let Some(inner) = e.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            if chain_any(inner, f) {
                return true;
            }
        }
        cur = e.source();
    }
    false
}

fn is_fd_exhaustion(e: &(dyn StdError + 'static)) -> bool {
    e.downcast_ref::<std::io::Error>()
        .and_then(std::io::Error::raw_os_error)
        // EMFILE / ENFILE on Unix, WSAEMFILE on Windows.
        .is_some_and(|code| if cfg!(windows) { code == 10024 } else { code == 24 || code == 23 })
}

/// Map a reqwest error onto Toad's error taxonomy. Returns (kind, fd_exhausted).
pub fn classify(err: &reqwest::Error) -> (ErrorKind, bool) {
    let fd = chain_any(err, &is_fd_exhaustion);
    let kind = if err.is_timeout() {
        ErrorKind::Timeout
    } else if err.is_dns() {
        ErrorKind::Dns
    } else if chain_any(err, &|e| e.is::<rustls::Error>()) {
        ErrorKind::Tls
    } else if err.is_connect() {
        ErrorKind::Connect
    } else if err.is_redirect() {
        ErrorKind::Redirect
    } else if err.is_body() || err.is_decode() {
        ErrorKind::BodyRead
    } else {
        ErrorKind::Other
    };
    (kind, fd)
}

struct Ctx {
    client: reqwest::Client,
    template: reqwest::Request,
    dispatcher: Dispatcher,
    shards: Shards,
    success: StatusRange,
    concurrency: u32,
    ramp_up_secs: Option<u32>,
    capped: bool,
    /// No new requests (stop, deadline, or budget reached).
    halt: CancellationToken,
    /// Abort in-flight requests (grace period over).
    abort: CancellationToken,
    /// A worker found the request budget/duration exhausted.
    exhausted: CancellationToken,
    in_flight: AtomicU64,
    active: AtomicU32,
}

async fn execute(ctx: &Ctx, req: reqwest::Request, scheduled: Option<Instant>) -> Outcome {
    let start = Instant::now();
    let intended = scheduled.map_or(start, |s| s.min(start));
    let mut resp = match ctx.client.execute(req).await {
        Ok(r) => r,
        Err(e) => {
            let (kind, fd_exhausted) = classify(&e);
            return Outcome::Error { kind, status: None, bytes: 0, fd_exhausted };
        }
    };
    let ttfb = start.elapsed();
    let status = resp.status().as_u16();
    // Always drain the body so the connection goes back to the pool.
    let mut bytes = 0u64;
    loop {
        match resp.chunk().await {
            Ok(Some(c)) => bytes += c.len() as u64,
            Ok(None) => break,
            Err(e) => {
                let (kind, fd_exhausted) = classify(&e);
                let kind = if kind == ErrorKind::Timeout { kind } else { ErrorKind::BodyRead };
                return Outcome::Error { kind, status: Some(status), bytes, fd_exhausted };
            }
        }
    }
    let end = Instant::now();
    Outcome::Response {
        status,
        success: (ctx.success.min..=ctx.success.max).contains(&status),
        corrected_us: (end - intended).as_micros() as u64,
        raw_us: (end - start).as_micros() as u64,
        ttfb_us: ttfb.as_micros() as u64,
        bytes,
    }
}

async fn worker(id: u32, ctx: Arc<Ctx>) {
    if !ctx.capped {
        let offset = worker_start_offset(id, ctx.concurrency, ctx.ramp_up_secs);
        if !offset.is_zero() {
            tokio::select! {
                biased;
                _ = ctx.halt.cancelled() => return,
                _ = sleep(offset) => {}
            }
        }
    }
    ctx.active.fetch_add(1, Ordering::Relaxed);
    loop {
        if ctx.halt.is_cancelled() {
            break;
        }
        let Some(ticket) = ctx.dispatcher.next() else {
            ctx.exhausted.cancel();
            break;
        };
        if let Some(at) = ticket.scheduled {
            if at > Instant::now() {
                tokio::select! {
                    biased;
                    _ = ctx.halt.cancelled() => break,
                    _ = sleep_until(at) => {}
                }
            }
        }
        let req = ctx.template.try_clone().expect("request body is cloneable");
        ctx.in_flight.fetch_add(1, Ordering::Relaxed);
        let outcome = tokio::select! {
            biased;
            _ = ctx.abort.cancelled() => None,
            o = execute(&ctx, req, ticket.scheduled) => Some(o),
        };
        ctx.in_flight.fetch_sub(1, Ordering::Relaxed);
        match outcome {
            Some(o) => ctx.shards.record(id as usize, o),
            None => {
                ctx.shards.record(id as usize, Outcome::Cancelled);
                break;
            }
        }
    }
    ctx.active.fetch_sub(1, Ordering::Relaxed);
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum HaltCause {
    User,
    Natural,
}

fn push_unique(v: &mut Vec<Warning>, w: Warning) {
    if !v.contains(&w) {
        v.push(w);
    }
}

/// Run a load test to completion. `on_snapshot` is called every `opts.tick` and once
/// more with the final state. Pre-flight problems (invalid config, client build) are
/// returned as errors; everything after the first request is reported in the summary.
pub async fn run<F>(config: TestConfig, opts: RunOptions, stop: CancellationToken, mut on_snapshot: F) -> Result<RunSummary, EngineError>
where
    F: FnMut(Snapshot) + Send,
{
    let errors = config.validate(opts.limits);
    if !errors.is_empty() {
        return Err(EngineError::Invalid(errors));
    }
    let load = config.load.clone();
    let origin_host = crate::safety::url_host(&config.request.url)
        .map(|(h, _)| h)
        .map_err(|e| EngineError::Invalid(vec![FieldError { field: "request.url".into(), message: e.to_string() }]))?;
    let client = build_client(&load, &origin_host, &opts)?;
    let template = build_request(&client, &config.request, Duration::from_millis(u64::from(load.timeout_ms)))?;

    let (max_requests, duration) = match load.stop {
        StopCondition::Requests { count } => (Some(count), None),
        StopCondition::Duration { secs } => (None, Some(Duration::from_secs(u64::from(secs)))),
    };
    let schedule = load.rps_cap.map(|r| Schedule::new(r, load.ramp_up_secs));
    let started_at = now_ms();
    let start = Instant::now();
    let ctx = Arc::new(Ctx {
        client,
        template,
        dispatcher: Dispatcher::new(start, max_requests, duration, schedule),
        shards: Shards::new(shard_count(load.concurrency), load.timeout_ms),
        success: load.success_range.clone(),
        concurrency: load.concurrency,
        ramp_up_secs: load.ramp_up_secs,
        capped: schedule.is_some(),
        halt: CancellationToken::new(),
        abort: CancellationToken::new(),
        exhausted: CancellationToken::new(),
        in_flight: AtomicU64::new(0),
        active: AtomicU32::new(0),
    });

    let mut workers = JoinSet::new();
    for id in 0..load.concurrency {
        workers.spawn(worker(id, ctx.clone()));
    }

    let far_future = start + Duration::from_secs(10 * 365 * 24 * 3600);
    let deadline = ctx.dispatcher.deadline().unwrap_or(far_future);
    let ramp = f64::from(load.ramp_up_secs.unwrap_or(0));
    let mut ticker = tokio::time::interval_at(start + opts.tick, opts.tick);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut agg = Aggregator::new(load.timeout_ms);
    let mut detector = BottleneckDetector::default();
    let mut halted: Option<HaltCause> = None;
    let mut grace_at = far_future;
    let mut aborted = false;
    let mut panic_msg: Option<String> = None;
    let mut last_tick = start;
    let mut last_second = start;
    let mut next_second: u32 = 1;
    let mut detector_warning: Option<Warning> = None;
    let mut lag_until: Option<Instant> = None;
    let mut seen: Vec<Warning> = Vec::new();

    let halt = |cause: HaltCause, halted: &mut Option<HaltCause>, grace_at: &mut Instant| {
        ctx.halt.cancel();
        *halted = Some(cause);
        *grace_at = Instant::now() + opts.drain_grace;
    };

    loop {
        tokio::select! {
            biased;
            joined = workers.join_next() => match joined {
                None => break,
                Some(Err(e)) if e.is_panic() => {
                    panic_msg.get_or_insert_with(|| format!("worker panicked: {e}"));
                    halt(HaltCause::Natural, &mut halted, &mut grace_at);
                }
                Some(_) => {}
            },
            _ = stop.cancelled(), if halted.is_none() => halt(HaltCause::User, &mut halted, &mut grace_at),
            _ = ctx.exhausted.cancelled(), if halted.is_none() => halt(HaltCause::Natural, &mut halted, &mut grace_at),
            _ = sleep_until(deadline), if halted.is_none() => halt(HaltCause::Natural, &mut halted, &mut grace_at),
            _ = sleep_until(grace_at), if halted.is_some() && !aborted => {
                ctx.abort.cancel();
                aborted = true;
            }
            due = ticker.tick() => {
                let now = Instant::now();
                if now.duration_since(due) > Duration::from_millis(50) {
                    lag_until = Some(now + Duration::from_secs(2));
                    push_unique(&mut seen, Warning::SchedulerLag);
                }
                agg.collect(&ctx.shards);
                let t = now.duration_since(start).as_secs_f64();
                let phase = if halted.is_some() {
                    Phase::Stopping
                } else if t < ramp {
                    Phase::Ramping
                } else {
                    Phase::Running
                };
                let mut second = None;
                if t >= f64::from(next_second) {
                    let point = agg.close_second(next_second, now.duration_since(last_second).as_secs_f64());
                    last_second = now;
                    next_second += 1;
                    detector_warning = match (&phase, schedule) {
                        // Skip the first steady second after ramp: it mixes ramp traffic.
                        (Phase::Running, Some(s)) if t >= ramp + 2.0 => {
                            detector.observe(&point, s.rate_at(t - 0.5), load.concurrency)
                        }
                        _ => None,
                    };
                    if let Some(w) = &detector_warning {
                        push_unique(&mut seen, w.clone());
                    }
                    second = Some(point);
                }
                if agg.interval_counts.fd_exhausted {
                    push_unique(&mut seen, Warning::FdLimit);
                }
                let mut warnings = Vec::new();
                if seen.contains(&Warning::FdLimit) {
                    warnings.push(Warning::FdLimit);
                }
                if lag_until.is_some_and(|u| now < u) {
                    warnings.push(Warning::SchedulerLag);
                }
                warnings.extend(detector_warning.clone());
                let elapsed = now.duration_since(last_tick).as_secs_f64().max(1e-3);
                last_tick = now;
                on_snapshot(snapshot(&opts.run_id, &ctx, &agg, t, phase, elapsed, schedule.filter(|_| halted.is_none()), second, warnings));
            }
        }
    }

    // Final drain of whatever the workers recorded since the last tick.
    let end = Instant::now();
    agg.collect(&ctx.shards);
    let t = end.duration_since(start).as_secs_f64();
    let mut final_second = None;
    if agg.second_has_data() {
        final_second = agg.close_tail(next_second, end.duration_since(last_second).as_secs_f64());
    }
    let failed = panic_msg.is_some();
    let phase = if failed { Phase::Failed } else { Phase::Done };
    let elapsed = end.duration_since(last_tick).as_secs_f64().max(1e-3);
    on_snapshot(snapshot(&opts.run_id, &ctx, &agg, t, phase, elapsed, None, final_second, seen.clone()));

    let c = &agg.cumulative_counts;
    let duration_ms = (t * 1000.0).round() as u64;
    Ok(RunSummary {
        run_id: opts.run_id.clone(),
        config,
        started_at,
        ended_at: now_ms(),
        end_reason: match (failed, halted) {
            (true, _) => EndReason::Failed,
            (false, Some(HaltCause::User)) => EndReason::Stopped,
            _ => EndReason::Completed,
        },
        error: panic_msg,
        totals: Totals {
            total: c.completed(),
            ok: c.ok,
            failed: c.failed,
            cancelled: c.cancelled,
            status_counts: c.status_counts(),
            error_counts: c.error_counts(),
        },
        latency_corrected: percentiles(&agg.cumulative.corrected),
        latency_raw: percentiles(&agg.cumulative.raw),
        ttfb: percentiles(&agg.cumulative.ttfb),
        duration_ms,
        achieved_rps: if t > 0.0 { c.completed() as f64 / t } else { 0.0 },
        bytes: c.bytes,
        capped: schedule.is_some(),
        warnings: seen,
        series: std::mem::take(&mut agg.series),
    })
}

#[allow(clippy::too_many_arguments)]
fn snapshot(
    run_id: &str,
    ctx: &Ctx,
    agg: &Aggregator,
    t: f64,
    phase: Phase,
    interval_s: f64,
    schedule: Option<Schedule>,
    second: Option<SecondPoint>,
    warnings: Vec<Warning>,
) -> Snapshot {
    let c = &agg.cumulative_counts;
    let active = if ctx.capped || matches!(phase, Phase::Stopping | Phase::Done | Phase::Failed) {
        ctx.active.load(Ordering::Relaxed)
    } else {
        active_workers_at(t, ctx.concurrency, ctx.ramp_up_secs).min(ctx.active.load(Ordering::Relaxed).max(1))
    };
    Snapshot {
        run_id: run_id.to_string(),
        t_ms: (t * 1000.0).round() as u64,
        phase,
        total: c.completed(),
        ok: c.ok,
        failed: c.failed,
        cancelled: c.cancelled,
        in_flight: ctx.in_flight.load(Ordering::Relaxed),
        active_workers: active,
        bytes: c.bytes,
        rps_interval: agg.interval_counts.completed() as f64 / interval_s,
        target_rps: schedule.map(|s| s.rate_at(t)),
        lat_interval: percentiles(&agg.interval.corrected),
        lat_interval_raw: percentiles(&agg.interval.raw),
        lat_cumulative: percentiles(&agg.cumulative.corrected),
        lat_cumulative_raw: percentiles(&agg.cumulative.raw),
        status_counts: c.status_counts(),
        error_counts: c.error_counts(),
        second,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fd_exhaustion_detection() {
        let code = if cfg!(windows) { 10024 } else { 24 };
        let e = std::io::Error::from_raw_os_error(code);
        assert!(chain_any(&e, &is_fd_exhaustion));
        let wrapped = std::io::Error::other(std::io::Error::from_raw_os_error(code));
        assert!(chain_any(&wrapped, &is_fd_exhaustion));
        assert!(!chain_any(&std::io::Error::other("x"), &is_fd_exhaustion));
    }

    #[test]
    fn redirect_host_rules() {
        assert!(is_loopback_literal("localhost"));
        assert!(is_loopback_literal("127.0.0.2"));
        assert!(is_loopback_literal(&normalize_host("[::1]")));
        assert!(!is_loopback_literal("example.com"));
    }

    #[test]
    fn request_template_sets_json_content_type_and_bearer() {
        let client = reqwest::Client::new();
        let spec = RequestSpec {
            method: Method::Post,
            url: "http://localhost/x".into(),
            headers: vec![Header { name: "X-A".into(), value: "1".into(), enabled: true },
                          Header { name: "X-Off".into(), value: "1".into(), enabled: false }],
            body: Some(Body { kind: BodyKind::Json, content: "{}".into() }),
            bearer: Some("tok".into()),
        };
        let r = build_request(&client, &spec, Duration::from_secs(1)).unwrap();
        assert_eq!(r.headers()["content-type"], "application/json");
        assert_eq!(r.headers()["authorization"], "Bearer tok");
        assert_eq!(r.headers()["x-a"], "1");
        assert!(r.headers().get("x-off").is_none());
        assert!(r.try_clone().is_some());

        let mut spec2 = spec.clone();
        spec2.headers.push(Header { name: "Content-Type".into(), value: "application/vnd+json".into(), enabled: true });
        spec2.headers.push(Header { name: "Authorization".into(), value: "Basic x".into(), enabled: true });
        let r = build_request(&client, &spec2, Duration::from_secs(1)).unwrap();
        assert_eq!(r.headers()["content-type"], "application/vnd+json");
        assert_eq!(r.headers().get_all("authorization").iter().count(), 1);
        assert_eq!(r.headers()["authorization"], "Basic x");
    }
}
