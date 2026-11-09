//! The test definition (format v2): scenarios of steps, data, environments, thresholds and
//! connection settings. Every type here is exported to TypeScript (feature `specta`).
//!
//! A test holds one or more scenarios that run concurrently. A scenario is either a *flow*
//! (each virtual user walks its steps in order, then repeats) or a *mix* (each iteration
//! picks one step by weight). Values are written as `{{templates}}` (see `template.rs`).
//!
//! v1 tests (one request + load settings) still load: [`TestConfig`] deserializes either
//! shape and converts v1 into a single-step, single-scenario v2 test.

use crate::models::{Method, StatusRange};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

macro_rules! model {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
            #[cfg_attr(feature = "specta", derive(specta::Type))]
            $item
        )*
    };
}

pub const FORMAT_VERSION: u32 = 2;

model! {
    /// A name/value row with an on/off switch: headers, query params, cookies, values.
    pub struct KeyValue {
        pub name: String,
        pub value: String,
        pub enabled: bool,
    }

    #[serde(rename_all = "snake_case")]
    pub enum BodyKind { Json, Xml, Text, Form, Multipart, Graphql, Binary, Raw }

    pub struct FormField {
        pub name: String,
        /// Text value, or for a file field the asset file name in the test folder.
        pub value: String,
        pub enabled: bool,
        pub file: bool,
    }

    pub struct BodySpec {
        pub kind: BodyKind,
        /// JSON / XML / text / raw content, or the GraphQL query.
        pub content: String,
        /// Form and multipart fields.
        pub fields: Vec<FormField>,
        /// GraphQL variables (JSON).
        pub variables: String,
        /// Binary body: asset file name in the test folder.
        pub file: Option<String>,
        /// Content-Type to send. Empty: chosen from the kind.
        pub content_type: String,
        pub gzip: bool,
    }

    #[serde(rename_all = "snake_case")]
    pub enum ApiKeyLocation { Header, Query }

    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum Auth {
        /// Use the test's default auth.
        Inherit,
        None,
        Bearer { token: String },
        Basic { username: String, password: String },
        ApiKey { name: String, value: String, location: ApiKeyLocation },
    }

    #[serde(rename_all = "snake_case")]
    pub enum ExtractSource { Json, Xpath, Header, Cookie, Regex, Status, Latency }

    #[serde(rename_all = "snake_case")]
    pub enum ExtractPick { First, Last, Random, All, Index }

    #[serde(rename_all = "snake_case")]
    pub enum OnMissing { FailStep, UseDefault, SkipIteration }

    /// Captures a value from a response into a variable for later steps.
    pub struct Extractor {
        pub id: String,
        pub var: String,
        pub source: ExtractSource,
        /// JSONPath, XPath, header or cookie name, or regex (first group is the value).
        pub expr: String,
        pub pick: ExtractPick,
        pub index: u32,
        pub default: String,
        pub on_missing: OnMissing,
        pub secret: bool,
        pub enabled: bool,
    }

    #[serde(rename_all = "snake_case")]
    pub enum CheckKind { Status, Body, Json, Xpath, Header, Latency }

    #[serde(rename_all = "snake_case")]
    pub enum CheckOp { Equals, NotEquals, Contains, NotContains, Matches, Exists, Missing, Lt, Lte, Gt, Gte, InRange }

    /// An assertion on a response.
    pub struct Check {
        pub id: String,
        pub kind: CheckKind,
        /// JSONPath / XPath / header name; unused for status, body and latency.
        pub expr: String,
        pub op: CheckOp,
        /// Expected value. `in_range` takes "min-max"; latency is in ms.
        pub value: String,
        /// When on, a failed check counts the request as failed; otherwise only as a check failure.
        pub fails_request: bool,
        pub enabled: bool,
    }

    #[serde(rename_all = "snake_case")]
    pub enum MatchMode { All, Any }

    #[serde(rename_all = "snake_case")]
    pub enum ClauseSubject { Variable, PrevStatus, PrevOutcome }

    #[serde(rename_all = "snake_case")]
    pub enum ClauseOp { Exists, Missing, Equals, NotEquals, Matches, Lt, Lte, Gt, Gte, Ok, Failed }

    pub struct Clause {
        pub subject: ClauseSubject,
        /// Variable name (for `variable`).
        pub name: String,
        pub op: ClauseOp,
        pub value: String,
    }

    /// Declarative condition: a step whose rule is false is "not taken" (a normal path).
    pub struct RunIf {
        pub mode: MatchMode,
        pub clauses: Vec<Clause>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum CookieMode { Jar, ClearBefore, NoJar }

    pub struct RequestStep {
        pub id: String,
        pub name: String,
        /// GET, POST, … or a custom token.
        pub method: String,
        pub url: String,
        pub params: Vec<KeyValue>,
        pub headers: Vec<KeyValue>,
        pub cookies: Vec<KeyValue>,
        pub cookie_mode: CookieMode,
        pub body: Option<BodySpec>,
        pub auth: Auth,
        /// Values computed once before the request (`orderId = {{$uuid}}`) for reuse in it.
        pub values: Vec<KeyValue>,
        pub extract: Vec<Extractor>,
        pub checks: Vec<Check>,
        pub run_if: Option<RunIf>,
        pub timeout_ms: Option<u32>,
        pub follow_redirects: Option<bool>,
        /// Most of a response body read for extraction and checks, in KB.
        pub max_response_kb: Option<u32>,
        /// Mix scenarios: relative weight.
        pub weight: u32,
    }

    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum ThinkTime {
        Fixed { ms: u32 },
        Uniform { min_ms: u32, max_ms: u32 },
        Normal { mean_ms: u32, sd_ms: u32 },
    }

    /// Members fire together; the group ends when all have finished.
    pub struct ParallelGroup {
        pub id: String,
        pub name: String,
        pub steps: Vec<RequestStep>,
        pub run_if: Option<RunIf>,
    }

    pub struct Pause {
        pub id: String,
        pub think: ThinkTime,
        pub run_if: Option<RunIf>,
    }

    #[serde(tag = "kind", rename_all = "snake_case")]
    #[allow(clippy::large_enum_variant)]
    pub enum FlowItem {
        Request { step: RequestStep },
        Group { group: ParallelGroup },
        Pause { pause: Pause },
    }

    #[serde(rename_all = "snake_case")]
    pub enum ScenarioKind { Flow, Mix }

    /// One leg of a staged profile: move linearly to `target` over `duration_secs`.
    pub struct Stage {
        pub duration_secs: u32,
        pub target: u32,
    }

    /// How a scenario's load is generated.
    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum Executor {
        /// Closed model: a fixed number of virtual users looping.
        Vus { vus: u32, duration_secs: u32 },
        /// Closed model with stages (ramp up, hold, ramp down).
        RampingVus { start: u32, stages: Vec<Stage> },
        /// Open model: iterations started per second, regardless of how fast the target answers.
        Rate { rate: u32, duration_secs: u32, max_vus: u32 },
        /// Open model with staged rates.
        RampingRate { start: u32, stages: Vec<Stage>, max_vus: u32 },
        /// A fixed number of iterations shared by the virtual users.
        Iterations { vus: u32, iterations: u64, max_duration_secs: u32 },
    }

    pub struct Scenario {
        pub id: String,
        pub name: String,
        pub kind: ScenarioKind,
        pub enabled: bool,
        /// Runs once per virtual user, before its first iteration (e.g. log in per user).
        pub init: Vec<FlowItem>,
        pub steps: Vec<FlowItem>,
        pub executor: Executor,
        pub start_offset_secs: u32,
        /// How long in-flight iterations may finish after the scenario ends.
        pub graceful_stop_secs: u32,
        /// Default think time after each request step (flows only).
        pub think: Option<ThinkTime>,
    }

    pub struct Environment {
        pub id: String,
        pub name: String,
    }

    pub struct Variable {
        pub name: String,
        pub secret: bool,
        /// Environment id → value.
        pub values: BTreeMap<String, String>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum DataFormat { Csv, Json }

    #[serde(rename_all = "snake_case")]
    pub enum Distribution { Sequential, Random, UniquePerVu }

    #[serde(rename_all = "snake_case")]
    pub enum OnExhausted { Wrap, StopVu, StopRun }

    /// A CSV/JSON file copied into the test folder. Columns read as `{{name.column}}`.
    pub struct DataFile {
        pub id: String,
        pub name: String,
        /// Asset file name in the test folder.
        pub file: String,
        pub original_name: String,
        pub format: DataFormat,
        pub has_header: bool,
        pub columns: Vec<String>,
        pub secret_columns: Vec<String>,
        pub rows: u64,
        pub distribution: Distribution,
        pub on_exhausted: OnExhausted,
    }

    #[serde(rename_all = "snake_case")]
    pub enum JarMode { PerVu, Shared, Off }

    pub struct SeedCookie {
        pub domain: String,
        pub path: String,
        pub name: String,
        pub value: String,
        pub secure: bool,
    }

    pub struct CookiePolicy {
        pub mode: JarMode,
        pub clear_each_iteration: bool,
        pub seed: Vec<SeedCookie>,
    }

    pub struct Defaults {
        /// Available as `{{baseUrl}}` when no variable of that name exists.
        pub base_url: String,
        pub headers: Vec<KeyValue>,
        pub auth: Auth,
        pub user_agent: String,
        pub timeout_ms: u32,
        pub success_range: StatusRange,
        pub follow_redirects: bool,
        pub max_redirects: u32,
        pub max_response_kb: u32,
    }

    #[serde(rename_all = "snake_case")]
    pub enum PoolMode { Shared, PerVu }

    #[serde(rename_all = "snake_case")]
    pub enum HttpVersion { Auto, Http1 }

    pub struct HostOverride {
        pub host: String,
        /// IP address (optionally with :port) the host resolves to for this test.
        pub address: String,
    }

    /// A client certificate (mTLS), PEM. Applies to hosts matching `host`.
    pub struct ClientCert {
        pub id: String,
        /// Exact host, `*.example.com`, or empty for every host.
        pub host: String,
        pub cert_file: String,
        pub cert_name: String,
        /// Empty when the key is inside the certificate file.
        pub key_file: String,
        pub key_name: String,
    }

    #[serde(rename_all = "snake_case")]
    pub enum ProxyKind { Http, Https, Socks5 }

    pub struct ProxySpec {
        pub enabled: bool,
        pub kind: ProxyKind,
        /// host:port
        pub address: String,
        pub username: String,
        pub password: String,
        /// Comma-separated hosts that bypass the proxy.
        pub no_proxy: String,
    }

    pub struct ConnectionSpec {
        pub keep_alive: bool,
        pub pool: PoolMode,
        pub http: HttpVersion,
        pub allow_invalid_certs: bool,
        pub host_overrides: Vec<HostOverride>,
        pub client_certs: Vec<ClientCert>,
        pub proxy: ProxySpec,
    }

    #[serde(rename_all = "snake_case")]
    pub enum ThresholdMetric { P50, P90, P95, P99, Max, ErrorRate, CheckPassRate, Rps, Dropped }

    #[serde(rename_all = "snake_case")]
    pub enum Cmp { Lt, Lte, Gt, Gte }

    /// Pass/fail criterion. Latency values are ms, rates are percent, rps is requests/s.
    pub struct Threshold {
        pub id: String,
        pub metric: ThresholdMetric,
        /// "" for the whole test, "scenario:<id>" or "step:<id>".
        pub scope: String,
        pub op: Cmp,
        pub value: f64,
        pub abort: bool,
        /// Not evaluated for aborting before this many seconds.
        pub delay_secs: u32,
        pub enabled: bool,
    }
}

/// A saved test (format v2). Deserializes v1 files too (see [`legacy`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TestConfig {
    pub version: u32,
    pub id: String,
    pub name: String,
    /// Epoch milliseconds.
    pub created_at: i64,
    pub updated_at: i64,
    pub defaults: Defaults,
    pub environments: Vec<Environment>,
    /// Id of the environment used when running. Empty: none.
    pub active_env: String,
    pub variables: Vec<Variable>,
    pub data: Vec<DataFile>,
    pub cookies: CookiePolicy,
    pub connection: ConnectionSpec,
    /// Runs once before load starts; extracted values are shared by every virtual user.
    pub setup: Vec<RequestStep>,
    /// Runs once after load ends.
    pub teardown: Vec<RequestStep>,
    pub scenarios: Vec<Scenario>,
    pub thresholds: Vec<Threshold>,
    /// Seconds at the start excluded from the verdict statistics (still shown).
    pub warmup_secs: u32,
}

/// The v2 shape, for deserialization only (TestConfig's own Deserialize dispatches on shape).
#[derive(Deserialize)]
struct TestConfigV2 {
    #[serde(default = "v2")]
    version: u32,
    id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    defaults: Defaults,
    #[serde(default)]
    environments: Vec<Environment>,
    #[serde(default)]
    active_env: String,
    #[serde(default)]
    variables: Vec<Variable>,
    #[serde(default)]
    data: Vec<DataFile>,
    #[serde(default)]
    cookies: CookiePolicy,
    #[serde(default)]
    connection: ConnectionSpec,
    #[serde(default)]
    setup: Vec<RequestStep>,
    #[serde(default)]
    teardown: Vec<RequestStep>,
    scenarios: Vec<Scenario>,
    #[serde(default)]
    thresholds: Vec<Threshold>,
    #[serde(default)]
    warmup_secs: u32,
}

fn v2() -> u32 {
    FORMAT_VERSION
}

impl From<TestConfigV2> for TestConfig {
    fn from(c: TestConfigV2) -> Self {
        TestConfig {
            version: c.version.max(FORMAT_VERSION),
            id: c.id,
            name: c.name,
            created_at: c.created_at,
            updated_at: c.updated_at,
            defaults: c.defaults,
            environments: c.environments,
            active_env: c.active_env,
            variables: c.variables,
            data: c.data,
            cookies: c.cookies,
            connection: c.connection,
            setup: c.setup,
            teardown: c.teardown,
            scenarios: c.scenarios,
            thresholds: c.thresholds,
            warmup_secs: c.warmup_secs,
        }
    }
}

impl<'de> Deserialize<'de> for TestConfig {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        if v.get("request").is_some() && v.get("scenarios").is_none() {
            let old: legacy::V1TestConfig = serde_json::from_value(v).map_err(serde::de::Error::custom)?;
            return Ok(old.into());
        }
        let c: TestConfigV2 = serde_json::from_value(v).map_err(serde::de::Error::custom)?;
        Ok(c.into())
    }
}

