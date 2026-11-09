//! Run a load test without the UI, e.g. for smoke tests or CI.
//!
//!   cargo run --release -p toad-core --example headless_run -- config.json \
//!       [--snapshots snapshots.json] [--summary summary.json] [--samples samples.json]
//!
//! `config.json` is a `TestConfig` (the same JSON Toad stores for saved tests).
//! Only loopback targets are allowed here, since there is no confirmation prompt; other
//! hosts count as blocked. Exits 99 when a threshold fails.

use std::sync::{Arc, Mutex};
use toad_core::*;
use tokio_util::sync::CancellationToken;

fn fail(msg: &str) -> ! {
    eprintln!("{msg}\nusage: headless_run <config.json> [--snapshots out.json] [--summary out.json] [--samples out.json]");
    std::process::exit(2)
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let config_path = args.next().unwrap_or_else(|| fail("missing config path"));
    let (mut snaps_out, mut summary_out, mut samples_out) = (None, None, None);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--snapshots" => snaps_out = args.next(),
            "--summary" => summary_out = args.next(),
            "--samples" => samples_out = args.next(),
            _ => fail(&format!("unknown flag {flag}")),
        }
    }
    let raw = std::fs::read_to_string(&config_path).unwrap_or_else(|e| fail(&format!("read {config_path}: {e}")));
    let config: TestConfig = serde_json::from_str(&raw).unwrap_or_else(|e| fail(&format!("parse {config_path}: {e}")));

    // Only loopback targets: nothing is approved, so every other host is blocked by the engine.
    let asset_dir = std::path::Path::new(&config_path).parent().map(|p| p.join(&config.id)).filter(|p| p.is_dir());
    raise_fd_limit();

    let stop = CancellationToken::new();
    let ctrl_c = stop.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        ctrl_c.cancel();
    });

    let snaps = Arc::new(Mutex::new(Vec::new()));
    let sink = snaps.clone();
    let opts = RunOptions { asset_dir, ..RunOptions::new(engine::now_ms().to_string()) };
    let result = run(config, opts, stop, move |s| {
        eprint!("\r{:>6.1}s  {:>8} req  {:>8.0} rps  in-flight {:>4}  {:?}   ",
            s.t_ms as f64 / 1000.0, s.total, s.rps_interval, s.in_flight, s.phase);
        sink.lock().unwrap().push(s);
    })
    .await
    .unwrap_or_else(|e| fail(&e.to_string()));
    let summary = result.summary;
    if let Some(p) = &samples_out {
        std::fs::write(p, serde_json::to_vec(&result.samples).unwrap()).unwrap_or_else(|e| fail(&e.to_string()));
    }
    eprintln!();

    let ms = |us: u64| us as f64 / 1000.0;
    let lat = |name: &str, p: &Percentiles| {
        println!(
            "  {name:<10} min {:>7.2}  mean {:>7.2}  p50 {:>7.2}  p90 {:>7.2}  p95 {:>7.2}  p99 {:>7.2}  max {:>8.2}  (ms)",
            ms(p.min), ms(p.mean), ms(p.p50), ms(p.p90), ms(p.p95), ms(p.p99), ms(p.max)
        );
    };
    let t = &summary.totals;
    println!("run {}  {:?}  {:.2}s", summary.run_id, summary.end_reason, summary.duration_ms as f64 / 1000.0);
    println!("  requests  {} total, {} ok, {} failed ({:.2}%), {} cancelled", t.total, t.ok, t.failed,
        if t.total > 0 { t.failed as f64 * 100.0 / t.total as f64 } else { 0.0 }, t.cancelled);
    println!("  achieved  {:.0} rps, {:.1} MiB received", summary.achieved_rps, summary.bytes as f64 / 1048576.0);
    if summary.capped {
        lat("corrected", &summary.latency_corrected);
    }
    lat(if summary.capped { "raw" } else { "latency" }, &summary.latency_raw);
    lat("ttfb", &summary.ttfb);
    println!("  status    {}", t.status_counts.iter().map(|c| format!("{}×{}", c.code, c.count)).collect::<Vec<_>>().join("  "));
    println!("  errors    {}", if t.error_counts.is_empty() { "none".into() } else {
        t.error_counts.iter().map(|e| format!("{:?}×{}", e.kind, e.count)).collect::<Vec<_>>().join("  ") });
    println!("  warnings  {:?}", summary.warnings);
    let o = &summary.outcomes;
    println!("  outcomes  {} iterations, {} skipped, {} not taken, {} blocked, {} dropped", o.iterations, o.skipped, o.not_taken, o.blocked, o.dropped);
    for e in &summary.endpoints {
        println!("  {:<32} {:>8} req  {:>6} failed  p95 {:>8.2} ms", e.name, e.totals.total, e.totals.failed, ms(e.latency.p95));
    }
    let failed: Vec<_> = summary.verdict.iter().filter(|v| !v.passed).collect();
    for v in &summary.verdict {
        println!("  threshold {:<40} {}", v.label, if v.pending { "pending" } else if v.passed { "pass" } else { "FAIL" });
    }

    let snaps = std::mem::take(&mut *snaps.lock().unwrap());
    let biggest = snaps.iter().map(|s| serde_json::to_vec(s).map_or(0, |v| v.len())).max().unwrap_or(0);
    println!("  snapshots {} (largest {} bytes)", snaps.len(), biggest);
    if let Some(p) = snaps_out {
        std::fs::write(&p, serde_json::to_vec(&snaps).unwrap()).unwrap_or_else(|e| fail(&e.to_string()));
    }
    if let Some(p) = summary_out {
        std::fs::write(&p, serde_json::to_vec_pretty(&summary).unwrap()).unwrap_or_else(|e| fail(&e.to_string()));
    }
    // Exit 99 when a threshold failed, so CI can gate on the verdict.
    if !failed.is_empty() {
        std::process::exit(99);
    }
}
