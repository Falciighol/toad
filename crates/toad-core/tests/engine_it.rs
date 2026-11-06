//! Engine integration tests against the in-process mock server.

mod common;

use common::mock::{spawn, MockConfig};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use toad_core::*;
use tokio_util::sync::CancellationToken;

fn config(url: String, load: LoadSpec) -> TestConfig {
    TestConfig {
        id: "t".into(),
        name: "it".into(),
        request: RequestSpec { method: Method::Get, url, headers: vec![], body: None, bearer: None },
        load,
        created_at: 0,
        updated_at: 0,
    }
}

fn load(concurrency: u32, stop: StopCondition) -> LoadSpec {
    LoadSpec { concurrency, stop, ..LoadSpec::default() }
}

async fn run_collect(cfg: TestConfig, stop: CancellationToken) -> (RunSummary, Vec<Snapshot>) {
    let snaps = Arc::new(Mutex::new(Vec::new()));
    let s2 = snaps.clone();
    let summary = run(cfg, RunOptions::new("run"), stop, move |s| s2.lock().unwrap().push(s))
        .await
        .expect("run");
    let snaps = std::mem::take(&mut *snaps.lock().unwrap());
    (summary, snaps)
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixed_delay_p50_within_5ms() {
    let addr = spawn(MockConfig { delay_ms: 50, ..Default::default() }).await;
    let s = run_once(config(url(addr, "/"), load(20, StopCondition::Requests { count: 400 }))).await;
    assert_eq!(s.totals.ok, 400);
    assert_eq!(s.end_reason, EndReason::Completed);
    let p50_ms = s.latency_raw.p50 as f64 / 1000.0;
    assert!((p50_ms - 50.0).abs() <= 5.0, "raw p50 = {p50_ms} ms");
    // Uncapped: corrected latency equals raw service time.
    assert!((s.latency_corrected.p50 as f64 / 1000.0 - p50_ms).abs() < 1.0);
    assert!(s.ttfb.p50 <= s.latency_raw.p50);
    assert_eq!(s.bytes, 400 * 64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn error_rate_10_percent_within_2_points() {
    let addr = spawn(MockConfig { error_rate: 0.10, ..Default::default() }).await;
    let s = run_once(config(url(addr, "/"), load(50, StopCondition::Requests { count: 5000 }))).await;
    assert_eq!(s.totals.total, 5000);
    let rate = s.totals.failed as f64 / s.totals.total as f64;
    assert!((rate - 0.10).abs() <= 0.02, "error rate = {rate}");
    assert_eq!(errors(&s, ErrorKind::Status), s.totals.failed);
    let c500 = s.totals.status_counts.iter().find(|c| c.code == 500).unwrap().count;
    assert_eq!(c500, s.totals.failed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_waits_grace_then_cancels_in_flight() {
    let addr = spawn(MockConfig { delay_ms: 10_000, ..Default::default() }).await;
    let mut l = load(8, StopCondition::Duration { secs: 60 });
    l.timeout_ms = 30_000;
    let stop = CancellationToken::new();
    let s2 = stop.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        s2.cancel();
    });
    let t0 = Instant::now();
    let (s, snaps) = run_collect(config(url(addr, "/"), l), stop).await;
    let took = t0.elapsed();
    assert!(took >= Duration::from_millis(2200) && took < Duration::from_millis(3500), "took {took:?}");
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
    let (s, _) = run_collect(config(url(addr, "/"), load(10, StopCondition::Duration { secs: 60 })), stop).await;
    assert_eq!(s.end_reason, EndReason::Stopped);
    assert!(s.totals.ok > 100, "{}", s.totals.ok);
    assert_eq!(s.totals.cancelled, 0, "fast requests finish within the grace period");
    assert!(s.duration_ms < 1500);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rps_cap_within_5_percent() {
    let addr = spawn(MockConfig::default()).await;
    let mut l = load(20, StopCondition::Duration { secs: 3 });
    l.rps_cap = Some(500);
    let s = run_once(config(url(addr, "/"), l)).await;
    assert!(s.capped);
    let expected = 1500.0;
    let total = s.totals.total as f64;
    assert!((total - expected).abs() / expected <= 0.05, "total = {total}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn coordinated_omission_is_corrected() {
    // 2 workers × 50 ms can do at most ~40 rps; asking for 200 rps builds a backlog.
    let addr = spawn(MockConfig { delay_ms: 50, ..Default::default() }).await;
    let mut l = load(2, StopCondition::Duration { secs: 4 });
    l.rps_cap = Some(200);
    let s = run_once(config(url(addr, "/"), l)).await;
    let raw = s.latency_raw.p99;
    let corrected = s.latency_corrected.p99;
    assert!(raw < 70_000, "raw p99 {raw}");
    assert!(corrected > raw * 5, "corrected p99 {corrected} vs raw {raw}");
    assert!(s.warnings.iter().any(|w| matches!(w, Warning::ConcurrencyTooLow { .. })), "{:?}", s.warnings);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_count_includes_ramp_up() {
    let addr = spawn(MockConfig { delay_ms: 2, ..Default::default() }).await;
    let mut l = load(10, StopCondition::Requests { count: 300 });
    l.ramp_up_secs = Some(1);
    let (s, snaps) = run_collect(config(url(addr, "/"), l), CancellationToken::new()).await;
    assert_eq!(s.totals.total, 300);
    assert!(snaps.iter().any(|s| s.phase == Phase::Ramping));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeouts_are_classified() {
    let addr = spawn(MockConfig { delay_ms: 500, ..Default::default() }).await;
    let mut l = load(4, StopCondition::Requests { count: 8 });
    l.timeout_ms = 100;
    let s = run_once(config(url(addr, "/"), l)).await;
    assert_eq!(errors(&s, ErrorKind::Timeout), 8);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connect_dns_tls_errors_are_classified() {
    // Connect: a port with nothing listening.
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let s = run_once(config(url(free, "/"), load(2, StopCondition::Requests { count: 4 }))).await;
    assert_eq!(errors(&s, ErrorKind::Connect), 4, "{:?}", s.totals.error_counts);

    // DNS: the .invalid TLD never resolves.
    let s = run_once(config("http://toad-nope.invalid/".into(), load(1, StopCondition::Requests { count: 2 }))).await;
    assert_eq!(errors(&s, ErrorKind::Dns), 2, "{:?}", s.totals.error_counts);

    // TLS: speak HTTPS to a plain-HTTP server.
    let addr = spawn(MockConfig::default()).await;
    let s = run_once(config(format!("https://{addr}/"), load(1, StopCondition::Requests { count: 2 }))).await;
    assert_eq!(errors(&s, ErrorKind::Tls), 2, "{:?}", s.totals.error_counts);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_and_redirect_handling() {
    let addr = spawn(MockConfig::default()).await;
    let s = run_once(config(url(addr, "/status/404"), load(2, StopCondition::Requests { count: 10 }))).await;
    assert_eq!(s.totals.failed, 10);
    assert_eq!(s.totals.status_counts, vec![StatusCount { code: 404, count: 10 }]);

    // Follow 3 redirects to a 200.
    let s = run_once(config(url(addr, "/redirect/3"), load(2, StopCondition::Requests { count: 10 }))).await;
    assert_eq!(s.totals.ok, 10);
    assert_eq!(s.totals.status_counts, vec![StatusCount { code: 200, count: 10 }]);

    // More than 5 redirects is an error.
    let s = run_once(config(url(addr, "/redirect/8"), load(2, StopCondition::Requests { count: 4 }))).await;
    assert_eq!(errors(&s, ErrorKind::Redirect), 4, "{:?}", s.totals.error_counts);

    // Redirects off: the 302 itself is the response (inside the default 200–399 range).
    let mut l = load(2, StopCondition::Requests { count: 4 });
    l.follow_redirects = false;
    let s = run_once(config(url(addr, "/redirect/3"), l)).await;
    assert_eq!(s.totals.status_counts, vec![StatusCount { code: 302, count: 4 }]);
    assert_eq!(s.totals.ok, 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshots_are_small_and_periodic() {
    let addr = spawn(MockConfig { delay_ms: 1, error_rate: 0.05, ..Default::default() }).await;
    let (s, snaps) = run_collect(config(url(addr, "/"), load(16, StopCondition::Duration { secs: 2 })), CancellationToken::new()).await;
    assert!(snaps.len() >= 8 && snaps.len() <= 11, "{} snapshots", snaps.len());
    let biggest = snaps.iter().map(|s| serde_json::to_vec(s).unwrap().len()).max().unwrap();
    assert!(biggest < 10_000, "largest snapshot {biggest} bytes");
    assert_eq!(snaps.iter().filter(|s| s.second.is_some()).count(), s.series.len());
    assert!(s.series.len() >= 2);
    let last = snaps.last().unwrap();
    assert_eq!((last.total, last.phase.clone()), (s.totals.total, Phase::Done));
}

#[tokio::test]
async fn invalid_config_is_rejected_before_running() {
    let mut cfg = config("not a url".into(), load(0, StopCondition::Requests { count: 1 }));
    cfg.name = String::new();
    let err = run(cfg, RunOptions::new("x"), CancellationToken::new(), |_| {}).await.unwrap_err();
    let EngineError::Invalid(fields) = err else { panic!("expected Invalid") };
    let names: Vec<_> = fields.iter().map(|f| f.field.as_str()).collect();
    assert!(names.contains(&"name") && names.contains(&"request.url") && names.contains(&"load.concurrency"));
}

/// Perf acceptance: `cargo test --release --test engine_it -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn perf_5k_rps_with_200_workers() {
    let addr = spawn(MockConfig { delay_ms: 20, ..Default::default() }).await;
    let (s, snaps) = run_collect(config(url(addr, "/"), load(200, StopCondition::Duration { secs: 10 })), CancellationToken::new()).await;
    let biggest = snaps.iter().map(|s| serde_json::to_vec(s).unwrap().len()).max().unwrap();
    println!(
        "achieved {:.0} rps, ok {}, failed {}, p50 {} µs, p99 {} µs, largest snapshot {} B, warnings {:?}",
        s.achieved_rps, s.totals.ok, s.totals.failed, s.latency_raw.p50, s.latency_raw.p99, biggest, s.warnings
    );
    assert!(s.achieved_rps >= 5000.0);
    assert_eq!(s.totals.failed, 0);
}