// ---------- defaults ----------

impl Default for KeyValue {
    fn default() -> Self {
        KeyValue { name: String::new(), value: String::new(), enabled: true }
    }
}

impl Default for CookiePolicy {
    fn default() -> Self {
        CookiePolicy { mode: JarMode::PerVu, clear_each_iteration: false, seed: vec![] }
    }
}

impl Default for ProxySpec {
    fn default() -> Self {
        ProxySpec {
            enabled: false,
            kind: ProxyKind::Http,
            address: String::new(),
            username: String::new(),
            password: String::new(),
            no_proxy: String::new(),
        }
    }
}

impl Default for ConnectionSpec {
    fn default() -> Self {
        ConnectionSpec {
            keep_alive: true,
            pool: PoolMode::Shared,
            http: HttpVersion::Auto,
            allow_invalid_certs: false,
            host_overrides: vec![],
            client_certs: vec![],
            proxy: ProxySpec::default(),
        }
    }
}

impl Default for Defaults {
    fn default() -> Self {
        Defaults {
            base_url: String::new(),
            headers: vec![],
            auth: Auth::None,
            user_agent: String::new(),
            timeout_ms: 10_000,
            success_range: StatusRange { min: 200, max: 399 },
            follow_redirects: true,
            max_redirects: 5,
            max_response_kb: 1024,
        }
    }
}

