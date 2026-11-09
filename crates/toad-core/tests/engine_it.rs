//! Engine integration tests against the in-process mock server.

mod common;

use common::mock::{spawn, MockConfig};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use toad_core::*;
use tokio_util::sync::CancellationToken;

fn step(id: &str, method: &str, url: String) -> RequestStep {
    RequestStep::new(id, method, url)
}

fn flow(items: Vec<FlowItem>, executor: Executor) -> TestConfig {
    let mut c = TestConfig::blank("t", "http://localhost/");
    c.name = "it".into();
    c.scenarios[0].steps = items;
    c.scenarios[0].executor = executor;
    c
}

fn req(s: RequestStep) -> FlowItem {
    FlowItem::Request { step: s }
}

fn single(url: String, executor: Executor) -> TestConfig {
    flow(vec![req(step("r1", "GET", url))], executor)
}

fn iters(vus: u32, iterations: u64) -> Executor {
    Executor::Iterations { vus, iterations, max_duration_secs: 60 }
}

async fn run_with(cfg: TestConfig, opts: RunOptions, stop: CancellationToken) -> (RunResult, Vec<Snapshot>) {
    let snaps = Arc::new(Mutex::new(Vec::new()));
    let s2 = snaps.clone();
    let result = run(cfg, opts, stop, move |s| s2.lock().unwrap().push(s)).await.expect("run");
    let snaps = std::mem::take(&mut *snaps.lock().unwrap());
    (result, snaps)
}

async fn run_collect(cfg: TestConfig, stop: CancellationToken) -> (RunSummary, Vec<Snapshot>) {
    let (r, s) = run_with(cfg, RunOptions::new("run"), stop).await;
    (r.summary, s)
}

async fn run_once(cfg: TestConfig) -> RunSummary {
    run_collect(cfg, CancellationToken::new()).await.0
}

fn url(addr: SocketAddr, path: &str) -> String {
    format!("http://{addr}{path}")
}

fn errors(s: &RunSummary, kind: ErrorKind) -> u64 {
    s.totals.error_counts.iter().find(|e| e.kind == kind).map_or(0, |e| e.count)
}

fn endpoint<'a>(s: &'a RunSummary, id: &str) -> &'a EndpointSummary {
    s.endpoints.iter().find(|e| e.step_id == id).unwrap_or_else(|| panic!("no endpoint {id}"))
}

fn extractor(id: &str, var: &str, source: ExtractSource, expr: &str, on_missing: OnMissing) -> Extractor {
    Extractor {
        id: id.into(), var: var.into(), source, expr: expr.into(), pick: ExtractPick::First, index: 0,
        default: "fallback".into(), on_missing, secret: false, enabled: true,
    }
}

fn json_body(content: &str) -> Option<BodySpec> {
    Some(BodySpec { kind: BodyKind::Json, content: content.into(), fields: vec![], variables: String::new(), file: None, content_type: String::new(), gzip: false })
}

