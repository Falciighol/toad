//! Shared data model. Every type here is exported to TypeScript (feature `specta`).
//! Durations/latencies are microseconds unless the field name says otherwise.

use serde::{Deserialize, Serialize};

macro_rules! model {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

model! {
    #[serde(rename_all = "UPPERCASE")]
    pub enum Method { Get, Post, Put, Patch, Delete, Head, Options }

    pub struct Header {
        pub name: String,
        pub value: String,
        pub enabled: bool,
    }

    #[serde(rename_all = "snake_case")]
    pub enum BodyKind { Json, Text }

    pub struct Body {
        pub kind: BodyKind,
        pub content: String,
    }

    pub struct RequestSpec {
        pub method: Method,
        pub url: String,
        pub headers: Vec<Header>,
        pub body: Option<Body>,
        /// Stored in plain text. Sent as `Authorization: Bearer <token>`.
        pub bearer: Option<String>,
    }

    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum StopCondition {
        /// Total requests, including those sent during ramp-up.
        Requests { count: u64 },
        Duration { secs: u32 },
    }

    pub struct StatusRange {
        pub min: u16,
        pub max: u16,
    }

    pub struct LoadSpec {
        pub concurrency: u32,
        pub stop: StopCondition,
        pub rps_cap: Option<u32>,
        pub ramp_up_secs: Option<u32>,
        pub timeout_ms: u32,
        pub success_range: StatusRange,
        pub follow_redirects: bool,
        pub allow_invalid_certs: bool,
    }

    pub struct TestConfig {
        pub id: String,
        pub name: String,
        pub request: RequestSpec,
        pub load: LoadSpec,
        /// Epoch milliseconds.
        pub created_at: i64,
        pub updated_at: i64,
    }

    #[serde(rename_all = "snake_case")]
    pub enum Phase { Ramping, Running, Stopping, Done, Failed }

    #[derive(Default)]
    pub struct Percentiles {
        pub min: u64,
        pub mean: u64,
        pub p50: u64,
        pub p90: u64,
        pub p95: u64,
        pub p99: u64,
        pub max: u64,
        /// Number of samples the percentiles were computed from.
        pub count: u64,
    }

    #[derive(Copy, Eq, Hash, PartialOrd, Ord)]
    #[serde(rename_all = "snake_case")]
    pub enum ErrorKind { Timeout, Connect, Dns, Tls, BodyRead, Status, Redirect, Other }

    pub struct StatusCount { pub code: u16, pub count: u64 }

    pub struct ErrorCount { pub kind: ErrorKind, pub count: u64 }

    #[derive(Eq, Hash)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum Warning {
        /// Achieved RPS is well below target while server latency is flat.
        ToadBottleneck,
        /// The OS refused to open more sockets (EMFILE).
        FdLimit,
        /// The async runtime is lagging (aggregator tick late by >50 ms).
        SchedulerLag,
        /// Not a Toad problem: concurrency is too low to reach the RPS target.
        ConcurrencyTooLow { needed: u32 },
    }

    pub struct SecondPoint {
        /// Seconds since run start (1 = the first full second).
        pub t_s: u32,
        pub rps: f64,
        pub ok: u64,
        pub failed: u64,
        pub bytes: u64,
        pub p50: u64,
        pub p95: u64,
        pub p99: u64,
        pub raw_p50: u64,
        pub raw_p95: u64,
        pub raw_p99: u64,
    }

    pub struct Snapshot {
        pub run_id: String,
        pub t_ms: u64,
        pub phase: Phase,
        /// Completed requests (ok + failed). Cancelled requests are counted separately.
        pub total: u64,
        pub ok: u64,
        pub failed: u64,
        pub cancelled: u64,
        pub in_flight: u64,
        pub active_workers: u32,
        pub bytes: u64,
        pub rps_interval: f64,
        pub target_rps: Option<f64>,
        /// Latency measured from the scheduled send time (equal to raw when uncapped).
        pub lat_interval: Percentiles,
        pub lat_interval_raw: Percentiles,
        pub lat_cumulative: Percentiles,
        pub lat_cumulative_raw: Percentiles,
        pub status_counts: Vec<StatusCount>,
        pub error_counts: Vec<ErrorCount>,
        /// Present on the snapshot that closes a full second.
        pub second: Option<SecondPoint>,
        pub warnings: Vec<Warning>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum EndReason { Completed, Stopped, Failed }

    #[derive(Default)]
    pub struct Totals {
        pub total: u64,
        pub ok: u64,
        pub failed: u64,
        pub cancelled: u64,
        pub status_counts: Vec<StatusCount>,
        pub error_counts: Vec<ErrorCount>,
    }

    pub struct RunSummary {
        pub run_id: String,
        pub config: TestConfig,
        pub started_at: i64,
        pub ended_at: i64,
        pub end_reason: EndReason,
        pub error: Option<String>,
        pub totals: Totals,
        pub latency_corrected: Percentiles,
        pub latency_raw: Percentiles,
        pub ttfb: Percentiles,
        pub duration_ms: u64,
        pub achieved_rps: f64,
        pub bytes: u64,
        /// Whether an RPS cap was active (corrected latency is the headline only then).
        pub capped: bool,
        pub warnings: Vec<Warning>,
        pub series: Vec<SecondPoint>,
    }

    pub struct Settings {
        pub max_concurrency: u32,
        pub max_rps: u32,
        pub history_limit: u32,
        pub strip_secrets_on_export: bool,
        /// Keep bearer/sensitive header values in run history files (default: redacted).
        pub store_secrets_in_history: bool,
        /// Treat RFC 1918 / ULA addresses like loopback (skip the confirmation).
        pub private_ranges_as_local: bool,
    }

    pub struct FieldError {
        pub field: String,
        pub message: String,
    }

    #[serde(rename_all = "snake_case")]
    pub enum ExportFormat { Json, Csv }

    pub struct TargetCheck {
        pub host: String,
        pub addrs: Vec<String>,
        pub loopback: bool,
        pub private: bool,
        /// True when no confirmation is required (loopback, already approved, or allowed private).
        pub approved: bool,
    }
}

impl Default for LoadSpec {
    fn default() -> Self {
        Self {
            concurrency: 50,
            stop: StopCondition::Duration { secs: 30 },
            rps_cap: None,
            ramp_up_secs: None,
            timeout_ms: 10_000,
            success_range: StatusRange { min: 200, max: 399 },
            follow_redirects: true,
            allow_invalid_certs: false,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_concurrency: 1000,
            max_rps: 20_000,
            history_limit: 100,
            strip_secrets_on_export: true,
            store_secrets_in_history: false,
            private_ranges_as_local: false,
        }
    }
}

impl Method {
    pub fn as_str(&self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
            Method::Head => "HEAD",
            Method::Options => "OPTIONS",
        }
    }
}