impl RequestStep {
    pub fn new(id: impl Into<String>, method: &str, url: impl Into<String>) -> Self {
        RequestStep {
            id: id.into(),
            name: String::new(),
            method: method.into(),
            url: url.into(),
            params: vec![],
            headers: vec![],
            cookies: vec![],
            cookie_mode: CookieMode::Jar,
            body: None,
            auth: Auth::Inherit,
            values: vec![],
            extract: vec![],
            checks: vec![],
            run_if: None,
            timeout_ms: None,
            follow_redirects: None,
            max_response_kb: None,
            weight: 1,
        }
    }

    /// The name shown in outlines and analysis: the step name, or METHOD + path.
    pub fn label(&self) -> String {
        if !self.name.trim().is_empty() {
            return self.name.trim().to_string();
        }
        let path = self
            .url
            .split_once("://")
            .map(|(_, rest)| rest.find('/').map_or("/", |i| &rest[i..]))
            .unwrap_or(&self.url);
        format!("{} {}", self.method, path)
    }
}

impl Scenario {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Scenario {
            id: id.into(),
            name: name.into(),
            kind: ScenarioKind::Flow,
            enabled: true,
            init: vec![],
            steps: vec![],
            executor: Executor::Vus { vus: 50, duration_secs: 30 },
            start_offset_secs: 0,
            graceful_stop_secs: 2,
            think: None,
        }
    }
}