// ---------- the load model ----------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixed_delay_p50_within_5ms() {
    let addr = spawn(MockConfig { delay_ms: 50, ..Default::default() }).await;
    let s = run_once(single(url(addr, "/"), iters(20, 400))).await;
    assert_eq!(s.totals.ok, 400);
    assert_eq!(s.end_reason, EndReason::Completed);
    let p50_ms = s.latency_raw.p50 as f64 / 1000.0;
    assert!((p50_ms - 50.0).abs() <= 5.0, "raw p50 = {p50_ms} ms");
    assert!((s.latency_corrected.p50 as f64 / 1000.0 - p50_ms).abs() < 1.0, "closed model: corrected = raw");
    assert!(s.ttfb.p50 <= s.latency_raw.p50);
    assert_eq!(s.bytes, 400 * 64);
    assert_eq!(s.outcomes.iterations, 400);
    assert_eq!(endpoint(&s, "r1").totals.ok, 400);
    assert!(!s.capped);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn error_rate_10_percent_within_2_points() {
    let addr = spawn(MockConfig { error_rate: 0.10, ..Default::default() }).await;
    let s = run_once(single(url(addr, "/"), iters(50, 5000))).await;
    assert_eq!(s.totals.total, 5000);
    let rate = s.totals.failed as f64 / s.totals.total as f64;
    assert!((rate - 0.10).abs() <= 0.02, "error rate = {rate}");
    assert_eq!(errors(&s, ErrorKind::Status), s.totals.failed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_waits_grace_then_cancels_in_flight() {
    let addr = spawn(MockConfig { delay_ms: 10_000, ..Default::default() }).await;
    let mut c = single(url(addr, "/"), Executor::Vus { vus: 8, duration_secs: 60 });
    c.defaults.timeout_ms = 30_000;
    let stop = CancellationToken::new();
    let s2 = stop.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        s2.cancel();
    });
    let t0 = Instant::now();
    let (s, snaps) = run_collect(c, stop).await;
    let took = t0.elapsed();
    assert!(took >= Duration::from_millis(2200) && took < Duration::from_millis(3800), "took {took:?}");
    assert_eq!(s.end_reason, EndReason::Stopped);
    assert_eq!(s.totals.cancelled, 8);
    assert_eq!(s.totals.failed, 0, "cancelled requests are not errors");
    assert!(snaps.iter().any(|s| s.phase == Phase::Stopping));
    assert_eq!(snaps.last().unwrap().phase, Phase::Done);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_keeps_partial_results() {
    let addr = spawn(MockConfig { delay_ms: 5, ..Default::default() }).await;
    let stop = CancellationToken::new();
    let s2 = stop.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        s2.cancel();
    });
    let (s, _) = run_collect(single(url(addr, "/"), Executor::Vus { vus: 10, duration_secs: 60 }), stop).await;
    assert_eq!(s.end_reason, EndReason::Stopped);
    assert!(s.totals.ok > 100, "{}", s.totals.ok);
    assert_eq!(s.totals.cancelled, 0, "fast requests finish within the grace period");
    assert!(s.duration_ms < 1500);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn arrival_rate_within_5_percent() {
    let addr = spawn(MockConfig::default()).await;
    let s = run_once(single(url(addr, "/"), Executor::Rate { rate: 500, rate_unit: RateUnit::Second, duration_secs: 3, max_vus: 20 })).await;
    assert!(s.capped);
    let total = s.totals.total as f64;
    assert!((total - 1500.0).abs() / 1500.0 <= 0.05, "total = {total}");
    assert_eq!(s.outcomes.dropped, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn coordinated_omission_is_corrected() {
    // 2 virtual users × 50 ms can start at most ~40 iterations/s; asking for 200/s builds a backlog.
    let addr = spawn(MockConfig { delay_ms: 50, ..Default::default() }).await;
    let s = run_once(single(url(addr, "/"), Executor::Rate { rate: 200, rate_unit: RateUnit::Second, duration_secs: 4, max_vus: 2 })).await;
    let raw = s.latency_raw.p99;
    let corrected = s.latency_corrected.p99;
    assert!(raw < 70_000, "raw p99 {raw}");
    assert!(corrected > raw * 5, "corrected p99 {corrected} vs raw {raw}");
    assert!(s.warnings.iter().any(|w| matches!(w, Warning::ConcurrencyTooLow { .. })), "{:?}", s.warnings);
    // Iterations still queued at the end are reported, not hidden.
    assert!(s.outcomes.dropped > 400, "dropped {}", s.outcomes.dropped);
    assert!(s.warnings.iter().any(|w| matches!(w, Warning::DroppedIterations { .. })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ramping_vus_follow_the_profile() {
    let addr = spawn(MockConfig { delay_ms: 5, ..Default::default() }).await;
    let exec = Executor::RampingVus { start: 1, stages: vec![Stage { duration_secs: 2, target: 20 }, Stage { duration_secs: 1, target: 20 }] };
    let (s, snaps) = run_collect(single(url(addr, "/"), exec), CancellationToken::new()).await;
    assert!(snaps.iter().any(|s| s.phase == Phase::Ramping));
    let early = s.series.first().unwrap().vus;
    let peak = s.series.iter().map(|p| p.vus).max().unwrap();
    assert!(early < peak && peak >= 15, "vus {early} → {peak}");
    assert_eq!(s.scenarios[0].peak_vus, 20);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scenarios_run_concurrently() {
    let addr = spawn(MockConfig { delay_ms: 2, ..Default::default() }).await;
    let mut c = single(url(addr, "/"), iters(4, 100));
    let mut b = Scenario::new("s2", "Browse");
    b.steps.push(req(step("b1", "GET", url(addr, "/echo"))));
    b.executor = iters(2, 50);
    c.scenarios.push(b);
    let s = run_once(c).await;
    assert_eq!(s.scenarios.len(), 2);
    assert_eq!(endpoint(&s, "r1").totals.ok, 100);
    assert_eq!(endpoint(&s, "b1").totals.ok, 50);
    assert_eq!(s.totals.ok, 150);
}

// ---------- errors ----------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeouts_are_classified() {
    let addr = spawn(MockConfig { delay_ms: 500, ..Default::default() }).await;
    let mut c = single(url(addr, "/"), iters(4, 8));
    c.defaults.timeout_ms = 100;
    let s = run_once(c).await;
    assert_eq!(errors(&s, ErrorKind::Timeout), 8);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connect_dns_tls_errors_are_classified() {
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let s = run_once(single(url(free, "/"), iters(2, 4))).await;
    assert_eq!(errors(&s, ErrorKind::Connect), 4, "{:?}", s.totals.error_counts);

    let s = run_once(single("http://toad-nope.invalid/".into(), iters(1, 2))).await;
    assert_eq!(errors(&s, ErrorKind::Dns), 2, "{:?}", s.totals.error_counts);

    let addr = spawn(MockConfig::default()).await;
    let s = run_once(single(format!("https://{addr}/"), iters(1, 2))).await;
    assert_eq!(errors(&s, ErrorKind::Tls), 2, "{:?}", s.totals.error_counts);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_and_redirect_handling() {
    let addr = spawn(MockConfig::default()).await;
    let s = run_once(single(url(addr, "/status/404"), iters(2, 10))).await;
    assert_eq!(s.totals.failed, 10);
    assert_eq!(s.totals.status_counts, vec![StatusCount { code: 404, count: 10 }]);

    let s = run_once(single(url(addr, "/redirect/3"), iters(2, 10))).await;
    assert_eq!(s.totals.ok, 10);
    assert_eq!(s.totals.status_counts, vec![StatusCount { code: 200, count: 10 }]);

    let s = run_once(single(url(addr, "/redirect/8"), iters(2, 4))).await;
    assert_eq!(errors(&s, ErrorKind::Redirect), 4, "{:?}", s.totals.error_counts);

    let mut c = single(url(addr, "/redirect/3"), iters(2, 4));
    c.defaults.follow_redirects = false;
    let s = run_once(c).await;
    assert_eq!(s.totals.status_counts, vec![StatusCount { code: 302, count: 4 }]);
    assert_eq!(s.totals.ok, 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unconfirmed_hosts_are_blocked_not_sent() {
    let s = run_once(single("http://10.255.255.1/".into(), iters(1, 3))).await;
    assert_eq!(s.outcomes.blocked, 3);
    assert_eq!(s.totals.total, 0, "nothing was sent");
    // A host from a variable is checked at runtime too.
    let mut c = single("http://{{target}}/".into(), iters(1, 2));
    c.variables.push(Variable { name: "target".into(), secret: false, values: [(String::new(), "192.0.2.1".into())].into() });
    let s = run_once(c).await;
    assert_eq!(s.outcomes.blocked, 2);
}

// ---------- flows ----------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn flow_extracts_chains_and_keeps_cookies() {
    let addr = spawn(MockConfig::default()).await;
    let mut login = step("login", "POST", url(addr, "/login"));
    login.body = json_body(r#"{"user": "ada{{vu.id}}"}"#);
    let mut tok = extractor("e1", "token", ExtractSource::Json, "$.token", OnMissing::SkipIteration);
    tok.secret = true;
    login.extract.push(tok);
    let mut orders = step("orders", "GET", url(addr, "/orders"));
    orders.auth = Auth::Bearer { token: "{{token}}".into() };
    orders.checks.push(Check { id: "c1".into(), kind: CheckKind::Json, expr: "$.count".into(), op: CheckOp::Equals, value: "2".into(), fails_request: true, enabled: true });
    orders.extract.push(extractor("e2", "firstOrder", ExtractSource::Json, "$.orders[0].id", OnMissing::FailStep));
    let me = step("me", "GET", url(addr, "/me"));
    let mut c = flow(vec![req(login), req(orders), req(me)], iters(2, 10));
    let s = run_once(c.clone()).await;
    for id in ["login", "orders", "me"] {
        let e = endpoint(&s, id);
        assert_eq!((e.totals.ok, e.totals.failed), (10, 0), "{id}: {:?}", e.totals);
    }
    assert_eq!(s.outcomes.iterations, 10);

    // Without a cookie jar the session cookie never comes back.
    c.cookies.mode = JarMode::Off;
    let s = run_once(c).await;
    assert_eq!(endpoint(&s, "me").totals.status_counts, vec![StatusCount { code: 401, count: 10 }]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_extraction_skips_the_rest_of_the_iteration() {
    let addr = spawn(MockConfig::default()).await;
    let mut a = step("a", "GET", url(addr, "/echo"));
    a.extract.push(extractor("x", "missing", ExtractSource::Json, "$.nope", OnMissing::SkipIteration));
    let b = step("b", "GET", url(addr, "/echo?v={{missing}}"));
    let s = run_once(flow(vec![req(a), req(b)], iters(1, 5))).await;
    assert_eq!(endpoint(&s, "a").totals.ok, 5);
    assert_eq!(endpoint(&s, "a").outcomes.extract_failures, 5);
    assert_eq!(endpoint(&s, "b").totals.total, 0);
    assert_eq!(endpoint(&s, "b").outcomes.skipped, 5);
    assert_eq!(s.outcomes.iterations_failed, 5);

    // Use a default instead.
    let mut a = step("a", "GET", url(addr, "/echo"));
    a.extract.push(extractor("x", "missing", ExtractSource::Json, "$.nope", OnMissing::UseDefault));
    let mut b = step("b", "GET", url(addr, "/echo?v={{missing}}"));
    b.checks.push(Check { id: "q".into(), kind: CheckKind::Json, expr: "$.query".into(), op: CheckOp::Equals, value: "v=fallback".into(), fails_request: true, enabled: true });
    let s = run_once(flow(vec![req(a), req(b)], iters(1, 3))).await;
    assert_eq!(endpoint(&s, "b").totals.ok, 3, "{:?}", endpoint(&s, "b"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_if_groups_and_pauses() {
    let addr = spawn(MockConfig::default()).await;
    let first = step("first", "GET", url(addr, "/status/404"));
    let mut when404 = step("when404", "GET", url(addr, "/echo"));
    when404.run_if = Some(RunIf { mode: MatchMode::All, clauses: vec![Clause { subject: ClauseSubject::PrevStatus, name: String::new(), op: ClauseOp::Equals, value: "404".into() }] });
    let mut never = step("never", "GET", url(addr, "/echo"));
    never.run_if = Some(RunIf { mode: MatchMode::Any, clauses: vec![Clause { subject: ClauseSubject::Variable, name: "cart".into(), op: ClauseOp::Exists, value: String::new() }] });
    let group = FlowItem::Group {
        group: ParallelGroup { id: "g".into(), name: "assets".into(), steps: vec![step("g1", "GET", url(addr, "/echo")), step("g2", "GET", url(addr, "/xml"))], run_if: None },
    };
    let pause = FlowItem::Pause { pause: Pause { id: "p".into(), think: ThinkTime::Fixed { ms: 10 }, run_if: None } };
    let s = run_once(flow(vec![req(first), req(when404), req(never), group, pause], iters(2, 6))).await;
    assert_eq!(endpoint(&s, "first").totals.failed, 6);
    assert_eq!(endpoint(&s, "when404").totals.ok, 6);
    let n = endpoint(&s, "never");
    assert_eq!((n.totals.total, n.outcomes.not_taken), (0, 6));
    assert_eq!(endpoint(&s, "g1").group_id.as_deref(), Some("g"));
    assert_eq!(endpoint(&s, "g2").totals.ok, 6);
    assert_eq!(s.outcomes.not_taken, 6);
    assert_eq!(s.outcomes.blocked + s.outcomes.skipped, 0);
    let it = &s.scenarios[0].iteration_duration;
    assert!(it.p50 >= 10_000, "iteration includes the pause: {}", it.p50);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mix_spreads_by_weight() {
    let addr = spawn(MockConfig::default()).await;
    let mut a = step("a", "GET", url(addr, "/echo?a"));
    a.weight = 3;
    let b = step("b", "GET", url(addr, "/echo?b"));
    let mut c = flow(vec![req(a), req(b)], iters(4, 2000));
    c.scenarios[0].kind = ScenarioKind::Mix;
    let s = run_once(c).await;
    let (na, nb) = (endpoint(&s, "a").totals.total as f64, endpoint(&s, "b").totals.total as f64);
    assert_eq!(na + nb, 2000.0);
    assert!((na / 2000.0 - 0.75).abs() < 0.05, "a share {}", na / 2000.0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bodies_and_cookies_on_redirects() {
    let addr = spawn(MockConfig::default()).await;
    let body = |kind: BodyKind, content: &str, fields: Vec<FormField>| {
        Some(BodySpec { kind, content: content.into(), fields, variables: r#"{"id": 1}"#.into(), file: None, content_type: String::new(), gzip: false })
    };
    let check = |id: &str, expr: &str, op: CheckOp, value: &str| Check { id: id.into(), kind: CheckKind::Json, expr: expr.into(), op, value: value.into(), fails_request: true, enabled: true };
    let field = |n: &str, v: &str| FormField { name: n.into(), value: v.into(), enabled: true, file: false };
    let mut form = step("form", "POST", url(addr, "/echo"));
    form.body = body(BodyKind::Form, "", vec![field("user", "ada lovelace"), field("n", "{{$seq}}")]);
    form.checks.push(check("ct", "$.headers['content-type']", CheckOp::Equals, "application/x-www-form-urlencoded"));
    form.checks.push(check("b", "$.body", CheckOp::Matches, r"^user=ada\+lovelace&n=\d+$"));
    let mut mp = step("mp", "POST", url(addr, "/echo"));
    mp.body = body(BodyKind::Multipart, "", vec![field("note", "hi")]);
    mp.checks.push(check("ct", "$.headers['content-type']", CheckOp::Contains, "multipart/form-data; boundary="));
    mp.checks.push(check("b", "$.body", CheckOp::Contains, "name=\"note\"\r\n\r\nhi"));
    let mut gql = step("gql", "POST", url(addr, "/echo"));
    gql.body = body(BodyKind::Graphql, "{ me { id } }", vec![]);
    gql.checks.push(check("b", "$.body", CheckOp::Equals, r#"{"query":"{ me { id } }","variables":{"id":1}}"#));
    let mut x = step("xml", "GET", url(addr, "/xml"));
    x.extract.push(extractor("o", "orderId", ExtractSource::Xpath, "/order/@id", OnMissing::FailStep));
    let mut q = step("q", "GET", url(addr, "/echo"));
    q.params.push(KeyValue { name: "order".into(), value: "{{orderId}}".into(), enabled: true });
    q.checks.push(check("q", "$.query", CheckOp::Equals, "order=o-7"));
    let rc = step("rc", "GET", url(addr, "/redirect-cookie"));
    let mut gz = step("gz", "POST", url(addr, "/echo"));
    gz.body = json_body(r#"{"a": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#);
    gz.body.as_mut().unwrap().gzip = true;
    gz.checks.push(check("enc", "$.headers['content-encoding']", CheckOp::Equals, "gzip"));
    let s = run_once(flow([form, mp, gql, x, q, rc, gz].into_iter().map(req).collect(), iters(1, 2))).await;
    for e in &s.endpoints {
        assert_eq!((e.totals.ok, e.outcomes.check_failures), (2, 0), "{}: {:?} {:?}", e.step_id, e.totals, e.check_failures);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn setup_values_reach_every_virtual_user() {
    let addr = spawn(MockConfig::default()).await;
    let mut c = flow(vec![], iters(3, 9));
    let mut login = step("su", "POST", url(addr, "/login"));
    login.body = json_body(r#"{"user": "shared"}"#);
    login.extract.push(extractor("t", "token", ExtractSource::Json, "$.token", OnMissing::FailStep));
    c.setup.push(login);
    let mut o = step("orders", "GET", url(addr, "/orders"));
    o.headers.push(KeyValue { name: "Authorization".into(), value: "Bearer {{token}}".into(), enabled: true });
    c.scenarios[0].steps = vec![req(o)];
    let (s, snaps) = run_collect(c.clone(), CancellationToken::new()).await;
    assert_eq!(endpoint(&s, "orders").totals.ok, 9);
    assert_eq!(endpoint(&s, "su").totals.ok, 1);
    assert_eq!(endpoint(&s, "su").phase, StepPhase::Setup);
    assert_eq!(s.totals.ok, 9, "setup isn't part of the totals");
    assert_eq!(snaps.first().unwrap().phase, Phase::Setup);

    // A failing setup stops the run before any load.
    c.setup[0].url = url(addr, "/status/500");
    let s = run_once(c).await;
    assert_eq!(s.end_reason, EndReason::Failed);
    assert!(s.error.as_deref().unwrap_or_default().contains("failed"), "{:?}", s.error);
    assert_eq!(s.totals.total, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn data_files_feed_rows() {
    let addr = spawn(MockConfig::default()).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("users.csv"), "name,plan\nada,pro\ngrace,free\n").unwrap();
    let mut s1 = step("e", "GET", url(addr, "/echo?u={{users.name}}"));
    s1.extract.push(extractor("q", "seen", ExtractSource::Json, "$.query", OnMissing::FailStep));
    let mut c = flow(vec![req(s1)], iters(1, 4));
    c.data.push(DataFile {
        id: "d".into(), name: "users".into(), file: "users.csv".into(), original_name: "users.csv".into(), format: DataFormat::Csv,
        has_header: true, columns: vec!["name".into(), "plan".into()], secret_columns: vec![], rows: 2,
        distribution: Distribution::Sequential, on_exhausted: OnExhausted::StopRun,
    });
    let opts = RunOptions { asset_dir: Some(dir.path().to_path_buf()), sampling: samples::SamplePolicy { random: 10, ..Default::default() }, ..RunOptions::new("d") };
    let (r, _) = run_with(c, opts, CancellationToken::new()).await;
    let s = &r.summary;
    assert_eq!(endpoint(s, "e").totals.ok, 2, "two rows, then the run stops");
    assert!(s.warnings.iter().any(|w| matches!(w, Warning::DataExhausted { file } if file == "users")), "{:?}", s.warnings);
    assert_eq!(s.env.data_files[0].rows, 2);
    let queries: Vec<String> = r.samples.iter().filter_map(|x| x.response.as_ref()).map(|resp| resp.body.clone()).collect();
    assert!(queries.iter().any(|b| b.contains("u=ada")) && queries.iter().any(|b| b.contains("u=grace")), "{queries:?}");
}

// ---------- thresholds and samples ----------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn thresholds_judge_and_abort() {
    let addr = spawn(MockConfig { delay_ms: 2, ..Default::default() }).await;
    let mut c = single(url(addr, "/status/500"), Executor::Vus { vus: 4, duration_secs: 30 });
    c.thresholds.push(Threshold { id: "err".into(), metric: ThresholdMetric::ErrorRate, scope: String::new(), op: Cmp::Lt, value: 1.0, abort: true, delay_secs: 1, enabled: true });
    c.thresholds.push(Threshold { id: "p95".into(), metric: ThresholdMetric::P95, scope: "step:r1".into(), op: Cmp::Lt, value: 1000.0, abort: false, delay_secs: 0, enabled: true });
    let t0 = Instant::now();
    let s = run_once(c).await;
    assert!(t0.elapsed() < Duration::from_secs(6), "aborted early");
    assert_eq!(s.end_reason, EndReason::Aborted);
    assert_eq!(s.aborted_by.as_deref(), Some("error rate < 1%"));
    let err = s.verdict.iter().find(|v| v.id == "err").unwrap();
    assert!(!err.passed && err.observed > 99.0 && err.crossed_at_ms.is_some());
    let p95 = s.verdict.iter().find(|v| v.id == "p95").unwrap();
    assert!(p95.passed, "{p95:?}");
    assert_eq!(p95.label, "p95 < 1000 ms · GET /status/500");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn samples_keep_failures_and_redact_secrets() {
    let addr = spawn(MockConfig { error_rate: 0.2, ..Default::default() }).await;
    let mut s1 = step("r1", "GET", url(addr, "/"));
    s1.headers.push(KeyValue { name: "X-Api-Key".into(), value: "{{key}}".into(), enabled: true });
    s1.params.push(KeyValue { name: "k".into(), value: "{{key}}".into(), enabled: true });
    let mut c = flow(vec![req(s1)], iters(4, 500));
    c.variables.push(Variable { name: "key".into(), secret: true, values: [(String::new(), "very-secret-key".into())].into() });
    let opts = RunOptions { sampling: samples::SamplePolicy { failures: 20, slowest: 5, random: 10, ..Default::default() }, ..RunOptions::new("s") };
    let (r, _) = run_with(c, opts, CancellationToken::new()).await;
    let failures = r.samples.iter().filter(|x| x.reason == SampleReason::Failure).count();
    assert_eq!(failures, 20);
    assert!(r.summary.samples.truncated);
    assert!(r.samples.iter().any(|x| x.reason == SampleReason::Random));
    let all = serde_json::to_string(&r.samples).unwrap();
    assert!(!all.contains("very-secret-key"), "secret leaked into samples");
    let f = r.samples.iter().find(|x| x.reason == SampleReason::Failure).unwrap();
    assert_eq!(f.response.as_ref().unwrap().status, 500);
    assert_eq!(f.response.as_ref().unwrap().body, "mock error");
    assert_eq!(r.summary.samples.count, r.samples.len() as u64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_once_traces_every_step() {
    let addr = spawn(MockConfig::default()).await;
    let mut login = step("login", "POST", url(addr, "/login"));
    login.body = json_body(r#"{"user": "ada"}"#);
    let mut t = extractor("t", "token", ExtractSource::Json, "$.token", OnMissing::FailStep);
    t.secret = true;
    login.extract.push(t);
    let mut orders = step("orders", "GET", url(addr, "/orders"));
    orders.auth = Auth::Bearer { token: "{{token}}".into() };
    let c = flow(vec![req(login), req(orders)], iters(50, 1000));
    let r = try_flow(&c, &RunOptions::new("try"), None).await.unwrap();
    assert!(r.error.is_none());
    assert_eq!(r.steps.iter().map(|s| s.step_id.as_str()).collect::<Vec<_>>(), ["login", "orders"]);
    assert_eq!(r.steps[1].response.as_ref().unwrap().status, 200);
    assert_eq!(r.steps[1].trace.len(), 1, "the orders sample knows login came first");
    let ex = &r.steps[0].extracted[0];
    assert_eq!((ex.var.as_str(), ex.value.as_deref()), ("token", Some(REDACTED)));
    assert!(r.vars.iter().any(|v| v.name == "token"));

    let one = send_step(&c, &RunOptions::new("send"), "orders", &[KeyValue { name: "token".into(), value: "tok-x".into(), enabled: true }]).await.unwrap();
    assert_eq!(one.steps.len(), 1);
    assert_eq!(one.steps[0].response.as_ref().unwrap().status, 200);
}

// ---------- snapshots and validation ----------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshots_are_small_and_periodic() {
    let addr = spawn(MockConfig { delay_ms: 1, error_rate: 0.05, ..Default::default() }).await;
    let (s, snaps) = run_collect(single(url(addr, "/"), Executor::Vus { vus: 16, duration_secs: 2 }), CancellationToken::new()).await;
    assert!(snaps.len() >= 8 && snaps.len() <= 12, "{} snapshots", snaps.len());
    let biggest = snaps.iter().map(|s| serde_json::to_vec(s).unwrap().len()).max().unwrap();
    assert!(biggest < 10_000, "largest snapshot {biggest} bytes");
    assert_eq!(snaps.iter().filter(|s| s.second.is_some()).count(), s.series.len());
    assert!(s.series.len() >= 2);
    assert_eq!(endpoint(&s, "r1").series.len(), s.series.len());
    let last = snaps.last().unwrap();
    assert_eq!((last.total, last.phase.clone()), (s.totals.total, Phase::Done));
    assert_eq!(last.endpoints.len(), 1);
}

#[tokio::test]
async fn invalid_config_is_rejected_before_running() {
    let mut cfg = single("not a url".into(), Executor::Vus { vus: 0, duration_secs: 1 });
    cfg.name = String::new();
    let err = run(cfg, RunOptions::new("x"), CancellationToken::new(), |_| {}).await.err().expect("invalid");
    let EngineError::Invalid(fields) = err else { panic!("expected Invalid") };
    let names: Vec<_> = fields.iter().map(|f| f.field.as_str()).collect();
    assert!(names.contains(&"name") && names.contains(&"step:r1.url") && names.contains(&"scenario:s1.load"), "{names:?}");
}

/// Perf acceptance: `cargo test --release --test engine_it -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn perf_5k_rps_with_200_workers() {
    let addr = spawn(MockConfig { delay_ms: 20, ..Default::default() }).await;
    let (r, snaps) = run_with(single(url(addr, "/"), Executor::Vus { vus: 200, duration_secs: 10 }), RunOptions::new("perf"), CancellationToken::new()).await;
    for f in r.samples.iter().filter(|x| x.reason == SampleReason::Failure).take(3) {
        println!("failure at {} ms: {:?}", f.t_ms, f.error);
    }
    let s = r.summary;
    let biggest = snaps.iter().map(|s| serde_json::to_vec(s).unwrap().len()).max().unwrap();
    println!(
        "achieved {:.0} rps, ok {}, failed {}, p50 {} µs, p99 {} µs, largest snapshot {} B, warnings {:?}, errors {:?}",
        s.achieved_rps, s.totals.ok, s.totals.failed, s.latency_raw.p50, s.latency_raw.p99, biggest, s.warnings, s.totals.error_counts
    );
    assert!(s.achieved_rps >= 5000.0);
    assert_eq!(s.totals.failed, 0);
}