impl ErrorKind {
    pub const ALL: [ErrorKind; 8] = [
        ErrorKind::Timeout,
        ErrorKind::Connect,
        ErrorKind::Dns,
        ErrorKind::Tls,
        ErrorKind::BodyRead,
        ErrorKind::Status,
        ErrorKind::Redirect,
        ErrorKind::Other,
    ];

    pub fn index(self) -> usize {
        self as usize
    }
}

/// Header names whose values are treated as secrets (masked, stripped from exports).
pub const SENSITIVE_HEADERS: [&str; 4] =
    ["authorization", "proxy-authorization", "cookie", "x-api-key"];

pub const REDACTED: &str = "[redacted]";

pub fn is_sensitive_header(name: &str) -> bool {
    SENSITIVE_HEADERS.iter().any(|h| h.eq_ignore_ascii_case(name.trim()))
}

impl TestConfig {
    /// A copy with bearer token and sensitive header values replaced by `[redacted]`.
    pub fn redacted(&self) -> TestConfig {
        let mut c = self.clone();
        if c.request.bearer.as_deref().is_some_and(|b| !b.is_empty()) {
            c.request.bearer = Some(REDACTED.into());
        }
        for h in &mut c.request.headers {
            if is_sensitive_header(&h.name) && !h.value.is_empty() {
                h.value = REDACTED.into();
            }
        }
        c
    }
}