impl TestConfig {
    /// A blank test with one GET step, the shape a new test opens with.
    pub fn blank(id: impl Into<String>, url: &str) -> TestConfig {
        let mut s = Scenario::new("s1", "Main");
        s.steps.push(FlowItem::Request { step: RequestStep::new("r1", "GET", url) });
        TestConfig {
            version: FORMAT_VERSION,
            id: id.into(),
            name: "Untitled test".into(),
            created_at: 0,
            updated_at: 0,
            defaults: Defaults::default(),
            environments: vec![],
            active_env: String::new(),
            variables: vec![],
            data: vec![],
            cookies: CookiePolicy::default(),
            connection: ConnectionSpec::default(),
            setup: vec![],
            teardown: vec![],
            scenarios: vec![s],
            thresholds: vec![],
            warmup_secs: 0,
        }
    }

    pub fn enabled_scenarios(&self) -> impl Iterator<Item = &Scenario> {
        self.scenarios.iter().filter(|s| s.enabled)
    }
}

impl FlowItem {
    pub fn id(&self) -> &str {
        match self {
            FlowItem::Request { step } => &step.id,
            FlowItem::Group { group } => &group.id,
            FlowItem::Pause { pause } => &pause.id,
        }
    }

    pub fn run_if(&self) -> Option<&RunIf> {
        match self {
            FlowItem::Request { step } => step.run_if.as_ref(),
            FlowItem::Group { group } => group.run_if.as_ref(),
            FlowItem::Pause { pause } => pause.run_if.as_ref(),
        }
    }

