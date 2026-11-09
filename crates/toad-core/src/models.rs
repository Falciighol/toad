//! Run and result types shared by the engine, the app and the UI. Every type here is
//! exported to TypeScript (feature `specta`). The test definition lives in `spec.rs`.
//! Durations/latencies are microseconds unless the field name says otherwise.

use crate::spec::{KeyValue, StepPhase};
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

    /// v1 stop condition (kept for loading v1 tests).
    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum StopCondition {
        Requests { count: u64 },
        Duration { secs: u32 },
    }

    pub struct StatusRange {
        pub min: u16,
        pub max: u16,
    }

    #[serde(rename_all = "snake_case")]
    pub enum Phase { Setup, Ramping, Running, Stopping, Teardown, Done, Failed }

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
    pub enum ErrorKind { Timeout, Connect, Dns, Tls, BodyRead, Status, Redirect, Check, Other }

    pub struct StatusCount { pub code: u16, pub count: u64 }

    pub struct ErrorCount { pub kind: ErrorKind, pub count: u64 }

    #[derive(Eq, Hash)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum Warning {
        /// Achieved rate is well below target while server latency is flat.
        ToadBottleneck,
        /// The OS refused to open more sockets (EMFILE).
        FdLimit,
        /// The async runtime is lagging (aggregator tick late by >50 ms).
        SchedulerLag,
        /// Not a Toad problem: max virtual users is too low to reach the rate.
        ConcurrencyTooLow { needed: u32 },
        /// Arrival-rate iterations were dropped because no virtual user was free.
        DroppedIterations { scenario: String, count: u64 },
        /// A data file ran out of rows.
        DataExhausted { file: String },
    }

    /// Requests and iterations that never produced a latency sample, by cause.
    #[derive(Default)]
    pub struct OutcomeCounts {
        /// Not sent: a variable it needs was missing (an upstream extraction failed).
        pub skipped: u64,
        /// Not sent: its Run if rule was false. A normal path, not an error.
        pub not_taken: u64,
        /// Not sent: the host wasn't loopback or confirmed.
        pub blocked: u64,
        /// Not sent: the request couldn't be built (bad URL or header after templating).
        pub build_errors: u64,
        /// Arrival-rate iterations not started because max virtual users was reached.
        pub dropped: u64,
        /// Requests with at least one failed check (counted even when the check doesn't fail the request).
        pub check_failures: u64,
        pub extract_failures: u64,
        pub iterations: u64,
        pub iterations_failed: u64,
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
        /// Active virtual users at the end of the second.
        #[serde(default)]
        pub vus: u32,
        /// Iterations started in the second.
        #[serde(default)]
        pub iterations: u64,
    }

    /// One scenario's second: what its load profile achieved, for planned-vs-achieved.
    pub struct ScenarioPoint {
        pub t_s: u32,
        /// Busy virtual users at the end of the second.
        pub vus: u32,
        /// Iterations started in the second.
        pub iterations: u64,
    }

    /// One endpoint's second. `hist` is a sparse latency histogram: pairs of
    /// [bucket index, count] over [`crate::metrics::BUCKETS`] (corrected latency).
    pub struct StepPoint {
        pub t_s: u32,
        pub ok: u64,
        pub failed: u64,
        pub p50: u64,
        pub p95: u64,
        pub p99: u64,
        pub hist: Vec<u32>,
    }

    pub struct EndpointLive {
        pub step_id: String,
        pub total: u64,
        pub failed: u64,
        /// Requests per second over the last interval.
        pub rps: f64,
        pub p95: u64,
        pub p99: u64,
        /// p99 over the whole run so far.
        pub p99_run: u64,
        pub skipped: u64,
        pub not_taken: u64,
    }

    pub struct ScenarioLive {
        pub id: String,
        pub vus: u32,
        pub iterations: u64,
        pub dropped: u64,
        /// The profile's planned value now: VUs (closed) or iterations/s (open).
        pub target: f64,
    }

    pub struct ThresholdResult {
        pub id: String,
        /// e.g. "p95 < 300 ms · Checkout"
        pub label: String,
        pub observed: f64,
        pub passed: bool,
        /// When it first failed during the run (live evaluation), ms since start.
        pub crossed_at_ms: Option<u64>,
        /// Too few samples to judge yet.
        pub pending: bool,
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
        /// Planned rate for open-model runs: iterations/s summed over scenarios.
        pub target_rps: Option<f64>,
        /// Latency measured from the scheduled send time (equal to raw when no open-model scenario).
        pub lat_interval: Percentiles,
        pub lat_interval_raw: Percentiles,
        pub lat_cumulative: Percentiles,
        pub lat_cumulative_raw: Percentiles,
        pub status_counts: Vec<StatusCount>,
        pub error_counts: Vec<ErrorCount>,
        /// Present on the snapshot that closes a full second.
        pub second: Option<SecondPoint>,
        pub warnings: Vec<Warning>,
        pub outcomes: OutcomeCounts,
        pub endpoints: Vec<EndpointLive>,
        pub scenarios: Vec<ScenarioLive>,
        pub thresholds: Vec<ThresholdResult>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum EndReason { Completed, Stopped, Aborted, Failed }

    #[derive(Default)]
    pub struct Totals {
        pub total: u64,
        pub ok: u64,
        pub failed: u64,
        pub cancelled: u64,
        pub status_counts: Vec<StatusCount>,
        pub error_counts: Vec<ErrorCount>,
    }

    pub struct RuleCount { pub id: String, pub count: u64 }

    /// A point on the percentile spectrum: `q` in 0..1, latency in µs.
    pub struct SpectrumPoint { pub q: f64, pub us: u64 }

    /// Everything measured for one request step.
    pub struct EndpointSummary {
        pub step_id: String,
        pub name: String,
        pub phase: StepPhase,
        pub scenario_id: Option<String>,
        pub group_id: Option<String>,
        pub method: String,
        /// URL template as written (one row per step, whatever the variables resolved to).
        pub url: String,
        pub totals: Totals,
        pub outcomes: OutcomeCounts,
        pub check_failures: Vec<RuleCount>,
        pub extract_failures: Vec<RuleCount>,
        /// Corrected latency (equal to raw outside open-model scenarios).
        pub latency: Percentiles,
        pub latency_raw: Percentiles,
        pub ttfb: Percentiles,
        pub bytes: u64,
        pub spectrum: Vec<SpectrumPoint>,
        pub series: Vec<StepPoint>,
    }

    pub struct ScenarioSummary {
        pub id: String,
        pub name: String,
        pub iterations: u64,
        pub iterations_failed: u64,
        pub dropped: u64,
        pub peak_vus: u32,
        pub iteration_duration: Percentiles,
        pub open_model: bool,
        /// Per-second achieved load (empty for runs recorded before it existed).
        #[serde(default)]
        pub series: Vec<ScenarioPoint>,
    }

    pub struct DataFileInfo { pub name: String, pub rows: u64, pub hash: String }

    #[derive(Default)]
    pub struct RunEnv {
        pub toad_version: String,
        pub os: String,
        pub cores: u32,
        pub environment: String,
        pub proxied: bool,
        pub data_files: Vec<DataFileInfo>,
    }

    #[derive(Default)]
    pub struct SamplesInfo {
        pub count: u64,
        pub bytes: u64,
        /// A cap was hit, so some failures or slow requests weren't kept.
        pub truncated: bool,
        /// Bodies weren't stored (Settings).
        pub bodies: bool,
    }

    pub struct RunSummary {
        pub run_id: String,
        pub config: crate::spec::TestConfig,
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
        /// Whether an open-model scenario ran (corrected latency is the headline only then).
        pub capped: bool,
        pub warnings: Vec<Warning>,
        pub series: Vec<SecondPoint>,
        #[serde(default)]
        pub outcomes: OutcomeCounts,
        #[serde(default)]
        pub endpoints: Vec<EndpointSummary>,
        #[serde(default)]
        pub scenarios: Vec<ScenarioSummary>,
        #[serde(default)]
        pub verdict: Vec<ThresholdResult>,
        /// Threshold that aborted the run.
        #[serde(default)]
        pub aborted_by: Option<String>,
        #[serde(default)]
        pub env: RunEnv,
        #[serde(default)]
        pub samples: SamplesInfo,
        /// Stored before format v2: per-step data doesn't exist.
        #[serde(default)]
        pub legacy: bool,
    }

    #[serde(rename_all = "snake_case")]
    pub enum SampleReason { Failure, Slow, Random, Try }

    #[serde(rename_all = "snake_case")]
    pub enum StepOutcome { Ok, Failed, Skipped, NotTaken, Blocked, BuildError, Cancelled }

    pub struct SampleRequest {
        pub method: String,
        pub url: String,
        pub headers: Vec<KeyValue>,
        pub body: String,
        pub body_bytes: u64,
        pub truncated: bool,
        pub binary: bool,
    }

    pub struct SampleResponse {
        pub status: u16,
        pub headers: Vec<KeyValue>,
        pub body: String,
        pub body_bytes: u64,
        pub truncated: bool,
        pub binary: bool,
    }

    pub struct Hop { pub status: u16, pub url: String }

    pub struct CheckResult {
        pub id: String,
        pub label: String,
        pub passed: bool,
        pub actual: String,
    }

    pub struct ExtractResult {
        pub id: String,
        pub var: String,
        pub value: Option<String>,
        pub secret: bool,
        pub error: Option<String>,
    }

    /// One step of a virtual user's iteration, without bodies.
    pub struct TraceEntry {
        pub step_id: String,
        pub name: String,
        pub outcome: StepOutcome,
        pub status: Option<u16>,
        pub latency_us: u64,
        pub t_ms: u64,
        pub note: Option<String>,
    }

    /// A captured request with its response and context.
    pub struct Sample {
        pub id: u64,
        pub step_id: String,
        pub scenario_id: Option<String>,
        pub reason: SampleReason,
        pub outcome: StepOutcome,
        pub error_kind: Option<ErrorKind>,
        pub error: Option<String>,
        /// ms since run start.
        pub t_ms: u64,
        pub vu: u32,
        pub iteration: u64,
        pub latency_us: u64,
        pub raw_us: u64,
        pub ttfb_us: u64,
        pub request: Option<SampleRequest>,
        pub response: Option<SampleResponse>,
        pub redirects: Vec<Hop>,
        pub vars: Vec<KeyValue>,
        pub checks: Vec<CheckResult>,
        pub extracted: Vec<ExtractResult>,
        /// Earlier steps of the same iteration.
        pub trace: Vec<TraceEntry>,
        /// Run if outcome when the step had a rule.
        pub branch: Option<bool>,
    }

    /// Result of Try once / Send once.
    pub struct TryResult {
        pub steps: Vec<Sample>,
        pub error: Option<String>,
        /// Variables in scope at the end (secret values redacted).
        pub vars: Vec<KeyValue>,
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
        /// Per endpoint: failures kept per error kind.
        #[serde(default = "d_fail")]
        pub sample_failures: u32,
        #[serde(default = "d_slow")]
        pub sample_slowest: u32,
        #[serde(default = "d_rand")]
        pub sample_random: u32,
        #[serde(default = "d_body")]
        pub sample_body_kb: u32,
        #[serde(default = "d_run")]
        pub sample_run_mb: u32,
        /// Store request/response bodies in samples.
        #[serde(default = "d_true")]
        pub sample_bodies: bool,
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

    #[serde(rename_all = "snake_case")]
    pub enum HostSource { Static, Runtime, Proxy }

    /// A host a test touches, for the Review stage.
    pub struct HostInfo {
        pub host: String,
        pub source: HostSource,
        /// Steps that reach it (labels).
        pub steps: Vec<String>,
        pub check: Option<TargetCheck>,
        pub error: Option<String>,
    }
}

fn d_fail() -> u32 {
    200
}
fn d_slow() -> u32 {
    50
}
fn d_rand() -> u32 {
    100
}
fn d_body() -> u32 {
    64
}
fn d_run() -> u32 {
    50
}
fn d_true() -> bool {
    true
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
            sample_failures: d_fail(),
            sample_slowest: d_slow(),
            sample_random: d_rand(),
            sample_body_kb: d_body(),
            sample_run_mb: d_run(),
            sample_bodies: true,
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
    pub const ALL: [ErrorKind; 9] = [
        ErrorKind::Timeout,
        ErrorKind::Connect,
        ErrorKind::Dns,
        ErrorKind::Tls,
        ErrorKind::BodyRead,
        ErrorKind::Status,
        ErrorKind::Redirect,
        ErrorKind::Check,
        ErrorKind::Other,
    ];

    pub fn index(self) -> usize {
        self as usize
    }
}

impl RunSummary {
    /// Same summary without the series (used for history listings).
    pub fn without_series(&self) -> RunSummary {
        RunSummary {
            series: Vec::new(),
            endpoints: self
                .endpoints
                .iter()
                .map(|e| EndpointSummary { series: Vec::new(), spectrum: Vec::new(), ..e.clone() })
                .collect(),
            ..self.clone()
        }
    }

    /// The headline latency: corrected when an open-model scenario ran.
    pub fn headline(&self) -> &Percentiles {
        if self.capped {
            &self.latency_corrected
        } else {
            &self.latency_raw
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_shapes() {
        let s = serde_json::to_string(&StopCondition::Requests { count: 5 }).unwrap();
        assert_eq!(s, r#"{"kind":"requests","count":5}"#);
        assert_eq!(serde_json::to_string(&Method::Get).unwrap(), "\"GET\"");
        assert_eq!(serde_json::to_string(&ErrorKind::BodyRead).unwrap(), "\"body_read\"");
    }

    #[test]
    fn old_settings_files_get_sampling_defaults() {
        let old = r#"{"max_concurrency":10,"max_rps":5,"history_limit":3,"strip_secrets_on_export":true,
                      "store_secrets_in_history":false,"private_ranges_as_local":true}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(s.max_concurrency, 10);
        assert_eq!((s.sample_failures, s.sample_slowest, s.sample_random, s.sample_body_kb, s.sample_run_mb), (200, 50, 100, 64, 50));
        assert!(s.sample_bodies);
    }
}