impl RunSummary {
    /// Same summary without the per-second series (used for history listings).
    pub fn without_series(&self) -> RunSummary {
        RunSummary { series: Vec::new(), ..self.clone() }
    }
}

/// Hard ceilings the engine enforces regardless of the UI.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_concurrency: u32,
    pub max_rps: u32,
}

impl From<&Settings> for Limits {
    fn from(s: &Settings) -> Self {
        Limits { max_concurrency: s.max_concurrency, max_rps: s.max_rps }
    }
}

impl Default for Limits {
    fn default() -> Self {
        (&Settings::default()).into()
    }
}

fn err(field: &str, message: impl Into<String>) -> FieldError {
    FieldError { field: field.into(), message: message.into() }
}

impl RequestSpec {
    pub fn validate(&self) -> Vec<FieldError> {
        let mut errors = Vec::new();
        let url = self.url.trim();
        if url.is_empty() {
            errors.push(err("request.url", "URL is required"));
        } else {
            match reqwest::Url::parse(url) {
                Ok(u) if u.scheme() != "http" && u.scheme() != "https" => {
                    errors.push(err("request.url", "URL must start with http:// or https://"))
                }
                Ok(u) if u.host_str().is_none_or(str::is_empty) => {
                    errors.push(err("request.url", "URL has no host"))
                }
                Ok(_) => {}
                Err(e) => errors.push(err("request.url", format!("Invalid URL: {e}"))),
            }
        }
        for (i, h) in self.headers.iter().enumerate() {
            if !h.enabled {
                continue;
            }
            let field = format!("request.headers.{i}");
            if h.name.trim().is_empty() {
                errors.push(err(&field, "Header name is required"));
            } else if reqwest::header::HeaderName::from_bytes(h.name.trim().as_bytes()).is_err() {
                errors.push(err(&field, "Invalid header name"));
            } else if reqwest::header::HeaderValue::from_str(&h.value).is_err() {
                errors.push(err(&field, "Invalid header value"));
            }
        }
        if let Some(body) = &self.body {
            if body.kind == BodyKind::Json && !body.content.trim().is_empty() {
                if let Err(e) = serde_json::from_str::<serde_json::Value>(&body.content) {
                    errors.push(err("request.body", format!("Invalid JSON: {e}")));
                }
            }
        }
        if let Some(b) = &self.bearer {
            if reqwest::header::HeaderValue::from_str(&format!("Bearer {b}")).is_err() {
                errors.push(err("request.bearer", "Token contains invalid characters"));
            }
        }
        errors
    }
}