    /// Request steps in order (group members flattened).
    pub fn steps(&self) -> Vec<&RequestStep> {
        match self {
            FlowItem::Request { step } => vec![step],
            FlowItem::Group { group } => group.steps.iter().collect(),
            FlowItem::Pause { .. } => vec![],
        }
    }
}

impl Executor {
    /// Peak virtual users this executor may run.
    pub fn peak_vus(&self) -> u32 {
        match self {
            Executor::Vus { vus, .. } | Executor::Iterations { vus, .. } => *vus,
            Executor::RampingVus { start, stages } => stages.iter().map(|s| s.target).fold(*start, u32::max),
            Executor::Rate { max_vus, .. } | Executor::RampingRate { max_vus, .. } => *max_vus,
        }
    }

    /// Peak iterations started per second (open models only).
    pub fn peak_rate(&self) -> Option<u32> {
        match self {
            Executor::Rate { rate, .. } => Some(*rate),
            Executor::RampingRate { start, stages, .. } => Some(stages.iter().map(|s| s.target).fold(*start, u32::max)),
            _ => None,
        }
    }

    /// Planned length in seconds (`Iterations`: its max duration).
    pub fn duration_secs(&self) -> u64 {
        match self {
            Executor::Vus { duration_secs, .. } | Executor::Rate { duration_secs, .. } => u64::from(*duration_secs),
            Executor::RampingVus { stages, .. } | Executor::RampingRate { stages, .. } => {
                stages.iter().map(|s| u64::from(s.duration_secs)).sum()
            }
            Executor::Iterations { max_duration_secs, .. } => u64::from(*max_duration_secs),
        }
    }

    pub fn is_open(&self) -> bool {
        matches!(self, Executor::Rate { .. } | Executor::RampingRate { .. })
    }
}

/// Threshold metric labels, for verdict lines.
impl ThresholdMetric {
    pub fn label(&self) -> &'static str {
        match self {
            ThresholdMetric::P50 => "p50",
            ThresholdMetric::P90 => "p90",
            ThresholdMetric::P95 => "p95",
            ThresholdMetric::P99 => "p99",
            ThresholdMetric::Max => "max",
            ThresholdMetric::ErrorRate => "error rate",
            ThresholdMetric::CheckPassRate => "check pass rate",
            ThresholdMetric::Rps => "rps",
            ThresholdMetric::Dropped => "dropped iterations",
        }
    }
}

