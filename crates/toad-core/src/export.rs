//! Run export as JSON (full summary) or CSV (summary block + per-second series).

use crate::models::{ErrorKind, ExportFormat, Percentiles, RunSummary};
use std::fmt::Write;

pub fn export(summary: &RunSummary, format: ExportFormat, strip_secrets: bool) -> String {
    let mut s = summary.clone();
    if strip_secrets {
        s.config = s.config.redacted();
    }
    match format {
        ExportFormat::Json => serde_json::to_string_pretty(&s).expect("summary serializes"),
        ExportFormat::Csv => to_csv(&s),
    }
}

fn csv_field(v: &str) -> String {
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

fn enum_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn to_csv(s: &RunSummary) -> String {
    let mut rows: Vec<(String, String)> = vec![
        ("run_id".into(), s.run_id.clone()),
        ("test_name".into(), s.config.name.clone()),
        ("scenarios".into(), s.config.enabled_scenarios().map(|x| x.name.clone()).collect::<Vec<_>>().join(" | ")),
        ("environment".into(), s.env.environment.clone()),
        ("open_model".into(), s.capped.to_string()),
        ("started_at_ms".into(), s.started_at.to_string()),
        ("ended_at_ms".into(), s.ended_at.to_string()),
        ("end_reason".into(), enum_str(&s.end_reason)),
        ("duration_ms".into(), s.duration_ms.to_string()),
        ("total".into(), s.totals.total.to_string()),
        ("ok".into(), s.totals.ok.to_string()),
        ("failed".into(), s.totals.failed.to_string()),
        ("cancelled".into(), s.totals.cancelled.to_string()),
        ("achieved_rps".into(), format!("{:.2}", s.achieved_rps)),
        ("bytes".into(), s.bytes.to_string()),
    ];
    let mut lat = |prefix: &str, p: &Percentiles| {
        for (k, v) in [
            ("min", p.min), ("mean", p.mean), ("p50", p.p50), ("p90", p.p90),
            ("p95", p.p95), ("p99", p.p99), ("max", p.max),
        ] {
            rows.push((format!("{prefix}_{k}_us"), v.to_string()));
        }
    };
    lat("latency_corrected", &s.latency_corrected);
    lat("latency_raw", &s.latency_raw);
    lat("ttfb", &s.ttfb);
    for c in &s.totals.status_counts {
        rows.push((format!("status_{}", c.code), c.count.to_string()));
    }
    for e in &s.totals.error_counts {
        let kind: ErrorKind = e.kind;
        rows.push((format!("error_{}", enum_str(&kind)), e.count.to_string()));
    }

    for v in &s.verdict {
        rows.push((format!("threshold {}", v.label), if v.pending { "pending".into() } else if v.passed { "pass".into() } else { "fail".into() }));
    }
    for (k, v) in [
        ("skipped", s.outcomes.skipped), ("not_taken", s.outcomes.not_taken), ("blocked", s.outcomes.blocked),
        ("build_errors", s.outcomes.build_errors), ("dropped", s.outcomes.dropped), ("check_failures", s.outcomes.check_failures),
        ("iterations", s.outcomes.iterations),
    ] {
        rows.push((k.into(), v.to_string()));
    }

    let mut out = String::from("metric,value\n");
    for (k, v) in rows {
        let _ = writeln!(out, "{},{}", k, csv_field(&v));
    }
    if !s.endpoints.is_empty() {
        out.push('\n');
        out.push_str("step_id,step,phase,method,url,requests,ok,failed,skipped,not_taken,blocked,check_failures,p50_us,p90_us,p95_us,p99_us,max_us,ttfb_p50_us,bytes\n");
        for e in &s.endpoints {
            let _ = writeln!(
                out,
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                csv_field(&e.step_id), csv_field(&e.name), enum_str(&e.phase), e.method, csv_field(&e.url),
                e.totals.total, e.totals.ok, e.totals.failed, e.outcomes.skipped, e.outcomes.not_taken, e.outcomes.blocked,
                e.outcomes.check_failures, e.latency.p50, e.latency.p90, e.latency.p95, e.latency.p99, e.latency.max, e.ttfb.p50, e.bytes
            );
        }
    }
    out.push('\n');
    out.push_str("t_s,rps,ok,failed,bytes,p50_us,p95_us,p99_us,raw_p50_us,raw_p95_us,raw_p99_us\n");
    for p in &s.series {
        let _ = writeln!(
            out,
            "{},{:.2},{},{},{},{},{},{},{},{},{}",
            p.t_s, p.rps, p.ok, p.failed, p.bytes, p.p50, p.p95, p.p99, p.raw_p50, p.raw_p95, p.raw_p99
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;
    use crate::spec::*;

    fn summary() -> RunSummary {
        let mut config = TestConfig::blank("t", "http://localhost/");
        config.name = "a, \"quoted\" name".into();
        if let FlowItem::Request { step } = &mut config.scenarios[0].steps[0] {
            step.headers.push(KeyValue { name: "Authorization".into(), value: "Basic abc".into(), enabled: true });
            step.auth = Auth::Bearer { token: "secret-token".into() };
        }
        RunSummary {
            run_id: "r1".into(),
            config,
            started_at: 1,
            ended_at: 2,
            end_reason: EndReason::Completed,
            error: None,
            totals: Totals { total: 2, ok: 1, failed: 1, cancelled: 0,
                status_counts: vec![StatusCount { code: 200, count: 1 }],
                error_counts: vec![ErrorCount { kind: ErrorKind::Timeout, count: 1 }] },
            latency_corrected: Percentiles::default(),
            latency_raw: Percentiles::default(),
            ttfb: Percentiles::default(),
            duration_ms: 1000,
            achieved_rps: 2.0,
            bytes: 10,
            capped: false,
            warnings: vec![],
            series: vec![SecondPoint { t_s: 1, rps: 2.0, ok: 1, failed: 1, bytes: 10, p50: 5, p95: 6, p99: 7, raw_p50: 5, raw_p95: 6, raw_p99: 7, vus: 1, iterations: 2 }],
            outcomes: OutcomeCounts::default(),
            endpoints: vec![EndpointSummary {
                step_id: "r1".into(), name: "GET /".into(), phase: StepPhase::Main, scenario_id: Some("s1".into()), group_id: None,
                method: "GET".into(), url: "http://localhost/".into(), totals: Totals { total: 2, ok: 1, failed: 1, ..Default::default() },
                outcomes: OutcomeCounts::default(), check_failures: vec![], extract_failures: vec![], latency: Percentiles { p50: 5, ..Default::default() },
                latency_raw: Percentiles::default(), ttfb: Percentiles::default(), bytes: 10, spectrum: vec![], series: vec![],
            }],
            scenarios: vec![],
            verdict: vec![ThresholdResult { id: "t".into(), label: "p95 < 300 ms".into(), observed: 6.0, passed: true, crossed_at_ms: None, pending: false }],
            aborted_by: None,
            env: RunEnv::default(),
            samples: SamplesInfo::default(),
            legacy: false,
        }
    }

    #[test]
    fn json_strips_secrets_by_default() {
        let j = export(&summary(), ExportFormat::Json, true);
        assert!(!j.contains("secret-token") && !j.contains("Basic abc"));
        assert!(j.contains(REDACTED));
        let j = export(&summary(), ExportFormat::Json, false);
        assert!(j.contains("secret-token"));
    }

    #[test]
    fn csv_layout() {
        let c = export(&summary(), ExportFormat::Csv, true);
        assert!(c.starts_with("metric,value\nrun_id,r1\ntest_name,\"a, \"\"quoted\"\" name\"\n"), "{c}");
        assert!(c.contains("end_reason,completed\n"));
        assert!(c.contains("status_200,1\n"));
        assert!(c.contains("error_timeout,1\n"));
        assert!(c.contains("threshold p95 < 300 ms,pass\n"));
        assert!(c.contains("\nstep_id,step,phase"));
        assert!(c.contains("r1,GET /,main,GET,http://localhost/,2,1,1,"));
        assert!(c.contains("\n\nt_s,rps,ok,failed"));
        assert!(c.trim_end().ends_with("1,2.00,1,1,10,5,6,7,5,6,7"));
        assert!(!c.contains("secret-token"));
    }
}