impl LoadSpec {
    pub fn validate(&self, limits: Limits) -> Vec<FieldError> {
        let mut errors = Vec::new();
        if self.concurrency == 0 {
            errors.push(err("load.concurrency", "Concurrency must be at least 1"));
        } else if self.concurrency > limits.max_concurrency {
            errors.push(err(
                "load.concurrency",
                format!("Concurrency is capped at {} (Settings)", limits.max_concurrency),
            ));
        }
        match self.stop {
            StopCondition::Requests { count: 0 } => {
                errors.push(err("load.stop", "Request count must be at least 1"))
            }
            StopCondition::Duration { secs: 0 } => {
                errors.push(err("load.stop", "Duration must be at least 1 second"))
            }
            StopCondition::Duration { secs } if secs > 24 * 3600 => {
                errors.push(err("load.stop", "Duration must be at most 24 hours"))
            }
            _ => {}
        }
        if let Some(rps) = self.rps_cap {
            if rps == 0 {
                errors.push(err("load.rps_cap", "RPS cap must be at least 1"));
            } else if rps > limits.max_rps {
                errors.push(err(
                    "load.rps_cap",
                    format!("RPS is capped at {} (Settings)", limits.max_rps),
                ));
            }
        }
        if let Some(r) = self.ramp_up_secs {
            if r > 3600 {
                errors.push(err("load.ramp_up_secs", "Ramp-up must be at most 3600 s"));
            }
            if let StopCondition::Duration { secs } = self.stop {
                if r >= secs && r > 0 {
                    errors.push(err("load.ramp_up_secs", "Ramp-up must be shorter than the duration"));
                }
            }
        }
        if self.timeout_ms < 1 || self.timeout_ms > 300_000 {
            errors.push(err("load.timeout_ms", "Timeout must be between 1 ms and 300 s"));
        }
        let r = &self.success_range;
        if r.min < 100 || r.max > 599 || r.min > r.max {
            errors.push(err("load.success_range", "Status range must be within 100–599 and min ≤ max"));
        }
        errors
    }
}

impl TestConfig {
    pub fn validate(&self, limits: Limits) -> Vec<FieldError> {
        let mut e = Vec::new();
        if self.name.trim().is_empty() {
            e.push(err("name", "Name is required"));
        }
        e.extend(self.request.validate());
        e.extend(self.load.validate(limits));
        e
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(url: &str) -> RequestSpec {
        RequestSpec { method: Method::Get, url: url.into(), headers: vec![], body: None, bearer: None }
    }

    #[test]
    fn url_validation() {
        assert!(req("http://localhost:8080/x").validate().is_empty());
        assert_eq!(req("").validate()[0].field, "request.url");
        assert!(!req("ftp://x").validate().is_empty());
        assert!(!req("not a url").validate().is_empty());
    }

    #[test]
    fn json_body_validation() {
        let mut r = req("http://localhost");
        r.body = Some(Body { kind: BodyKind::Json, content: "{\"a\":".into() });
        assert_eq!(r.validate()[0].field, "request.body");
        r.body = Some(Body { kind: BodyKind::Json, content: "{\"a\":1}".into() });
        assert!(r.validate().is_empty());
    }

    #[test]
    fn load_limits() {
        let limits = Limits { max_concurrency: 10, max_rps: 100 };
        let mut l = LoadSpec { concurrency: 11, ..Default::default() };
        assert_eq!(l.validate(limits)[0].field, "load.concurrency");
        l.concurrency = 5;
        l.rps_cap = Some(101);
        assert_eq!(l.validate(limits)[0].field, "load.rps_cap");
        l.rps_cap = None;
        l.success_range = StatusRange { min: 400, max: 200 };
        assert_eq!(l.validate(limits)[0].field, "load.success_range");
    }

    #[test]
    fn redaction() {
        let mut r = req("http://localhost");
        r.bearer = Some("secret".into());
        r.headers.push(Header { name: "Authorization".into(), value: "Basic x".into(), enabled: true });
        r.headers.push(Header { name: "X-Trace".into(), value: "keep".into(), enabled: true });
        let c = TestConfig { id: "1".into(), name: "n".into(), request: r, load: Default::default(), created_at: 0, updated_at: 0 };
        let red = c.redacted();
        assert_eq!(red.request.bearer.as_deref(), Some(REDACTED));
        assert_eq!(red.request.headers[0].value, REDACTED);
        assert_eq!(red.request.headers[1].value, "keep");
    }

    #[test]
    fn serde_shapes() {
        let s = serde_json::to_string(&StopCondition::Requests { count: 5 }).unwrap();
        assert_eq!(s, r#"{"kind":"requests","count":5}"#);
        assert_eq!(serde_json::to_string(&Method::Get).unwrap(), "\"GET\"");
        assert_eq!(serde_json::to_string(&ErrorKind::BodyRead).unwrap(), "\"body_read\"");
    }
}