impl Cmp {
    pub fn holds(&self, observed: f64, value: f64) -> bool {
        match self {
            Cmp::Lt => observed < value,
            Cmp::Lte => observed <= value,
            Cmp::Gt => observed > value,
            Cmp::Gte => observed >= value,
        }
    }

    pub fn symbol(&self) -> &'static str {
        match self {
            Cmp::Lt => "<",
            Cmp::Lte => "≤",
            Cmp::Gt => ">",
            Cmp::Gte => "≥",
        }
    }
}

/// Header names whose values are treated as secrets (masked, stripped from exports).
pub const SENSITIVE_HEADERS: [&str; 5] = ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"];

pub const REDACTED: &str = "[redacted]";

pub fn is_sensitive_header(name: &str) -> bool {
    SENSITIVE_HEADERS.iter().any(|h| h.eq_ignore_ascii_case(name.trim()))
}

fn redact_kv(rows: &mut [KeyValue]) {
    for h in rows {
        if is_sensitive_header(&h.name) && !h.value.is_empty() {
            h.value = REDACTED.into();
        }
    }
}

fn redact_auth(a: &mut Auth) {
    match a {
        Auth::Bearer { token } if !token.is_empty() => *token = REDACTED.into(),
        Auth::Basic { password, .. } if !password.is_empty() => *password = REDACTED.into(),
        Auth::ApiKey { value, .. } if !value.is_empty() => *value = REDACTED.into(),
        _ => {}
    }
}

fn redact_step(s: &mut RequestStep) {
    redact_kv(&mut s.headers);
    for c in &mut s.cookies {
        if !c.value.is_empty() {
            c.value = REDACTED.into();
        }
    }
    redact_auth(&mut s.auth);
}

impl TestConfig {
    /// A copy with secrets replaced by `[redacted]`: sensitive headers, auth credentials,
    /// cookie values, secret variables, and the proxy password.
    pub fn redacted(&self) -> TestConfig {
        let mut c = self.clone();
        redact_kv(&mut c.defaults.headers);
        redact_auth(&mut c.defaults.auth);
        for v in c.variables.iter_mut().filter(|v| v.secret) {
            for val in v.values.values_mut() {
                if !val.is_empty() {
                    *val = REDACTED.into();
                }
            }
        }
        for ck in &mut c.cookies.seed {
            if !ck.value.is_empty() {
                ck.value = REDACTED.into();
            }
        }
        if !c.connection.proxy.password.is_empty() {
            c.connection.proxy.password = REDACTED.into();
        }
        c.setup.iter_mut().chain(c.teardown.iter_mut()).for_each(redact_step);
        for s in &mut c.scenarios {
            for item in s.init.iter_mut().chain(s.steps.iter_mut()) {
                match item {
                    FlowItem::Request { step } => redact_step(step),
                    FlowItem::Group { group } => group.steps.iter_mut().for_each(redact_step),
                    FlowItem::Pause { .. } => {}
                }
            }
        }
        c
    }

    /// Every request step with where it lives: (phase, scenario id, group id, step).
    pub fn all_steps(&self) -> Vec<StepRef<'_>> {
        let mut out = Vec::new();
        for s in &self.setup {
            out.push(StepRef { phase: StepPhase::Setup, scenario: None, group: None, step: s });
        }
        for sc in &self.scenarios {
            for (phase, items) in [(StepPhase::Init, &sc.init), (StepPhase::Main, &sc.steps)] {
                for item in items {
                    match item {
                        FlowItem::Request { step } => out.push(StepRef { phase, scenario: Some(sc), group: None, step }),
                        FlowItem::Group { group } => {
                            for step in &group.steps {
                                out.push(StepRef { phase, scenario: Some(sc), group: Some(group.id.as_str()), step });
                            }
                        }
                        FlowItem::Pause { .. } => {}
                    }
                }
            }
        }
        for s in &self.teardown {
            out.push(StepRef { phase: StepPhase::Teardown, scenario: None, group: None, step: s });
        }
        out
    }

    pub fn active_environment(&self) -> Option<&Environment> {
        self.environments.iter().find(|e| e.id == self.active_env)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StepRef<'a> {
    pub phase: StepPhase,
    pub scenario: Option<&'a Scenario>,
    pub group: Option<&'a str>,
    pub step: &'a RequestStep,
}

model! {
    #[derive(Copy, Eq, Hash)]
    #[serde(rename_all = "snake_case")]
    pub enum StepPhase { Setup, Init, Main, Teardown }
}

// ---------- v1 ----------

/// The v1 format: one request and closed-model load settings.
pub mod legacy {
    use super::*;
    use crate::models::StopCondition;

    #[derive(Debug, Clone, Deserialize)]
    pub struct V1Header {
        pub name: String,
        pub value: String,
        pub enabled: bool,
    }

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum V1BodyKind {
        Json,
        Text,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct V1Body {
        pub kind: V1BodyKind,
        pub content: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct V1Request {
        pub method: Method,
        pub url: String,
        pub headers: Vec<V1Header>,
        pub body: Option<V1Body>,
        pub bearer: Option<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct V1Load {
        pub concurrency: u32,
        pub stop: StopCondition,
        pub rps_cap: Option<u32>,
        pub ramp_up_secs: Option<u32>,
        pub timeout_ms: u32,
        pub success_range: StatusRange,
        pub follow_redirects: bool,
        pub allow_invalid_certs: bool,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct V1TestConfig {
        pub id: String,
        pub name: String,
        pub request: V1Request,
        pub load: V1Load,
        pub created_at: i64,
        pub updated_at: i64,
    }

    /// Request-count runs had no time limit; v2 iterations runs get a generous one.
    const ITERATIONS_MAX_SECS: u32 = 24 * 3600;

    pub fn executor(l: &V1Load) -> Executor {
        let ramp = l.ramp_up_secs.filter(|r| *r > 0);
        match (&l.stop, l.rps_cap) {
            (StopCondition::Requests { count }, _) => {
                Executor::Iterations { vus: l.concurrency, iterations: *count, max_duration_secs: ITERATIONS_MAX_SECS }
            }
            (StopCondition::Duration { secs }, Some(rate)) => match ramp {
                Some(r) => Executor::RampingRate {
                    start: 1,
                    stages: vec![Stage { duration_secs: r, target: rate }, Stage { duration_secs: secs.saturating_sub(r), target: rate }],
                    max_vus: l.concurrency,
                },
                None => Executor::Rate { rate, duration_secs: *secs, max_vus: l.concurrency },
            },
            (StopCondition::Duration { secs }, None) => match ramp {
                Some(r) => Executor::RampingVus {
                    start: 1,
                    stages: vec![
                        Stage { duration_secs: r, target: l.concurrency },
                        Stage { duration_secs: secs.saturating_sub(r), target: l.concurrency },
                    ],
                },
                None => Executor::Vus { vus: l.concurrency, duration_secs: *secs },
            },
        }
    }

    impl From<V1TestConfig> for TestConfig {
        fn from(v: V1TestConfig) -> Self {
            let r = &v.request;
            let mut step = RequestStep::new("r1", r.method.as_str(), r.url.trim());
            step.headers = r.headers.iter().map(|h| KeyValue { name: h.name.clone(), value: h.value.clone(), enabled: h.enabled }).collect();
            step.body = r.body.as_ref().map(|b| BodySpec {
                kind: match b.kind {
                    V1BodyKind::Json => BodyKind::Json,
                    V1BodyKind::Text => BodyKind::Text,
                },
                content: b.content.clone(),
                fields: vec![],
                variables: String::new(),
                file: None,
                content_type: String::new(),
                gzip: false,
            });
            if let Some(t) = r.bearer.as_deref().filter(|t| !t.trim().is_empty()) {
                step.auth = Auth::Bearer { token: t.to_string() };
            }
            let mut sc = Scenario::new("s1", "Main");
            sc.executor = executor(&v.load);
            sc.steps.push(FlowItem::Request { step });
            let mut c = TestConfig::blank(v.id, "");
            c.name = v.name;
            c.created_at = v.created_at;
            c.updated_at = v.updated_at;
            c.defaults.timeout_ms = v.load.timeout_ms;
            c.defaults.success_range = v.load.success_range.clone();
            c.defaults.follow_redirects = v.load.follow_redirects;
            c.connection.allow_invalid_certs = v.load.allow_invalid_certs;
            // v1 had no cookie handling.
            c.cookies.mode = JarMode::Off;
            c.scenarios = vec![sc];
            c
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_files_load_as_single_step_tests() {
        let v1 = r#"{
          "id": "sample", "name": "Mock", "created_at": 1, "updated_at": 2,
          "request": { "method": "POST", "url": "http://127.0.0.1:8787/api", "headers": [{ "name": "Accept", "value": "x", "enabled": true }],
                       "body": { "kind": "json", "content": "{}" }, "bearer": "tok" },
          "load": { "concurrency": 200, "stop": { "kind": "duration", "secs": 20 }, "rps_cap": 500, "ramp_up_secs": 5,
                    "timeout_ms": 1000, "success_range": { "min": 200, "max": 299 }, "follow_redirects": false, "allow_invalid_certs": true }
        }"#;
        let c: TestConfig = serde_json::from_str(v1).unwrap();
        assert_eq!(c.version, FORMAT_VERSION);
        assert_eq!((c.id.as_str(), c.name.as_str(), c.created_at), ("sample", "Mock", 1));
        assert_eq!(c.scenarios.len(), 1);
        let FlowItem::Request { step } = &c.scenarios[0].steps[0] else { panic!() };
        assert_eq!(step.method, "POST");
        assert_eq!(step.auth, Auth::Bearer { token: "tok".into() });
        assert_eq!(step.body.as_ref().unwrap().kind, BodyKind::Json);
        assert_eq!(c.defaults.timeout_ms, 1000);
        assert!(!c.defaults.follow_redirects && c.connection.allow_invalid_certs);
        assert_eq!(
            c.scenarios[0].executor,
            Executor::RampingRate { start: 1, stages: vec![Stage { duration_secs: 5, target: 500 }, Stage { duration_secs: 15, target: 500 }], max_vus: 200 }
        );
        // Round trip through the v2 shape.
        let back: TestConfig = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back, c);
    }

    #[test]
    fn v1_executor_mapping() {
        let base = legacy::V1Load {
            concurrency: 10,
            stop: crate::models::StopCondition::Duration { secs: 30 },
            rps_cap: None,
            ramp_up_secs: None,
            timeout_ms: 1,
            success_range: StatusRange { min: 200, max: 399 },
            follow_redirects: true,
            allow_invalid_certs: false,
        };
        assert_eq!(legacy::executor(&base), Executor::Vus { vus: 10, duration_secs: 30 });
        let l = legacy::V1Load { stop: crate::models::StopCondition::Requests { count: 99 }, ..base.clone() };
        assert!(matches!(legacy::executor(&l), Executor::Iterations { vus: 10, iterations: 99, .. }));
        let l = legacy::V1Load { rps_cap: Some(100), ..base };
        assert_eq!(legacy::executor(&l), Executor::Rate { rate: 100, duration_secs: 30, max_vus: 10 });
    }

    #[test]
    fn redaction_covers_every_secret() {
        let mut c = TestConfig::blank("t", "http://localhost/");
        c.defaults.auth = Auth::Basic { username: "u".into(), password: "pw".into() };
        c.variables.push(Variable { name: "key".into(), secret: true, values: [("e".to_string(), "s3cret".to_string())].into() });
        c.variables.push(Variable { name: "plain".into(), secret: false, values: [("e".to_string(), "keep".to_string())].into() });
        c.connection.proxy.password = "proxy-pw".into();
        if let FlowItem::Request { step } = &mut c.scenarios[0].steps[0] {
            step.headers.push(KeyValue { name: "X-API-Key".into(), value: "k".into(), enabled: true });
            step.cookies.push(KeyValue { name: "sid".into(), value: "abc".into(), enabled: true });
            step.auth = Auth::Bearer { token: "tok".into() };
        }
        let r = serde_json::to_string(&c.redacted()).unwrap();
        for secret in ["pw\"", "s3cret", "proxy-pw", "\"k\"", "abc", "\"tok\""] {
            assert!(!r.contains(secret), "{secret} leaked: {r}");
        }
        assert!(r.contains("keep"));
    }

    #[test]
    fn step_labels() {
        let mut s = RequestStep::new("x", "GET", "https://api.test/users/{{id}}?q=1");
        assert_eq!(s.label(), "GET /users/{{id}}?q=1");
        s.url = "{{baseUrl}}".into();
        assert_eq!(s.label(), "GET {{baseUrl}}");
        s.name = "List users".into();
        assert_eq!(s.label(), "List users");
    }
}
