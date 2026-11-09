//! The load engine: compiles a test into a plan, runs its scenarios' virtual users, and
//! reports snapshots and the run summary.
//!
//! - **Closed model** (`vus`, `ramping_vus`, `iterations`): N virtual users each run an
//!   iteration, then the next. The profile sets N over time.
//! - **Open model** (`rate`, `ramping_rate`): iterations start on a schedule whatever the
//!   target's speed; each takes a free virtual user (up to `max_vus`) or is *dropped*. The first
//!   request of an iteration measures latency from its scheduled start (coordinated-omission
//!   correction); later steps measure from their own send.
//!
//! Stopping: a user Stop, an aborting threshold, a data file running out, or every scenario
//! reaching its end "halts" the run (no new iterations). In-flight iterations get the
//! scenario's graceful stop (or 2 s after a user Stop), then requests still running are
//! cancelled and counted as such.

use crate::cookies::Jar;
use crate::data::{self, Exhausted, Feeder};
use crate::extract::{self, CompiledCheck, CompiledExtractor, CompiledRunIf, Prev, Resp};
use crate::http::{self, BlockedHost, Clients, ClientSettings, Gate, MultipartValue};
use crate::limiter::Profile;
use crate::metrics::{self, percentiles, Aggregator, BottleneckDetector, Event, Outcome, Shape, Shards, StepShape};
use crate::models::*;
use crate::samples::{Intent, Redactor, SamplePolicy, Sampler};
use crate::spec::*;
use crate::template::{self, Template};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
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
    /// Non-loopback hosts the user confirmed.
    pub approved_hosts: HashSet<String>,
    /// Treat RFC 1918 / ULA addresses as local.
    pub private_ok: bool,
    /// Addresses resolved during the pre-run safety check; the run is pinned to them.
    pub pinned: HashMap<String, Vec<SocketAddr>>,
    pub drain_grace: Duration,
    pub tick: Duration,
    /// The test's folder, where data files, certificates and upload files live.
    pub asset_dir: Option<PathBuf>,
    pub sampling: SamplePolicy,
    /// Replace secrets in captured samples with `[redacted]`.
    pub redact: bool,
}

impl RunOptions {
    pub fn new(run_id: impl Into<String>) -> Self {
        RunOptions {
            run_id: run_id.into(),
            limits: Limits::default(),
            approved_hosts: HashSet::new(),
            private_ok: false,
            pinned: HashMap::new(),
            drain_grace: Duration::from_secs(2),
            tick: Duration::from_millis(250),
            asset_dir: None,
            sampling: SamplePolicy::default(),
            redact: true,
        }
    }
}

pub struct RunResult {
    pub summary: RunSummary,
    pub samples: Vec<Sample>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

// ---------- the compiled plan ----------

enum CBody {
    None,
    Text { tpl: Template, ct: String },
    Graphql { q: Template, vars: Template },
    Form { fields: Vec<(Template, Template)> },
    Multipart { fields: Vec<(Template, CPart)> },
    Binary { bytes: Arc<Vec<u8>> },
}

enum CPart {
    Text(Template),
    File(String, Arc<Vec<u8>>),
}

enum CAuth {
    None,
    Bearer(Template),
    Basic(Template, Template),
    ApiKey { name: String, value: Template, query: bool },
}

struct CStep {
    id: String,
    name: String,
    scen: Option<usize>,
    /// Setup/teardown steps aren't part of the run's totals.
    in_totals: bool,
    method: reqwest::Method,
    url: Template,
    params: Vec<(Template, Template)>,
    headers: Vec<(String, Template)>,
    cookies: Vec<(String, Template)>,
    cookie_mode: CookieMode,
    body: CBody,
    content_type: Option<String>,
    gzip: bool,
    auth: CAuth,
    values: Vec<(String, Template)>,
    extract: Vec<CompiledExtractor>,
    checks: Vec<CompiledCheck>,
    run_if: Option<CompiledRunIf>,
    timeout: Duration,
    follow: bool,
    max_redirects: u32,
    max_body: usize,
    needs_body: bool,
    needs_headers: bool,
    weight: u32,
    success: (u16, u16),
}

enum CItem {
    Req(usize),
    Group { steps: Vec<usize>, run_if: Option<CompiledRunIf> },
    Pause { think: ThinkTime, run_if: Option<CompiledRunIf> },
}

struct CScen {
    id: String,
    name: String,
    kind: ScenarioKind,
    init: Vec<CItem>,
    items: Vec<CItem>,
    mix: Vec<(usize, u32)>,
    executor: Executor,
    profile: Profile,
    offset: Duration,
    grace: Duration,
    think: Option<ThinkTime>,
    /// Every iteration is exactly one request (bottleneck detection applies).
    single_request: bool,
}

struct Plan {
    steps: Vec<CStep>,
    setup: Vec<usize>,
    teardown: Vec<usize>,
    scens: Vec<CScen>,
    statics: HashMap<String, String>,
    static_secrets: Vec<String>,
    secret_names: HashSet<String>,
    feeders: Vec<Arc<Feeder>>,
    jar_mode: JarMode,
    clear_each_iteration: bool,
    seed: Vec<SeedCookie>,
    max_timeout_ms: u32,
}

fn invalid(field: impl Into<String>, message: impl Into<String>) -> EngineError {
    EngineError::Invalid(vec![FieldError { field: field.into(), message: message.into() }])
}

fn tpl(field: &str, s: &str) -> Result<Template, EngineError> {
    Template::parse(s).map_err(|e| invalid(field, format!("Template error: {e}")))
}

/// Asset files live directly in the test folder; names never contain path separators.
pub fn read_asset(dir: Option<&PathBuf>, file: &str) -> Result<Vec<u8>, String> {
    if file.is_empty() || file.contains(['/', '\\']) || file.contains("..") {
        return Err(format!("invalid file name {file:?}"));
    }
    let dir = dir.ok_or("this test has no folder yet; save it first")?;
    std::fs::read(dir.join(file)).map_err(|e| format!("{file}: {e}"))
}

fn compile_step(
    st: &RequestStep,
    c: &TestConfig,
    scen: Option<usize>,
    in_totals: bool,
    assets: Option<&PathBuf>,
) -> Result<CStep, EngineError> {
    let id = format!("step:{}", st.id);
    let d = &c.defaults;
    let method = reqwest::Method::from_bytes(st.method.trim().as_bytes()).map_err(|_| invalid(format!("{id}.method"), "invalid method"))?;
    let mut headers: Vec<(String, Template)> = Vec::new();
    for h in d.headers.iter().filter(|h| h.enabled && !h.name.trim().is_empty()) {
        if !st.headers.iter().any(|x| x.enabled && x.name.trim().eq_ignore_ascii_case(h.name.trim())) {
            headers.push((h.name.trim().to_string(), tpl(&id, &h.value)?));
        }
    }
    for h in st.headers.iter().filter(|h| h.enabled && !h.name.trim().is_empty()) {
        headers.push((h.name.trim().to_string(), tpl(&format!("{id}.headers"), &h.value)?));
    }
    if !d.user_agent.trim().is_empty() && !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("user-agent")) {
        headers.push(("User-Agent".into(), tpl(&id, &d.user_agent)?));
    }
    let (mut body, mut ct, mut gzip) = (CBody::None, None, false);
    if let Some(b) = &st.body {
        gzip = b.gzip;
        let field = format!("{id}.body");
        let auto = || http::default_content_type(&b.kind).to_string();
        let chosen = if b.content_type.trim().is_empty() { None } else { Some(b.content_type.trim().to_string()) };
        body = match b.kind {
            BodyKind::Json | BodyKind::Xml | BodyKind::Text | BodyKind::Raw => {
                ct = Some(chosen.unwrap_or_else(auto));
                CBody::Text { tpl: tpl(&field, &b.content)?, ct: String::new() }
            }
            BodyKind::Graphql => {
                ct = Some(chosen.unwrap_or_else(auto));
                CBody::Graphql { q: tpl(&field, &b.content)?, vars: tpl(&field, &b.variables)? }
            }
            BodyKind::Form => {
                ct = Some(chosen.unwrap_or_else(auto));
                let fields = b.fields.iter().filter(|f| f.enabled).map(|f| Ok((tpl(&field, &f.name)?, tpl(&field, &f.value)?))).collect::<Result<_, EngineError>>()?;
                CBody::Form { fields }
            }
            BodyKind::Multipart => {
                let mut fields = Vec::new();
                for f in b.fields.iter().filter(|f| f.enabled) {
                    let part = if f.file {
                        let bytes = read_asset(assets, &f.value).map_err(|e| invalid(&field, e))?;
                        let shown = f.value.split_once('-').map_or(f.value.as_str(), |(_, rest)| rest).to_string();
                        CPart::File(shown, Arc::new(bytes))
                    } else {
                        CPart::Text(tpl(&field, &f.value)?)
                    };
                    fields.push((tpl(&field, &f.name)?, part));
                }
                CBody::Multipart { fields }
            }
            BodyKind::Binary => {
                ct = Some(chosen.unwrap_or_else(auto));
                let bytes = read_asset(assets, b.file.as_deref().unwrap_or_default()).map_err(|e| invalid(&field, e))?;
                CBody::Binary { bytes: Arc::new(bytes) }
            }
        };
        if let CBody::Text { ct: inner, .. } = &mut body {
            inner.clone_from(ct.as_ref().unwrap_or(&String::new()));
        }
    }
    let auth_spec = if st.auth == Auth::Inherit { &d.auth } else { &st.auth };
    let auth = match auth_spec {
        Auth::Inherit | Auth::None => CAuth::None,
        Auth::Bearer { token } => CAuth::Bearer(tpl(&id, token)?),
        Auth::Basic { username, password } => CAuth::Basic(tpl(&id, username)?, tpl(&id, password)?),
        Auth::ApiKey { name, value, location } => CAuth::ApiKey { name: name.trim().to_string(), value: tpl(&id, value)?, query: *location == ApiKeyLocation::Query },
    };
    let extract = st.extract.iter().filter(|e| e.enabled).map(|e| extract::compile_extractor(e).map_err(|m| invalid(format!("{id}.extract.{}", e.id), m))).collect::<Result<Vec<_>, _>>()?;
    let checks = st.checks.iter().filter(|c| c.enabled).map(|c| extract::compile_check(c).map_err(|m| invalid(format!("{id}.checks.{}", c.id), m))).collect::<Result<Vec<_>, _>>()?;
    let reads_body = |r: &extract::Reader| matches!(r, extract::Reader::Json(_) | extract::Reader::Xpath(_) | extract::Reader::Regex(_) | extract::Reader::Body);
    let needs_body = extract.iter().any(|e| reads_body(&e.reader)) || checks.iter().any(|c| reads_body(&c.reader));
    let needs_headers = extract.iter().any(|e| matches!(e.reader, extract::Reader::Header(_) | extract::Reader::Cookie(_)))
        || checks.iter().any(|c| matches!(c.reader, extract::Reader::Header(_)));
    let timeout_ms = st.timeout_ms.unwrap_or(d.timeout_ms);
    Ok(CStep {
        id: st.id.clone(),
        name: st.label(),
        scen,
        in_totals,
        method,
        url: tpl(&format!("{id}.url"), st.url.trim())?,
        params: st.params.iter().filter(|p| p.enabled && !p.name.trim().is_empty()).map(|p| Ok((tpl(&id, &p.name)?, tpl(&id, &p.value)?))).collect::<Result<_, EngineError>>()?,
        headers,
        cookies: st.cookies.iter().filter(|c| c.enabled && !c.name.trim().is_empty()).map(|c| Ok((c.name.trim().to_string(), tpl(&id, &c.value)?))).collect::<Result<_, EngineError>>()?,
        cookie_mode: st.cookie_mode.clone(),
        body,
        content_type: ct,
        gzip,
        auth,
        values: st.values.iter().filter(|v| v.enabled && !v.name.trim().is_empty()).map(|v| Ok((v.name.trim().to_string(), tpl(&id, &v.value)?))).collect::<Result<_, EngineError>>()?,
        extract,
        checks,
        run_if: st.run_if.as_ref().map(|r| extract::compile_run_if(r).map_err(|m| invalid(format!("{id}.run_if"), m))).transpose()?,
        timeout: Duration::from_millis(u64::from(timeout_ms)),
        follow: st.follow_redirects.unwrap_or(d.follow_redirects),
        max_redirects: d.max_redirects,
        max_body: st.max_response_kb.unwrap_or(d.max_response_kb) as usize * 1024,
        needs_body,
        needs_headers,
        weight: st.weight,
        success: (d.success_range.min, d.success_range.max),
    })
}

type AddStep<'a> = dyn FnMut(&RequestStep, Option<usize>, bool) -> Result<usize, EngineError> + 'a;
/// Why a send failed: (kind, status, fd exhausted, message).
type SendError = (ErrorKind, Option<u16>, bool, String, bool);

fn compile(c: &TestConfig, assets: Option<&PathBuf>) -> Result<(Plan, Vec<(String, reqwest::Identity)>), EngineError> {
    let mut steps: Vec<CStep> = Vec::new();
    let mut add = |st: &RequestStep, scen: Option<usize>, in_totals: bool| -> Result<usize, EngineError> {
        steps.push(compile_step(st, c, scen, in_totals, assets)?);
        Ok(steps.len() - 1)
    };
    let setup = c.setup.iter().map(|s| add(s, None, false)).collect::<Result<Vec<_>, _>>()?;
    let mut scens = Vec::new();
    for sc in c.enabled_scenarios() {
        let si = scens.len();
        let items = |list: &[FlowItem], add: &mut AddStep<'_>| -> Result<Vec<CItem>, EngineError> {
            list.iter()
                .map(|it| {
                    Ok(match it {
                        FlowItem::Request { step } => CItem::Req(add(step, Some(si), true)?),
                        FlowItem::Group { group } => CItem::Group {
                            steps: group.steps.iter().map(|s| add(s, Some(si), true)).collect::<Result<_, _>>()?,
                            run_if: group.run_if.as_ref().map(|r| extract::compile_run_if(r).map_err(|m| invalid(format!("group:{}.run_if", group.id), m))).transpose()?,
                        },
                        FlowItem::Pause { pause } => CItem::Pause {
                            think: pause.think.clone(),
                            run_if: pause.run_if.as_ref().map(|r| extract::compile_run_if(r).map_err(|m| invalid(format!("pause:{}.run_if", pause.id), m))).transpose()?,
                        },
                    })
                })
                .collect()
        };
        let init = items(&sc.init, &mut add)?;
        let main = items(&sc.steps, &mut add)?;
        let mix = main.iter().filter_map(|i| if let CItem::Req(s) = i { Some(*s) } else { None }).collect::<Vec<_>>();
        let single_request = match sc.kind {
            ScenarioKind::Mix => true,
            ScenarioKind::Flow => main.len() == 1 && matches!(main[0], CItem::Req(_)) && sc.init.is_empty(),
        };
        scens.push(CScen {
            id: sc.id.clone(),
            name: sc.name.clone(),
            kind: sc.kind.clone(),
            init,
            items: main,
            mix: mix.into_iter().map(|s| (s, 0)).collect(),
            executor: sc.executor.clone(),
            profile: Profile::from_executor(&sc.executor),
            offset: Duration::from_secs(u64::from(sc.start_offset_secs)),
            grace: Duration::from_secs(u64::from(sc.graceful_stop_secs)),
            think: sc.think.clone(),
            single_request,
        });
    }
    let teardown = c.teardown.iter().map(|s| add(s, None, false)).collect::<Result<Vec<_>, _>>()?;
    for sc in &mut scens {
        for m in &mut sc.mix {
            m.1 = steps[m.0].weight.max(1);
        }
    }

    // Environment variables and secrets.
    let mut statics = HashMap::new();
    let mut static_secrets = Vec::new();
    let mut secret_names = HashSet::new();
    if !c.defaults.base_url.trim().is_empty() {
        statics.insert("baseUrl".to_string(), c.defaults.base_url.trim().trim_end_matches('/').to_string());
    }
    for v in &c.variables {
        let value = v.values.get(&c.active_env).cloned().unwrap_or_default();
        if v.secret {
            static_secrets.push(value.clone());
            secret_names.insert(v.name.trim().to_string());
        }
        statics.insert(v.name.trim().to_string(), value);
    }

    // Data files.
    let mut feeders = Vec::new();
    for f in &c.data {
        let bytes = read_asset(assets, &f.file).map_err(|e| invalid(format!("data:{}", f.id), e))?;
        if bytes.len() as u64 > data::MAX_DATA_BYTES {
            return Err(invalid(format!("data:{}", f.id), "the file is over 100 MB"));
        }
        let (table, _, _) = data::parse(&bytes, &f.format, f.has_header).map_err(|e| invalid(format!("data:{}", f.id), e))?;
        for col in &f.secret_columns {
            secret_names.insert(format!("{}.{}", f.name.trim(), col));
        }
        feeders.push(Arc::new(Feeder::new(f.clone(), table, data::fingerprint(&bytes))));
    }

    // Client certificates.
    let mut identities = Vec::new();
    for cert in &c.connection.client_certs {
        let field = format!("connection.cert:{}", cert.id);
        let pem = read_asset(assets, &cert.cert_file).map_err(|e| invalid(&field, e))?;
        let key = if cert.key_file.is_empty() { None } else { Some(read_asset(assets, &cert.key_file).map_err(|e| invalid(&field, e))?) };
        identities.push((cert.id.clone(), http::load_identity(&pem, key.as_deref()).map_err(|e| invalid(&field, e))?));
    }

    let max_timeout_ms = c
        .all_steps()
        .iter()
        .map(|r| r.step.timeout_ms.unwrap_or(c.defaults.timeout_ms))
        .max()
        .unwrap_or(c.defaults.timeout_ms);
    Ok((
        Plan {
            steps,
            setup,
            teardown,
            scens,
            statics,
            static_secrets,
            secret_names,
            feeders,
            jar_mode: c.cookies.mode.clone(),
            clear_each_iteration: c.cookies.clear_each_iteration,
            seed: c.cookies.seed.clone(),
            max_timeout_ms,
        },
        identities,
    ))
}

// ---------- runtime ----------

struct ScenState {
    halt: CancellationToken,
    abort: CancellationToken,
    busy: AtomicU32,
    allocated: AtomicU32,
    peak: AtomicU32,
    started: AtomicBool,
    started_at: Mutex<Option<Instant>>,
}

struct Rt {
    plan: Plan,
    clients: Clients,
    settings: ClientSettings,
    per_vu_pool: bool,
    shards: Shards,
    sampler: Sampler,
    redactor: Redactor,
    globals: RwLock<Arc<HashMap<String, String>>>,
    global_secrets: RwLock<Vec<String>>,
    seq: AtomicU64,
    start: Instant,
    run_id: String,
    halt: CancellationToken,
    abort: CancellationToken,
    in_flight: AtomicU64,
    scen: Vec<ScenState>,
    shared_jar: Option<Arc<Mutex<Jar>>>,
    data_halt: Mutex<Option<String>>,
    exhausted_files: Mutex<Vec<String>>,
    next_vu: AtomicU32,
}

struct Vu {
    id: u32,
    scen: Option<usize>,
    vars: HashMap<String, String>,
    secrets: Vec<String>,
    jar: Option<Arc<Mutex<Jar>>>,
    rng: fastrand::Rng,
    iteration: u64,
    unique_rows: Vec<Option<usize>>,
    clients: Option<Clients>,
    initialized: bool,
    prev: Prev,
    trace: Vec<TraceEntry>,
    globals: Arc<HashMap<String, String>>,
}

impl Vu {
    fn new(rt: &Rt, scen: Option<usize>) -> Result<Vu, Exhausted> {
        let id = rt.next_vu.fetch_add(1, Ordering::Relaxed);
        let jar = match rt.plan.jar_mode {
            JarMode::Off => None,
            JarMode::Shared => rt.shared_jar.clone(),
            JarMode::PerVu => {
                let mut j = Jar::default();
                rt.plan.seed.iter().for_each(|s| j.seed(s));
                Some(Arc::new(Mutex::new(j)))
            }
        };
        let mut unique_rows = Vec::new();
        for f in &rt.plan.feeders {
            // Setup/teardown users read no data rows.
            let unique = f.spec.distribution == Distribution::UniquePerVu && scen.is_some();
            unique_rows.push(if unique { Some(f.row_for_vu(id.saturating_sub(1))?) } else { None });
        }
        let clients = if rt.per_vu_pool { http::build_clients(&ClientSettings { pool_size: 1, ..rt.settings.clone_settings() }).ok() } else { None };
        Ok(Vu {
            id,
            scen,
            vars: HashMap::new(),
            secrets: Vec::new(),
            jar,
            rng: fastrand::Rng::new(),
            iteration: 0,
            unique_rows,
            clients,
            initialized: false,
            prev: Prev::default(),
            trace: Vec::new(),
            globals: rt.globals.read().unwrap().clone(),
        })
    }
}

impl ClientSettings {
    fn clone_settings(&self) -> ClientSettings {
        ClientSettings { conn: self.conn.clone(), pool_size: self.pool_size, gate: self.gate.clone(), identities: self.identities.clone() }
    }
}

struct Scope<'a> {
    local: &'a HashMap<String, String>,
    vu: &'a Vu,
    statics: &'a HashMap<String, String>,
    scenario: &'a str,
    run_id: &'a str,
}

impl template::Scope for Scope<'_> {
    fn lookup(&self, name: &str) -> Option<String> {
        if let Some(v) = self.local.get(name).or_else(|| self.vu.vars.get(name)).or_else(|| self.vu.globals.get(name)).or_else(|| self.statics.get(name)) {
            return Some(v.clone());
        }
        match name {
            "vu.id" => Some(self.vu.id.to_string()),
            "iteration" => Some(self.vu.iteration.to_string()),
            "scenario" => Some(self.scenario.to_string()),
            "run.id" => Some(self.run_id.to_string()),
            _ => None,
        }
    }
}

struct StepResult {
    outcome: StepOutcome,
    status: Option<u16>,
    ok: bool,
    extracted: Vec<(String, String, bool)>,
    skip_rest: bool,
    latency_us: u64,
    note: Option<String>,
}

impl StepResult {
    fn unsent(outcome: StepOutcome, note: String) -> Self {
        StepResult { ok: matches!(outcome, StepOutcome::NotTaken), outcome, status: None, extracted: vec![], skip_rest: false, latency_us: 0, note: Some(note) }
    }
}

fn is_redirect(s: u16) -> bool {
    matches!(s, 301 | 302 | 303 | 307 | 308)
}

impl Rt {
    fn t_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    fn scope_name(&self, scen: Option<usize>) -> &str {
        scen.map_or("setup", |s| self.plan.scens[s].name.as_str())
    }

    fn record(&self, vu: u32, step: usize, o: Outcome) {
        // Setup/teardown requests count for their endpoint only, not the run's totals.
        let in_totals = self.plan.steps[step].in_totals;
        self.shards.with(vu as usize, |s| if in_totals { s.record(step, o) } else { s.record_step_only(step, o) });
    }

    fn event(&self, vu: u32, step: usize, ev: Event) {
        self.shards.event(vu as usize, step, ev);
    }

    fn sample_base(&self, si: usize, vu: &Vu) -> Sample {
        let st = &self.plan.steps[si];
        Sample {
            id: self.sampler.next_id(),
            step_id: st.id.clone(),
            scenario_id: st.scen.map(|s| self.plan.scens[s].id.clone()),
            reason: SampleReason::Random,
            outcome: StepOutcome::Ok,
            error_kind: None,
            error: None,
            t_ms: self.t_ms(),
            vu: vu.id,
            iteration: vu.iteration,
            latency_us: 0,
            raw_us: 0,
            ttfb_us: 0,
            request: None,
            response: None,
            redirects: vec![],
            vars: vec![],
            checks: vec![],
            extracted: vec![],
            trace: vu.trace.clone(),
            branch: st.run_if.as_ref().map(|_| true),
        }
    }

    fn submit(&self, si: usize, vu: &Vu, reason: SampleReason, fail_key: Option<&str>, intent: &Intent, mut sample: Sample) {
        let mut extra: Vec<String> = vu.secrets.clone();
        extra.extend(self.global_secrets.read().unwrap().iter().cloned());
        sample.vars = vu
            .vars
            .iter()
            .chain(vu.globals.iter())
            .map(|(k, v)| {
                let secret = self.plan.secret_names.contains(k);
                KeyValue { name: k.clone(), value: if secret && self.redactor.enabled { REDACTED.to_string() } else { v.clone() }, enabled: true }
            })
            .collect();
        sample.vars.sort_by(|a, b| a.name.cmp(&b.name));
        self.redactor.sample(&mut sample, &extra);
        self.sampler.submit(si, reason, fail_key, intent, sample);
    }

    /// A step that wasn't sent: count it, and keep a few for the analysis.
    fn unsent(&self, si: usize, vu: &mut Vu, outcome: StepOutcome, note: String, ev: Event) -> StepResult {
        self.event(vu.id, si, ev);
        let key = match outcome {
            StepOutcome::Skipped => Some("skipped"),
            StepOutcome::Blocked => Some("blocked"),
            StepOutcome::BuildError => Some("build"),
            _ => None,
        };
        let intent = Intent::default();
        if outcome != StepOutcome::NotTaken || self.sampler.policy.all {
            if let Some(reason) = self.sampler.wants(si, key, 0, &intent) {
                let mut s = self.sample_base(si, vu);
                s.outcome = outcome.clone();
                s.error = Some(note.clone());
                if outcome == StepOutcome::NotTaken {
                    s.branch = Some(false);
                }
                self.submit(si, vu, reason, key, &intent, s);
            }
        }
        StepResult::unsent(outcome, note)
    }

    async fn exec_step(&self, vu: &mut Vu, si: usize, scheduled: Option<Instant>, abort: &CancellationToken) -> StepResult {
        let st = &self.plan.steps[si];
        let scen_name = self.scope_name(st.scen).to_string();
        let mut local: HashMap<String, String> = HashMap::new();
        let seq = &self.seq;

        macro_rules! render {
            ($t:expr) => {{
                let mut rng = std::mem::replace(&mut vu.rng, fastrand::Rng::with_seed(0));
                let r = {
                    let scope = Scope { local: &local, vu: &*vu, statics: &self.plan.statics, scenario: &scen_name, run_id: &self.run_id };
                    $t.render(&mut template::Ctx { scope: &scope, rng: &mut rng, seq })
                };
                vu.rng = rng;
                match r {
                    Ok(s) => s,
                    Err(template::RenderError::Missing(v)) => {
                        let skip = format!("not sent: `{v}` has no value");
                        return self.unsent(si, vu, StepOutcome::Skipped, skip, Event::Skipped);
                    }
                    Err(template::RenderError::Bad(m)) => return self.unsent(si, vu, StepOutcome::BuildError, m, Event::BuildError),
                }
            }};
        }

        if let Some(rule) = &st.run_if {
            let taken = {
                let scope = Scope { local: &local, vu: &*vu, statics: &self.plan.statics, scenario: &scen_name, run_id: &self.run_id };
                extract::eval_run_if(rule, &|n| template::Scope::lookup(&scope, n), vu.prev)
            };
            if !taken {
                return self.unsent(si, vu, StepOutcome::NotTaken, "Run if rule was false".into(), Event::NotTaken);
            }
        }
        for (name, t) in &st.values {
            let v = render!(t);
            local.insert(name.clone(), v);
        }
        let raw_url = render!(st.url);
        let mut url = match url::Url::parse(raw_url.trim()) {
            Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()) => u,
            Ok(_) => return self.unsent(si, vu, StepOutcome::BuildError, format!("not an http(s) URL with a host: {raw_url}"), Event::BuildError),
            Err(e) => return self.unsent(si, vu, StepOutcome::BuildError, format!("invalid URL {raw_url:?}: {e}"), Event::BuildError),
        };
        let mut params = Vec::new();
        for (k, v) in &st.params {
            params.push((render!(k), render!(v)));
        }
        let mut headers: Vec<(String, String)> = Vec::with_capacity(st.headers.len() + 3);
        for (n, v) in &st.headers {
            headers.push((n.clone(), render!(v)));
        }
        match &st.auth {
            CAuth::None => {}
            CAuth::Bearer(t) => {
                let tok = render!(t);
                if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("authorization")) {
                    headers.push(("Authorization".into(), format!("Bearer {}", tok.trim())));
                }
            }
            CAuth::Basic(u, p) => {
                let (u, p) = (render!(u), render!(p));
                if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("authorization")) {
                    headers.push(("Authorization".into(), format!("Basic {}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, format!("{u}:{p}")))));
                }
            }
            CAuth::ApiKey { name, value, query } => {
                let v = render!(value);
                if *query {
                    params.push((name.clone(), v));
                } else {
                    headers.push((name.clone(), v));
                }
            }
        }
        if !params.is_empty() {
            let mut q = url.query_pairs_mut();
            for (k, v) in &params {
                q.append_pair(k, v);
            }
        }
        let mut explicit_cookies = Vec::new();
        for (n, v) in &st.cookies {
            explicit_cookies.push(format!("{n}={}", render!(v)));
        }
        let mut body: Option<Vec<u8>> = match &st.body {
            CBody::None => None,
            CBody::Text { tpl, .. } => Some(render!(tpl).into_bytes()),
            CBody::Graphql { q, vars } => {
                let (q, v) = (render!(q), render!(vars));
                match http::graphql_body(&q, &v) {
                    Ok(b) => Some(b.into_bytes()),
                    Err(e) => return self.unsent(si, vu, StepOutcome::BuildError, e, Event::BuildError),
                }
            }
            CBody::Form { fields } => {
                let mut pairs = Vec::new();
                for (k, v) in fields {
                    pairs.push((render!(k), render!(v)));
                }
                Some(http::urlencoded(&pairs).into_bytes())
            }
            CBody::Multipart { fields } => {
                let mut parts = Vec::new();
                for (k, p) in fields {
                    let name = render!(k);
                    let value = match p {
                        CPart::Text(t) => MultipartValue::Text(render!(t)),
                        CPart::File(n, b) => MultipartValue::File { name: n.clone(), bytes: b.clone() },
                    };
                    parts.push((name, value));
                }
                let boundary = format!("toad-{:016x}", vu.rng.u64(..));
                headers.retain(|(n, _)| !n.eq_ignore_ascii_case("content-type"));
                headers.push(("Content-Type".into(), format!("multipart/form-data; boundary={boundary}")));
                Some(http::multipart(&parts, &boundary))
            }
            CBody::Binary { bytes } => Some(bytes.as_ref().clone()),
        };
        if let Some(ct) = &st.content_type {
            if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("content-type")) {
                headers.push(("Content-Type".into(), ct.clone()));
            }
        }
        if st.gzip {
            if let Some(b) = &body {
                body = Some(http::gzip(b));
                headers.push(("Content-Encoding".into(), "gzip".into()));
            }
        }
        headers.retain(|(n, _)| !n.eq_ignore_ascii_case("content-length"));

        let use_jar = st.cookie_mode != CookieMode::NoJar && vu.jar.is_some();
        if st.cookie_mode == CookieMode::ClearBefore {
            if let Some(j) = &vu.jar {
                j.lock().unwrap().clear();
            }
        }

        // Send, following redirects by hand.
        let start = Instant::now();
        let intended = scheduled.map_or(start, |s| s.min(start));
        let mut method = st.method.clone();
        let mut hops: Vec<Hop> = Vec::new();
        let mut sent_headers: Vec<(String, String)> = Vec::new();
        let client_set = vu.clients.as_ref().unwrap_or(&self.clients).clone();
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        let result: Result<(reqwest::Response, Duration), SendError> = 'send: loop {
            let host = url.host_str().unwrap_or_default().to_string();
            if let Err(BlockedHost(h)) = self.settings.gate.precheck(&host) {
                if hops.is_empty() {
                    self.in_flight.fetch_sub(1, Ordering::Relaxed);
                    return self.unsent(si, vu, StepOutcome::Blocked, format!("{h} is not loopback and wasn't confirmed"), Event::Blocked);
                }
                break 'send Err((ErrorKind::Redirect, None, false, format!("redirect to unconfirmed host {h} blocked"), false));
            }
            let mut hs = headers.clone();
            if use_jar || !explicit_cookies.is_empty() {
                let mut parts = explicit_cookies.clone();
                if use_jar {
                    if let Some(c) = vu.jar.as_ref().and_then(|j| j.lock().unwrap().header_for(&url, now_ms())) {
                        parts.push(c);
                    }
                }
                if !parts.is_empty() {
                    hs.retain(|(n, _)| !n.eq_ignore_ascii_case("cookie"));
                    hs.push(("Cookie".into(), parts.join("; ")));
                }
            }
            let remaining = st.timeout.saturating_sub(start.elapsed()).max(Duration::from_millis(1));
            let mut rb = client_set.for_host(&host).request(method.clone(), url.clone()).timeout(remaining);
            for (n, v) in &hs {
                rb = rb.header(n.as_str(), v.as_str());
            }
            if let Some(b) = &body {
                rb = rb.body(b.clone());
            }
            let req = match rb.build() {
                Ok(r) => r,
                Err(e) => {
                    self.in_flight.fetch_sub(1, Ordering::Relaxed);
                    return self.unsent(si, vu, StepOutcome::BuildError, http::describe(&e), Event::BuildError);
                }
            };
            sent_headers = hs;
            let sent = tokio::select! {
                biased;
                _ = abort.cancelled() => None,
                r = client_set.for_host(&host).execute(req) => Some(r),
            };
            let resp = match sent {
                None => {
                    self.in_flight.fetch_sub(1, Ordering::Relaxed);
                    self.record(vu.id, si, Outcome::Cancelled);
                    return StepResult { outcome: StepOutcome::Cancelled, status: None, ok: false, extracted: vec![], skip_rest: true, latency_us: 0, note: None };
                }
                Some(Ok(r)) => r,
                Some(Err(e)) => {
                    if let Some(h) = http::is_blocked(&e) {
                        if hops.is_empty() {
                            self.in_flight.fetch_sub(1, Ordering::Relaxed);
                            let host = if h.is_empty() { host } else { h };
                            return self.unsent(si, vu, StepOutcome::Blocked, format!("{host} is not loopback and wasn't confirmed"), Event::Blocked);
                        }
                        break 'send Err((ErrorKind::Redirect, None, false, format!("redirect to unconfirmed host {h} blocked"), false));
                    }
                    let (kind, fd) = http::classify(&e);
                    break 'send Err((kind, None, fd, http::describe(&e), true));
                }
            };
            let status = resp.status().as_u16();
            if use_jar {
                if let Some(j) = &vu.jar {
                    let mut jar = j.lock().unwrap();
                    for sc in resp.headers().get_all(reqwest::header::SET_COOKIE) {
                        if let Ok(s) = sc.to_str() {
                            jar.store(&url, s, now_ms());
                        }
                    }
                }
            }
            if st.follow && is_redirect(status) {
                let loc = resp.headers().get(reqwest::header::LOCATION).and_then(|l| l.to_str().ok()).and_then(|l| url.join(l).ok());
                if let Some(next) = loc {
                    if hops.len() as u32 >= st.max_redirects {
                        break 'send Err((ErrorKind::Redirect, Some(status), false, format!("more than {} redirects", st.max_redirects), false));
                    }
                    hops.push(Hop { status, url: url.to_string() });
                    if status == 303 || ((status == 301 || status == 302) && method == reqwest::Method::POST) {
                        method = reqwest::Method::GET;
                        body = None;
                        headers.retain(|(n, _)| !n.eq_ignore_ascii_case("content-type") && !n.eq_ignore_ascii_case("content-encoding"));
                    }
                    if next.host_str() != url.host_str() {
                        headers.retain(|(n, _)| !n.eq_ignore_ascii_case("authorization"));
                    }
                    url = next;
                    continue;
                }
            }
            break 'send Ok((resp, start.elapsed()));
        };

        let fail_key_kind = |k: ErrorKind| format!("{k:?}").to_lowercase();
        let (mut resp, ttfb) = match result {
            Ok(r) => r,
            Err((kind, status, fd, message, _)) => {
                self.in_flight.fetch_sub(1, Ordering::Relaxed);
                self.record(vu.id, si, Outcome::Error { kind, status, bytes: 0, fd_exhausted: fd });
                let key = fail_key_kind(kind);
                let intent = self.sampler.intent(si, true, start.elapsed().as_micros() as u64, &mut vu.rng);
                if let Some(reason) = self.sampler.wants(si, Some(&key), start.elapsed().as_micros() as u64, &intent) {
                    let mut s = self.sample_base(si, vu);
                    s.outcome = StepOutcome::Failed;
                    s.error_kind = Some(kind);
                    s.error = Some(message.clone());
                    s.raw_us = start.elapsed().as_micros() as u64;
                    s.latency_us = s.raw_us;
                    s.redirects = hops;
                    s.request = Some(self.capture_request(st, &url, &method, &sent_headers, body.as_deref()));
                    self.submit(si, vu, reason, Some(&key), &intent, s);
                }
                return StepResult { outcome: StepOutcome::Failed, status, ok: false, extracted: vec![], skip_rest: false, latency_us: 0, note: Some(message) };
            }
        };
        let status = resp.status().as_u16();
        let in_range = (st.success.0..=st.success.1).contains(&status);
        let intent = self.sampler.intent(si, !in_range, ttfb.as_micros() as u64, &mut vu.rng);
        let keep_headers = st.needs_headers || intent.buffer_body || self.sampler.policy.all || !in_range;
        let resp_headers: Vec<(String, String)> = if keep_headers {
            resp.headers().iter().map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect()
        } else {
            Vec::new()
        };
        let cap = if st.needs_body { st.max_body.max(self.sampler.policy.body_bytes) } else if intent.buffer_body { self.sampler.policy.body_bytes } else { 0 };
        let mut buf: Vec<u8> = Vec::new();
        let mut bytes = 0u64;
        let read_err: Option<(ErrorKind, bool, String)> = loop {
            let chunk = tokio::select! {
                biased;
                _ = abort.cancelled() => None,
                c = resp.chunk() => Some(c),
            };
            match chunk {
                None => {
                    self.in_flight.fetch_sub(1, Ordering::Relaxed);
                    self.record(vu.id, si, Outcome::Cancelled);
                    return StepResult { outcome: StepOutcome::Cancelled, status: Some(status), ok: false, extracted: vec![], skip_rest: true, latency_us: 0, note: None };
                }
                Some(Ok(Some(c))) => {
                    bytes += c.len() as u64;
                    if buf.len() < cap {
                        buf.extend_from_slice(&c[..c.len().min(cap - buf.len())]);
                    }
                }
                Some(Ok(None)) => break None,
                Some(Err(e)) => {
                    let (kind, fd) = http::classify(&e);
                    let kind = if kind == ErrorKind::Timeout { kind } else { ErrorKind::BodyRead };
                    break Some((kind, fd, http::describe(&e)));
                }
            }
        };
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
        let end = Instant::now();
        let raw_us = (end - start).as_micros() as u64;
        let corrected_us = (end - intended).as_micros() as u64;
        if let Some((kind, fd, message)) = read_err {
            self.record(vu.id, si, Outcome::Error { kind, status: Some(status), bytes, fd_exhausted: fd });
            let key = fail_key_kind(kind);
            if let Some(reason) = self.sampler.wants(si, Some(&key), raw_us, &intent) {
                let mut s = self.sample_base(si, vu);
                s.outcome = StepOutcome::Failed;
                s.error_kind = Some(kind);
                s.error = Some(message.clone());
                s.raw_us = raw_us;
                s.latency_us = corrected_us;
                s.ttfb_us = ttfb.as_micros() as u64;
                s.redirects = hops;
                s.request = Some(self.capture_request(st, &url, &method, &sent_headers, body.as_deref()));
                self.submit(si, vu, reason, Some(&key), &intent, s);
            }
            return StepResult { outcome: StepOutcome::Failed, status: Some(status), ok: false, extracted: vec![], skip_rest: false, latency_us: corrected_us, note: Some(message) };
        }

        // Checks and extraction.
        let view = Resp::new(status, &resp_headers, &buf, raw_us as f64 / 1000.0);
        let mut check_results = Vec::new();
        let mut check_fail_request = false;
        let mut any_check_failed = false;
        for (i, c) in st.checks.iter().enumerate() {
            let (passed, actual) = extract::run_check(c, &view);
            if !passed {
                any_check_failed = true;
                check_fail_request |= c.spec.fails_request;
                self.event(vu.id, si, Event::CheckFailed(i));
            }
            check_results.push(CheckResult { id: c.spec.id.clone(), label: extract::check_label(&c.spec), passed, actual });
        }
        if any_check_failed {
            self.event(vu.id, si, Event::ChecksFailed);
        }
        let mut extracted = Vec::new();
        let mut extract_results = Vec::new();
        let mut extract_fail_step = false;
        let mut skip_rest = false;
        for (i, e) in st.extract.iter().enumerate() {
            let got = extract::run_extractor(e, &view, &mut vu.rng);
            let (value, error) = match got {
                Ok(Some(v)) => (Some(v), None),
                Ok(None) => (None, Some("nothing matched".to_string())),
                Err(m) => (None, Some(m)),
            };
            let value = match (value, &e.spec.on_missing) {
                (Some(v), _) => Some(v),
                (None, OnMissing::UseDefault) => {
                    self.event(vu.id, si, Event::ExtractFailed(i));
                    Some(e.spec.default.clone())
                }
                (None, OnMissing::FailStep) => {
                    self.event(vu.id, si, Event::ExtractFailed(i));
                    extract_fail_step = true;
                    None
                }
                (None, OnMissing::SkipIteration) => {
                    self.event(vu.id, si, Event::ExtractFailed(i));
                    skip_rest = true;
                    None
                }
            };
            let secret = e.spec.secret || self.plan.secret_names.contains(e.spec.var.trim());
            if let Some(v) = &value {
                extracted.push((e.spec.var.trim().to_string(), v.clone(), secret));
            }
            extract_results.push(ExtractResult { id: e.spec.id.clone(), var: e.spec.var.trim().to_string(), value, secret, error });
        }
        let success = in_range && !check_fail_request && !extract_fail_step;
        let error = if success {
            None
        } else if !in_range {
            Some(ErrorKind::Status)
        } else {
            Some(ErrorKind::Check)
        };
        self.record(vu.id, si, Outcome::Response { status, success, error, corrected_us, raw_us, ttfb_us: ttfb.as_micros() as u64, bytes });

        let fail_key = (!success).then(|| match error {
            Some(ErrorKind::Status) => format!("status:{status}"),
            _ => "check".to_string(),
        });
        if let Some(reason) = self.sampler.wants(si, fail_key.as_deref(), corrected_us, &intent) {
            let mut s = self.sample_base(si, vu);
            s.outcome = if success { StepOutcome::Ok } else { StepOutcome::Failed };
            s.error_kind = error;
            s.error = (!success).then(|| match error {
                Some(ErrorKind::Status) => format!("status {status} is outside the success range {}–{}", st.success.0, st.success.1),
                _ if extract_fail_step => "an extraction found nothing".to_string(),
                _ => "a check failed".to_string(),
            });
            s.latency_us = corrected_us;
            s.raw_us = raw_us;
            s.ttfb_us = ttfb.as_micros() as u64;
            s.redirects = hops;
            s.request = Some(self.capture_request(st, &url, &method, &sent_headers, body.as_deref()));
            let (text, truncated, binary) = if intent.buffer_body || self.sampler.policy.all || st.needs_body {
                http::body_text(&buf, self.sampler.policy.body_bytes)
            } else {
                (String::new(), bytes > 0, false)
            };
            s.response = Some(SampleResponse {
                status,
                headers: resp_headers.iter().map(|(n, v)| KeyValue { name: n.clone(), value: v.clone(), enabled: true }).collect(),
                body: if self.sampler.policy.bodies { text } else { String::new() },
                body_bytes: bytes,
                truncated: truncated || buf.len() as u64 != bytes && !binary,
                binary,
            });
            s.checks = check_results;
            s.extracted = extract_results;
            self.submit(si, vu, reason, fail_key.as_deref(), &intent, s);
        }
        StepResult {
            outcome: if success { StepOutcome::Ok } else { StepOutcome::Failed },
            status: Some(status),
            ok: success,
            extracted,
            skip_rest,
            latency_us: corrected_us,
            note: None,
        }
    }

    fn capture_request(&self, st: &CStep, url: &url::Url, method: &reqwest::Method, headers: &[(String, String)], body: Option<&[u8]>) -> SampleRequest {
        let (text, truncated, binary) = match body {
            Some(b) if self.sampler.policy.bodies => {
                if st.gzip {
                    (format!("{} bytes, gzip-compressed", b.len()), false, true)
                } else {
                    http::body_text(b, self.sampler.policy.body_bytes)
                }
            }
            Some(_) => (String::new(), false, false),
            None => (String::new(), false, false),
        };
        SampleRequest {
            method: method.to_string(),
            url: url.to_string(),
            headers: headers.iter().map(|(n, v)| KeyValue { name: n.clone(), value: v.clone(), enabled: true }).collect(),
            body: text,
            body_bytes: body.map_or(0, |b| b.len() as u64),
            truncated,
            binary,
        }
    }

    fn apply(&self, vu: &mut Vu, si: usize, r: &StepResult) {
        for (k, v, secret) in &r.extracted {
            if *secret && !vu.secrets.contains(v) {
                vu.secrets.push(v.clone());
            }
            vu.vars.insert(k.clone(), v.clone());
        }
        vu.prev = Prev { status: r.status, ok: Some(r.ok) };
        let st = &self.plan.steps[si];
        if vu.trace.len() < 64 {
            vu.trace.push(TraceEntry {
                step_id: st.id.clone(),
                name: st.name.clone(),
                outcome: r.outcome.clone(),
                status: r.status,
                latency_us: r.latency_us,
                t_ms: self.t_ms(),
                note: r.note.clone(),
            });
        }
    }

    /// An extraction ended the iteration: the steps after `after` count as skipped.
    fn skip_remaining(&self, vu: &Vu, items: &[CItem], after: usize) {
        let mut past = false;
        for item in items {
            let steps: Vec<usize> = match item {
                CItem::Req(s) => vec![*s],
                CItem::Group { steps, .. } => steps.clone(),
                CItem::Pause { .. } => vec![],
            };
            for s in steps {
                if past {
                    self.event(vu.id, s, Event::Skipped);
                }
                if s == after {
                    past = true;
                }
            }
        }
    }

    fn rule_holds(&self, vu: &Vu, rule: &Option<CompiledRunIf>) -> bool {
        let Some(rule) = rule else { return true };
        let empty = HashMap::new();
        let scope = Scope { local: &empty, vu, statics: &self.plan.statics, scenario: self.scope_name(vu.scen), run_id: &self.run_id };
        extract::eval_run_if(rule, &|n| template::Scope::lookup(&scope, n), vu.prev)
    }

    async fn think(&self, vu: &mut Vu, t: &ThinkTime, abort: &CancellationToken) {
        let ms = match *t {
            ThinkTime::Fixed { ms } => f64::from(ms),
            ThinkTime::Uniform { min_ms, max_ms } => f64::from(min_ms) + vu.rng.f64() * f64::from(max_ms.saturating_sub(min_ms)),
            ThinkTime::Normal { mean_ms, sd_ms } => {
                // Box–Muller.
                let (u1, u2) = (vu.rng.f64().max(1e-12), vu.rng.f64());
                (f64::from(mean_ms) + f64::from(sd_ms) * (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()).max(0.0)
            }
        };
        tokio::select! {
            _ = abort.cancelled() => {},
            _ = sleep(Duration::from_secs_f64(ms / 1000.0)) => {},
        }
    }

    /// Run a list of items. Returns whether anything failed and whether to stop the iteration.
    async fn run_items(&self, vu: &mut Vu, items: &[CItem], mut scheduled: Option<Instant>, think: Option<&ThinkTime>, abort: &CancellationToken) -> (bool, bool) {
        let mut failed = false;
        for item in items {
            if abort.is_cancelled() {
                return (failed, true);
            }
            match item {
                CItem::Req(si) => {
                    let r = self.exec_step(vu, *si, scheduled.take(), abort).await;
                    failed |= !r.ok;
                    self.apply(vu, *si, &r);
                    if r.outcome == StepOutcome::Cancelled {
                        return (failed, true);
                    }
                    if r.skip_rest {
                        self.skip_remaining(vu, items, *si);
                        return (true, true);
                    }
                    if let (Some(t), StepOutcome::Ok | StepOutcome::Failed) = (think, &r.outcome) {
                        self.think(vu, t, abort).await;
                    }
                }
                CItem::Group { steps, run_if } => {
                    if !self.rule_holds(vu, run_if) {
                        for si in steps {
                            let r = self.unsent(*si, vu, StepOutcome::NotTaken, "group's Run if rule was false".into(), Event::NotTaken);
                            self.apply(vu, *si, &r);
                        }
                        continue;
                    }
                    // Members run concurrently on copies of the virtual user (shared jar), then merge.
                    let sched = scheduled.take();
                    let mut copies: Vec<Vu> = steps
                        .iter()
                        .map(|_| Vu {
                            id: vu.id,
                            scen: vu.scen,
                            vars: vu.vars.clone(),
                            secrets: vu.secrets.clone(),
                            jar: vu.jar.clone(),
                            rng: vu.rng.fork(),
                            iteration: vu.iteration,
                            unique_rows: vec![],
                            clients: vu.clients.clone(),
                            initialized: true,
                            prev: vu.prev,
                            trace: vu.trace.clone(),
                            globals: vu.globals.clone(),
                        })
                        .collect();
                    let futs = copies.iter_mut().zip(steps).map(|(c, si)| self.exec_step(c, *si, sched, abort));
                    let results = futures_util::future::join_all(futs).await;
                    let mut stop = false;
                    for (r, si) in results.iter().zip(steps) {
                        failed |= !r.ok;
                        self.apply(vu, *si, r);
                        stop |= r.outcome == StepOutcome::Cancelled || r.skip_rest;
                    }
                    if stop {
                        return (failed, true);
                    }
                    if let Some(t) = think {
                        self.think(vu, t, abort).await;
                    }
                }
                CItem::Pause { think: t, run_if } => {
                    if self.rule_holds(vu, run_if) {
                        self.think(vu, t, abort).await;
                    }
                }
            }
        }
        (failed, false)
    }

    /// One iteration of a scenario. Returns `Err` when the virtual user (or run) must stop.
    async fn iteration(&self, vu: &mut Vu, si: usize, scheduled: Option<Instant>, abort: &CancellationToken) -> Result<(), Exhausted> {
        let sc = &self.plan.scens[si];
        if !vu.initialized {
            vu.initialized = true;
            if !sc.init.is_empty() {
                vu.trace.clear();
                self.run_items(vu, &sc.init, None, None, abort).await;
            }
        }
        vu.iteration += 1;
        vu.trace.clear();
        vu.prev = Prev::default();
        if self.plan.clear_each_iteration && self.plan.jar_mode == JarMode::PerVu {
            if let Some(j) = &vu.jar {
                let mut jar = j.lock().unwrap();
                jar.clear();
                self.plan.seed.iter().for_each(|s| jar.seed(s));
            }
        }
        for (fi, f) in self.plan.feeders.iter().enumerate() {
            let row = match vu.unique_rows.get(fi).copied().flatten() {
                Some(r) => r,
                None => match f.next_row(&mut vu.rng) {
                    Ok(r) => r,
                    Err(e) => {
                        let mut ex = self.exhausted_files.lock().unwrap();
                        if !ex.contains(&f.spec.name) {
                            ex.push(f.spec.name.clone());
                        }
                        if e == Exhausted::StopRun {
                            self.data_halt.lock().unwrap().get_or_insert_with(|| f.spec.name.clone());
                            self.halt.cancel();
                        }
                        return Err(e);
                    }
                },
            };
            for (k, v) in f.cells(row) {
                if self.plan.secret_names.contains(&k) && !vu.secrets.iter().any(|s| s == v) {
                    vu.secrets.push(v.to_string());
                }
                vu.vars.insert(k, v.to_string());
            }
        }
        let started = Instant::now();
        let failed = match sc.kind {
            ScenarioKind::Flow => self.run_items(vu, &sc.items, scheduled, sc.think.as_ref(), abort).await.0,
            ScenarioKind::Mix => {
                let total: u32 = sc.mix.iter().map(|m| m.1).sum();
                let mut pick = vu.rng.u32(..total.max(1));
                let step = sc.mix.iter().find(|(_, w)| {
                    if pick < *w {
                        true
                    } else {
                        pick -= w;
                        false
                    }
                });
                match step {
                    Some((s, _)) => {
                        let r = self.exec_step(vu, *s, scheduled, abort).await;
                        self.apply(vu, *s, &r);
                        !r.ok
                    }
                    None => false,
                }
            }
        };
        if !abort.is_cancelled() {
            let dur = started.elapsed().as_micros() as u64;
            self.shards.with(vu.id as usize, |s| s.iteration(si, failed, dur));
        }
        Ok(())
    }

    /// Setup / teardown steps, on a dedicated virtual user. Returns an error message on failure.
    async fn run_phase(&self, steps: &[usize], vu: &mut Vu) -> Result<(), String> {
        let abort = self.abort.clone();
        for &si in steps {
            let r = self.exec_step(vu, si, None, &abort).await;
            self.apply(vu, si, &r);
            if !r.ok {
                let st = &self.plan.steps[si];
                let why = r.note.clone().unwrap_or_else(|| r.status.map_or("it failed".into(), |s| format!("status {s}")));
                return Err(format!("{} failed: {why}", st.name));
            }
        }
        Ok(())
    }
}

// ---------- executors ----------

async fn closed_executor(rt: Arc<Rt>, si: usize) {
    let sc = &rt.plan.scens[si];
    let st = &rt.scen[si];
    tokio::select! {
        _ = st.halt.cancelled() => return,
        _ = sleep(sc.offset) => {}
    }
    let start = Instant::now();
    *st.started_at.lock().unwrap() = Some(start);
    st.started.store(true, Ordering::Relaxed);
    let target = Arc::new(AtomicU32::new(0));
    let remaining = Arc::new(AtomicU64::new(match sc.executor {
        Executor::Iterations { iterations, .. } => iterations,
        _ => u64::MAX,
    }));
    let duration = Duration::from_secs_f64(sc.profile.duration());
    let mut set = JoinSet::new();
    let mut spawned = 0u32;
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = st.halt.cancelled() => break,
            _ = tick.tick() => {}
        }
        let t = start.elapsed();
        if t >= duration || remaining.load(Ordering::Relaxed) == 0 {
            break;
        }
        let tgt = sc.profile.value_at(t.as_secs_f64()).round().max(0.0) as u32;
        target.store(tgt, Ordering::Relaxed);
        while spawned < tgt {
            let (rt2, target2, remaining2) = (rt.clone(), target.clone(), remaining.clone());
            let slot = spawned;
            set.spawn(async move { closed_vu(rt2, si, slot, target2, remaining2).await });
            spawned += 1;
        }
        while set.try_join_next().is_some() {}
        if spawned > 0 && set.is_empty() {
            break;
        }
    }
    st.halt.cancel();
    let drained = tokio::time::timeout(sc.grace, async { while set.join_next().await.is_some() {} }).await;
    if drained.is_err() {
        st.abort.cancel();
        while set.join_next().await.is_some() {}
    }
}

async fn closed_vu(rt: Arc<Rt>, si: usize, slot: u32, target: Arc<AtomicU32>, remaining: Arc<AtomicU64>) {
    let st = &rt.scen[si];
    let Ok(mut vu) = Vu::new(&rt, Some(si)) else { return };
    let alloc = st.allocated.fetch_add(1, Ordering::Relaxed) + 1;
    st.peak.fetch_max(alloc, Ordering::Relaxed);
    loop {
        if st.halt.is_cancelled() {
            break;
        }
        if slot >= target.load(Ordering::Relaxed) {
            // Ramped down: idle until the profile wants this virtual user again.
            tokio::select! {
                _ = st.halt.cancelled() => break,
                _ = sleep(Duration::from_millis(50)) => continue,
            }
        }
        if remaining.try_update(Ordering::Relaxed, Ordering::Relaxed, |r| r.checked_sub(1)).is_err() {
            break;
        }
        st.busy.fetch_add(1, Ordering::Relaxed);
        let r = rt.iteration(&mut vu, si, None, &st.abort).await;
        st.busy.fetch_sub(1, Ordering::Relaxed);
        if r.is_err() || st.abort.is_cancelled() {
            break;
        }
    }
    st.allocated.fetch_sub(1, Ordering::Relaxed);
}

async fn open_executor(rt: Arc<Rt>, si: usize) {
    let sc = &rt.plan.scens[si];
    let st = &rt.scen[si];
    tokio::select! {
        _ = st.halt.cancelled() => return,
        _ = sleep(sc.offset) => {}
    }
    let start = Instant::now();
    *st.started_at.lock().unwrap() = Some(start);
    st.started.store(true, Ordering::Relaxed);
    let max_vus = sc.executor.peak_vus();
    // Virtual users come back here after each iteration.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vu>();
    let mut created = 0u32;
    let mut set = JoinSet::new();
    let mut k = 0u64;
    'slots: while let Some(tk) = sc.profile.slot_time(k) {
        let at = start + Duration::from_secs_f64(tk);
        if at > Instant::now() {
            tokio::select! {
                biased;
                _ = st.halt.cancelled() => break,
                _ = sleep_until(at) => {}
            }
        } else if st.halt.is_cancelled() {
            break;
        }
        while set.try_join_next().is_some() {}
        // A free virtual user, a new one, or wait for one. A late iteration keeps its scheduled
        // start, so the wait shows up in corrected latency instead of disappearing.
        let vu = match rx.try_recv() {
            Ok(v) => v,
            Err(_) if created < max_vus => match Vu::new(&rt, Some(si)) {
                Ok(v) => {
                    created += 1;
                    st.allocated.store(created, Ordering::Relaxed);
                    st.peak.fetch_max(created, Ordering::Relaxed);
                    v
                }
                Err(_) => break,
            },
            Err(_) => {
                let deadline = start + Duration::from_secs_f64(sc.profile.duration());
                tokio::select! {
                    biased;
                    _ = st.halt.cancelled() => break 'slots,
                    _ = sleep_until(deadline) => break 'slots,
                    v = rx.recv() => match v { Some(v) => v, None => break 'slots },
                }
            }
        };
        k += 1;
        let (rt2, tx2) = (rt.clone(), tx.clone());
        set.spawn(async move {
            let mut vu = vu;
            let st = &rt2.scen[si];
            st.busy.fetch_add(1, Ordering::Relaxed);
            let r = rt2.iteration(&mut vu, si, Some(at), &st.abort).await;
            st.busy.fetch_sub(1, Ordering::Relaxed);
            if r.is_ok() {
                let _ = tx2.send(vu);
            }
        });
    }
    // Iterations that came due but never got a virtual user.
    let due = sc.profile.slots_by(start.elapsed().as_secs_f64().min(sc.profile.duration())).floor() as u64;
    if due > k && !rt.halt.is_cancelled() {
        rt.shards.with(si, |s| s.dropped(si, due - k));
    }
    st.halt.cancel();
    let drained = tokio::time::timeout(sc.grace, async { while set.join_next().await.is_some() {} }).await;
    if drained.is_err() {
        st.abort.cancel();
        while set.join_next().await.is_some() {}
    }
}

// ---------- building and running ----------

struct Built {
    rt: Arc<Rt>,
    shape: Shape,
}

fn build(config: &TestConfig, opts: &RunOptions, sampling: SamplePolicy) -> Result<Built, EngineError> {
    let (plan, identities) = compile(config, opts.asset_dir.as_ref())?;
    let mut overrides: HashMap<String, Vec<SocketAddr>> = opts.pinned.clone();
    for o in &config.connection.host_overrides {
        let a = o.address.trim();
        let addr = a.parse::<SocketAddr>().or_else(|_| a.parse::<std::net::IpAddr>().map(|ip| SocketAddr::new(ip, 0)));
        if let Ok(addr) = addr {
            overrides.insert(http::normalize_host(o.host.trim()), vec![addr]);
        }
    }
    let proxied = config.connection.proxy.enabled && !config.connection.proxy.address.trim().is_empty();
    let mut approved = opts.approved_hosts.clone();
    // Hosts mapped by an override were checked at their override address.
    for (h, addrs) in &overrides {
        if addrs.iter().all(|a| crate::safety::is_loopback(a.ip())) {
            approved.insert(h.clone());
        }
    }
    let gate = Arc::new(Gate::new(approved, opts.private_ok, overrides, proxied));
    let peak: u32 = plan.scens.iter().map(|s| s.executor.peak_vus()).sum::<u32>().max(1);
    let settings = ClientSettings { conn: config.connection.clone(), pool_size: peak as usize, gate, identities };
    let clients = http::build_clients(&settings).map_err(EngineError::Client)?;
    let shape = Shape {
        steps: plan
            .steps
            .iter()
            .map(|s| StepShape { checks: s.checks.len(), extracts: s.extract.len(), timeout_ms: s.timeout.as_millis().max(1) as u32 })
            .collect(),
        scenarios: plan.scens.len(),
        timeout_ms: plan.max_timeout_ms,
    };
    let mut redactor = Redactor::new(opts.redact);
    for s in &plan.static_secrets {
        redactor.add(s);
    }
    let halt = CancellationToken::new();
    let abort = CancellationToken::new();
    let scen = plan
        .scens
        .iter()
        .map(|_| ScenState {
            halt: halt.child_token(),
            abort: abort.child_token(),
            busy: AtomicU32::new(0),
            allocated: AtomicU32::new(0),
            peak: AtomicU32::new(0),
            started: AtomicBool::new(false),
            started_at: Mutex::new(None),
        })
        .collect();
    let shared_jar = (plan.jar_mode == JarMode::Shared).then(|| {
        let mut j = Jar::default();
        plan.seed.iter().for_each(|s| j.seed(s));
        Arc::new(Mutex::new(j))
    });
    let per_vu_pool = config.connection.pool == PoolMode::PerVu;
    let shards = Shards::new(metrics::shard_count(peak), &shape);
    let sampler = Sampler::new(sampling, plan.steps.len());
    Ok(Built {
        rt: Arc::new(Rt {
            plan,
            clients,
            settings,
            per_vu_pool,
            shards,
            sampler,
            redactor,
            globals: RwLock::new(Arc::new(HashMap::new())),
            global_secrets: RwLock::new(Vec::new()),
            seq: AtomicU64::new(0),
            start: Instant::now(),
            run_id: opts.run_id.clone(),
            halt,
            abort,
            in_flight: AtomicU64::new(0),
            scen,
            shared_jar,
            data_halt: Mutex::new(None),
            exhausted_files: Mutex::new(Vec::new()),
            next_vu: AtomicU32::new(1),
        }),
        shape,
    })
}

/// Run setup steps and publish their extracted values to every virtual user.
async fn setup(rt: &Rt) -> Result<(), String> {
    if rt.plan.setup.is_empty() {
        return Ok(());
    }
    let mut vu = Vu::new(rt, None).map_err(|_| "a data file is empty".to_string())?;
    vu.id = 0;
    let r = rt.run_phase(&rt.plan.setup, &mut vu).await;
    *rt.global_secrets.write().unwrap() = vu.secrets.clone();
    *rt.globals.write().unwrap() = Arc::new(vu.vars);
    r
}

#[derive(Debug, Clone, PartialEq)]
enum HaltCause {
    User,
    Natural,
    Threshold(String),
}

fn scope_label(c: &TestConfig, scope: &str) -> String {
    if let Some(id) = scope.strip_prefix("scenario:") {
        c.scenarios.iter().find(|s| s.id == id).map_or(id.to_string(), |s| s.name.clone())
    } else if let Some(id) = scope.strip_prefix("step:") {
        c.all_steps().iter().find(|r| r.step.id == id).map_or(id.to_string(), |r| r.step.label())
    } else {
        String::new()
    }
}

pub fn threshold_label(c: &TestConfig, t: &Threshold) -> String {
    let unit = match t.metric {
        ThresholdMetric::P50 | ThresholdMetric::P90 | ThresholdMetric::P95 | ThresholdMetric::P99 | ThresholdMetric::Max => " ms",
        ThresholdMetric::ErrorRate | ThresholdMetric::CheckPassRate => "%",
        ThresholdMetric::Rps => " rps",
        ThresholdMetric::Dropped => "",
    };
    let scope = scope_label(c, &t.scope);
    let base = format!("{} {} {}{unit}", t.metric.label(), t.op.symbol(), t.value);
    if scope.is_empty() { base } else { format!("{base} · {scope}") }
}

/// Observed value of a threshold's metric over the verdict view, or None with too little data.
fn observe(t: &Threshold, rt: &Rt, agg: &Aggregator, elapsed_s: f64) -> Option<f64> {
    let steps: Vec<usize> = if let Some(id) = t.scope.strip_prefix("step:") {
        rt.plan.steps.iter().position(|s| s.id == id).into_iter().collect()
    } else if let Some(id) = t.scope.strip_prefix("scenario:") {
        let si = rt.plan.scens.iter().position(|s| s.id == id)?;
        (0..rt.plan.steps.len()).filter(|&i| rt.plan.steps[i].scen == Some(si)).collect()
    } else {
        vec![]
    };
    let whole = t.scope.is_empty();
    let (completed, failed, check_failures) = if whole {
        let cf: u64 = agg.steps.iter().zip(&rt.plan.steps).filter(|(_, s)| s.in_totals).map(|(a, _)| a.verdict.extra.check_failures).sum();
        (agg.verdict_counts.completed(), agg.verdict_counts.failed, cf)
    } else {
        steps.iter().fold((0, 0, 0), |(c, f, k), &i| {
            let v = &agg.steps[i].verdict;
            (c + v.counts.completed(), f + v.counts.failed, k + v.extra.check_failures)
        })
    };
    let latency = |q: f64| -> Option<f64> {
        let h = if whole {
            agg.verdict.corrected.clone()
        } else {
            let mut h = metrics::new_histogram_sig(600_000_000, 2);
            for &i in &steps {
                let _ = h.add(&agg.steps[i].verdict.hists.corrected);
            }
            h
        };
        if h.is_empty() {
            return None;
        }
        Some(if q >= 1.0 { h.max() } else { h.value_at_quantile(q) } as f64 / 1000.0)
    };
    match t.metric {
        ThresholdMetric::P50 => latency(0.5),
        ThresholdMetric::P90 => latency(0.9),
        ThresholdMetric::P95 => latency(0.95),
        ThresholdMetric::P99 => latency(0.99),
        ThresholdMetric::Max => latency(1.0),
        ThresholdMetric::ErrorRate => (completed > 0).then(|| failed as f64 * 100.0 / completed as f64),
        ThresholdMetric::CheckPassRate => (completed > 0).then(|| (completed - check_failures.min(completed)) as f64 * 100.0 / completed as f64),
        ThresholdMetric::Rps => (elapsed_s > 0.5).then(|| completed as f64 / elapsed_s),
        ThresholdMetric::Dropped => {
            let d = if let Some(id) = t.scope.strip_prefix("scenario:") {
                rt.plan.scens.iter().position(|s| s.id == id).map_or(0, |i| agg.scens[i].cumulative.dropped)
            } else {
                agg.scens.iter().map(|s| s.cumulative.dropped).sum()
            };
            Some(d as f64)
        }
    }
}

fn outcome_counts(rt: &Rt, agg: &Aggregator) -> OutcomeCounts {
    let mut o = OutcomeCounts::default();
    for (a, st) in agg.steps.iter().zip(&rt.plan.steps) {
        if !st.in_totals {
            continue;
        }
        let e = &a.cumulative.extra;
        o.skipped += e.skipped;
        o.not_taken += e.not_taken;
        o.blocked += e.blocked;
        o.build_errors += e.build_errors;
        o.check_failures += e.check_failures;
        o.extract_failures += e.extract_failures;
    }
    for s in &agg.scens {
        o.iterations += s.cumulative.iterations;
        o.iterations_failed += s.cumulative.iterations_failed;
        o.dropped += s.cumulative.dropped;
    }
    o
}

fn push_unique(v: &mut Vec<Warning>, w: Warning) {
    if !v.contains(&w) {
        v.push(w);
    }
}

/// Run a load test to completion. `on_snapshot` is called every `opts.tick` and once more
/// with the final state. Pre-flight problems (invalid config, missing files, client build)
/// are returned as errors; everything after that is reported in the summary.
pub async fn run<F>(config: TestConfig, opts: RunOptions, stop: CancellationToken, mut on_snapshot: F) -> Result<RunResult, EngineError>
where
    F: FnMut(Snapshot) + Send,
{
    let errors = crate::validate::validate(&config, opts.limits);
    if !errors.is_empty() {
        return Err(EngineError::Invalid(errors));
    }
    let Built { rt, shape } = build(&config, &opts, opts.sampling)?;
    let started_at = now_ms();
    let mut agg = Aggregator::new(&shape);
    let mut seen: Vec<Warning> = Vec::new();
    let blank_snapshot = |phase: Phase, rt: &Rt| Snapshot {
        run_id: rt.run_id.clone(),
        t_ms: rt.t_ms(),
        phase,
        total: 0, ok: 0, failed: 0, cancelled: 0,
        in_flight: rt.in_flight.load(Ordering::Relaxed),
        active_workers: 0,
        bytes: 0,
        rps_interval: 0.0,
        target_rps: None,
        lat_interval: Percentiles::default(),
        lat_interval_raw: Percentiles::default(),
        lat_cumulative: Percentiles::default(),
        lat_cumulative_raw: Percentiles::default(),
        status_counts: vec![],
        error_counts: vec![],
        second: None,
        warnings: vec![],
        outcomes: OutcomeCounts::default(),
        endpoints: vec![],
        scenarios: vec![],
        thresholds: vec![],
    };

    // Setup.
    let mut setup_error = None;
    if !rt.plan.setup.is_empty() {
        on_snapshot(blank_snapshot(Phase::Setup, &rt));
        let s = tokio::select! {
            _ = stop.cancelled() => Err("stopped during setup".to_string()),
            r = setup(&rt) => r,
        };
        if let Err(e) = s {
            setup_error = Some(e);
        }
    }

    let load_start = Instant::now();
    let mut halted: Option<HaltCause> = None;
    let mut grace_at: Option<Instant> = None;
    let mut crossed: HashMap<String, u64> = HashMap::new();
    let mut detector = BottleneckDetector::default();
    let mut detector_warning: Option<Warning> = None;
    let mut lag_until: Option<Instant> = None;
    let open_single = rt.plan.scens.iter().all(|s| s.single_request) && rt.plan.scens.iter().any(|s| s.executor.is_open());
    let any_open = rt.plan.scens.iter().any(|s| s.executor.is_open());

    if setup_error.is_none() {
        let mut execs = JoinSet::new();
        for si in 0..rt.plan.scens.len() {
            let rt2 = rt.clone();
            if rt.plan.scens[si].executor.is_open() {
                execs.spawn(open_executor(rt2, si));
            } else {
                execs.spawn(closed_executor(rt2, si));
            }
        }
        let mut ticker = tokio::time::interval_at(load_start + opts.tick, opts.tick);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut last_tick = load_start;
        let mut last_second = load_start;
        let mut next_second: u32 = 1;
        let base_t = rt.start.elapsed().as_secs_f64() - load_start.elapsed().as_secs_f64();
        let warmup = f64::from(config.warmup_secs);
        let mut panic_msg: Option<String> = None;

        loop {
            tokio::select! {
                biased;
                joined = execs.join_next() => match joined {
                    None => break,
                    Some(Err(e)) if e.is_panic() => {
                        panic_msg.get_or_insert_with(|| format!("a scenario panicked: {e}"));
                        rt.halt.cancel();
                    }
                    Some(_) => {}
                },
                _ = stop.cancelled(), if halted.is_none() => {
                    halted = Some(HaltCause::User);
                    rt.halt.cancel();
                    grace_at = Some(Instant::now() + opts.drain_grace);
                }
                _ = async { sleep_until(grace_at.unwrap_or_else(Instant::now)).await }, if grace_at.is_some() && !rt.abort.is_cancelled() => {
                    rt.abort.cancel();
                }
                due = ticker.tick() => {
                    let now = Instant::now();
                    if now.duration_since(due) > Duration::from_millis(50) {
                        lag_until = Some(now + Duration::from_secs(2));
                        push_unique(&mut seen, Warning::SchedulerLag);
                    }
                    let t_load = now.duration_since(load_start).as_secs_f64();
                    agg.collect(&rt.shards, t_load >= warmup);
                    let phase = if rt.halt.is_cancelled() { Phase::Stopping } else {
                        let ramping = rt.plan.scens.iter().any(|s| matches!(s.executor, Executor::RampingVus { .. } | Executor::RampingRate { .. }) && t_load < s.profile.points().get(1).map_or(0.0, |p| p.0));
                        if ramping { Phase::Ramping } else { Phase::Running }
                    };
                    let vus: u32 = rt.scen.iter().map(|s| s.busy.load(Ordering::Relaxed)).sum();
                    for (a, st) in agg.scens.iter_mut().zip(&rt.scen) {
                        a.vus_now = st.busy.load(Ordering::Relaxed);
                    }
                    let mut second = None;
                    if t_load >= f64::from(next_second) {
                        let point = agg.close_second(next_second, now.duration_since(last_second).as_secs_f64(), vus);
                        last_second = now;
                        next_second += 1;
                        detector_warning = None;
                        if open_single && phase == Phase::Running && t_load >= 2.0 {
                            let target: f64 = rt.plan.scens.iter().map(|s| if s.executor.is_open() { s.profile.value_at(t_load - 0.5) } else { 0.0 }).sum();
                            let conc: u32 = rt.plan.scens.iter().map(|s| s.executor.peak_vus()).sum();
                            detector_warning = detector.observe(&point, target, conc);
                        }
                        if let Some(w) = &detector_warning {
                            push_unique(&mut seen, w.clone());
                        }
                        second = Some(point);
                        // Thresholds, once a second.
                        for th in config.thresholds.iter().filter(|t| t.enabled) {
                            if let Some(v) = observe(th, &rt, &agg, (t_load - warmup).max(0.0)) {
                                if !th.op.holds(v, th.value) {
                                    crossed.entry(th.id.clone()).or_insert((t_load * 1000.0) as u64);
                                    if th.abort && t_load >= f64::from(th.delay_secs) && t_load >= warmup && halted.is_none() {
                                        halted = Some(HaltCause::Threshold(th.id.clone()));
                                        rt.halt.cancel();
                                        grace_at = Some(Instant::now() + opts.drain_grace);
                                    }
                                }
                            }
                        }
                    }
                    if agg.interval_counts.fd_exhausted {
                        push_unique(&mut seen, Warning::FdLimit);
                    }
                    if rt.data_halt.lock().unwrap().is_some() && halted.is_none() {
                        halted = Some(HaltCause::Natural);
                        grace_at = Some(Instant::now() + opts.drain_grace);
                    }
                    let mut warnings = Vec::new();
                    if seen.contains(&Warning::FdLimit) {
                        warnings.push(Warning::FdLimit);
                    }
                    if lag_until.is_some_and(|u| now < u) {
                        warnings.push(Warning::SchedulerLag);
                    }
                    warnings.extend(detector_warning.clone());
                    for (i, s) in agg.scens.iter().enumerate() {
                        if s.cumulative.dropped > 0 {
                            warnings.push(Warning::DroppedIterations { scenario: rt.plan.scens[i].name.clone(), count: s.cumulative.dropped });
                        }
                    }
                    let elapsed = now.duration_since(last_tick).as_secs_f64().max(1e-3);
                    last_tick = now;
                    let snap = live_snapshot(&rt, &config, &agg, base_t + t_load, t_load, phase, elapsed, second, warnings, &crossed, warmup, !halted.is_some() && any_open);
                    on_snapshot(snap);
                }
            }
        }
        if let Some(p) = panic_msg {
            setup_error.get_or_insert(p);
        }
        // Final drain of whatever was recorded since the last tick.
        let end = Instant::now();
        let t_load = end.duration_since(load_start).as_secs_f64();
        agg.collect(&rt.shards, t_load >= warmup);
        if agg.second_has_data() {
            agg.close_tail(next_second, end.duration_since(last_second).as_secs_f64(), 0);
        }
    }


    // Teardown.
    if !rt.plan.teardown.is_empty() && setup_error.is_none() {
        on_snapshot(blank_snapshot(Phase::Teardown, &rt));
        let mut vu = Vu::new(&rt, None).expect("setup/teardown users read no data");
        vu.id = 0;
        vu.globals = rt.globals.read().unwrap().clone();
        if let Err(e) = rt.run_phase(&rt.plan.teardown, &mut vu).await {
            setup_error.get_or_insert(format!("Teardown: {e}"));
        }
        agg.collect(&rt.shards, true);
    }

    let t = rt.start.elapsed().as_secs_f64();
    let load_t = load_start.elapsed().as_secs_f64();
    for name in rt.exhausted_files.lock().unwrap().iter() {
        push_unique(&mut seen, Warning::DataExhausted { file: name.clone() });
    }
    for (i, s) in agg.scens.iter().enumerate() {
        if s.cumulative.dropped > 0 {
            push_unique(&mut seen, Warning::DroppedIterations { scenario: rt.plan.scens[i].name.clone(), count: s.cumulative.dropped });
        }
    }
    let failed_run = setup_error.is_some() && agg.cumulative_counts.completed() == 0;
    let end_reason = match (&halted, failed_run) {
        (_, true) => EndReason::Failed,
        (Some(HaltCause::User), _) => EndReason::Stopped,
        (Some(HaltCause::Threshold(_)), _) => EndReason::Aborted,
        _ => EndReason::Completed,
    };
    let aborted_by = match &halted {
        Some(HaltCause::Threshold(id)) => config.thresholds.iter().find(|t| &t.id == id).map(|t| threshold_label(&config, t)),
        _ => None,
    };
    let warmup = f64::from(config.warmup_secs);
    let verdict: Vec<ThresholdResult> = config
        .thresholds
        .iter()
        .filter(|t| t.enabled)
        .map(|th| {
            let v = observe(th, &rt, &agg, (load_t - warmup).max(0.0));
            ThresholdResult {
                id: th.id.clone(),
                label: threshold_label(&config, th),
                observed: v.unwrap_or(0.0),
                passed: v.is_none_or(|v| th.op.holds(v, th.value)),
                crossed_at_ms: crossed.get(&th.id).copied(),
                pending: v.is_none(),
            }
        })
        .collect();

    let final_phase = if end_reason == EndReason::Failed { Phase::Failed } else { Phase::Done };
    on_snapshot(live_snapshot(&rt, &config, &agg, t, load_t, final_phase, 1.0, None, seen.clone(), &crossed, warmup, false));

    let c = agg.cumulative_counts.clone();
    let (lat_c, lat_r, lat_t) = (percentiles(&agg.cumulative.corrected), percentiles(&agg.cumulative.raw), percentiles(&agg.cumulative.ttfb));
    let refs = step_refs(&config);
    let mut endpoints = Vec::new();
    for (i, st) in rt.plan.steps.iter().enumerate() {
        let r = &refs[i];
        let a = &mut agg.steps[i];
        let cum = &a.cumulative;
        let e = &cum.extra;
        endpoints.push(EndpointSummary {
            step_id: st.id.clone(),
            name: st.name.clone(),
            phase: r.0,
            scenario_id: st.scen.map(|s| rt.plan.scens[s].id.clone()),
            group_id: r.1.clone(),
            method: st.method.to_string(),
            url: r.2.clone(),
            totals: Totals {
                total: cum.counts.completed(),
                ok: cum.counts.ok,
                failed: cum.counts.failed,
                cancelled: cum.counts.cancelled,
                status_counts: cum.counts.status_counts(),
                error_counts: cum.counts.error_counts(),
            },
            outcomes: OutcomeCounts {
                skipped: e.skipped,
                not_taken: e.not_taken,
                blocked: e.blocked,
                build_errors: e.build_errors,
                check_failures: e.check_failures,
                extract_failures: e.extract_failures,
                ..Default::default()
            },
            check_failures: st.checks.iter().zip(&e.checks).filter(|(_, n)| **n > 0).map(|(c, n)| RuleCount { id: c.spec.id.clone(), count: *n }).collect(),
            extract_failures: st.extract.iter().zip(&e.extracts).filter(|(_, n)| **n > 0).map(|(x, n)| RuleCount { id: x.spec.id.clone(), count: *n }).collect(),
            latency: percentiles(&cum.hists.corrected),
            latency_raw: percentiles(&cum.hists.raw),
            ttfb: percentiles(&cum.hists.ttfb),
            bytes: cum.counts.bytes,
            spectrum: metrics::spectrum(&cum.hists.corrected),
            series: std::mem::take(&mut a.series),
        });
    }
    let scenarios = rt
        .plan
        .scens
        .iter()
        .zip(&agg.scens)
        .zip(&rt.scen)
        .map(|((sc, a), st)| ScenarioSummary {
            id: sc.id.clone(),
            name: sc.name.clone(),
            iterations: a.cumulative.iterations,
            iterations_failed: a.cumulative.iterations_failed,
            dropped: a.cumulative.dropped,
            peak_vus: st.peak.load(Ordering::Relaxed),
            iteration_duration: percentiles(&a.cumulative.duration),
            open_model: sc.executor.is_open(),
            series: a.series.clone(),
        })
        .collect();
    let outcomes = outcome_counts(&rt, &agg);
    let env = RunEnv {
        toad_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        cores: std::thread::available_parallelism().map_or(0, |n| n.get() as u32),
        environment: config.active_environment().map(|e| e.name.clone()).unwrap_or_default(),
        proxied: config.connection.proxy.enabled,
        data_files: rt.plan.feeders.iter().map(|f| DataFileInfo { name: f.spec.name.clone(), rows: f.len() as u64, hash: f.hash.clone() }).collect(),
    };
    let series = std::mem::take(&mut agg.series);
    drop(agg);
    let samples_info = rt.sampler.info();
    let rt = match Arc::try_unwrap(rt) {
        Ok(rt) => rt,
        Err(_) => return Err(EngineError::Client("internal: run state still shared after the run".into())),
    };
    let samples = rt.sampler.into_samples();
    let summary = RunSummary {
        run_id: opts.run_id.clone(),
        config,
        started_at,
        ended_at: now_ms(),
        end_reason,
        error: setup_error,
        totals: Totals { total: c.completed(), ok: c.ok, failed: c.failed, cancelled: c.cancelled, status_counts: c.status_counts(), error_counts: c.error_counts() },
        latency_corrected: lat_c,
        latency_raw: lat_r,
        ttfb: lat_t,
        duration_ms: (load_t * 1000.0).round() as u64,
        achieved_rps: if load_t > 0.0 { c.completed() as f64 / load_t } else { 0.0 },
        bytes: c.bytes,
        capped: any_open,
        warnings: seen,
        series,
        outcomes,
        endpoints,
        scenarios,
        verdict,
        aborted_by,
        env,
        samples: SamplesInfo { count: samples.len() as u64, ..samples_info },
        legacy: false,
    };
    Ok(RunResult { summary, samples })
}

/// (phase, group id, url template) for each compiled step, in plan order.
fn step_refs(c: &TestConfig) -> Vec<(StepPhase, Option<String>, String)> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<_>, phase: StepPhase, group: Option<&str>, s: &RequestStep| out.push((phase, group.map(str::to_string), s.url.clone()));
    for s in &c.setup {
        push(&mut out, StepPhase::Setup, None, s);
    }
    for sc in c.enabled_scenarios() {
        for (phase, items) in [(StepPhase::Init, &sc.init), (StepPhase::Main, &sc.steps)] {
            for item in items {
                match item {
                    FlowItem::Request { step } => push(&mut out, phase, None, step),
                    FlowItem::Group { group } => group.steps.iter().for_each(|s| push(&mut out, phase, Some(&group.id), s)),
                    FlowItem::Pause { .. } => {}
                }
            }
        }
    }
    for s in &c.teardown {
        push(&mut out, StepPhase::Teardown, None, s);
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn live_snapshot(
    rt: &Rt,
    config: &TestConfig,
    agg: &Aggregator,
    t: f64,
    t_load: f64,
    phase: Phase,
    interval_s: f64,
    second: Option<SecondPoint>,
    warnings: Vec<Warning>,
    crossed: &HashMap<String, u64>,
    warmup: f64,
    show_target: bool,
) -> Snapshot {
    let c = &agg.cumulative_counts;
    let scen_t = |i: usize| rt.scen[i].started_at.lock().unwrap().map_or(0.0, |s| s.elapsed().as_secs_f64());
    let target_rps: f64 = rt
        .plan
        .scens
        .iter()
        .enumerate()
        .filter(|(i, s)| s.executor.is_open() && rt.scen[*i].started.load(Ordering::Relaxed))
        .map(|(i, s)| s.profile.value_at(scen_t(i)))
        .sum();
    let endpoints = rt
        .plan
        .steps
        .iter()
        .zip(&agg.steps)
        .map(|(st, a)| {
            let iv = percentiles(&a.interval.hists.corrected);
            EndpointLive {
                step_id: st.id.clone(),
                total: a.cumulative.counts.completed(),
                failed: a.cumulative.counts.failed,
                rps: a.interval.counts.completed() as f64 / interval_s.max(1e-3),
                p95: iv.p95,
                p99: iv.p99,
                p99_run: percentiles(&a.cumulative.hists.corrected).p99,
                skipped: a.cumulative.extra.skipped,
                not_taken: a.cumulative.extra.not_taken,
            }
        })
        .collect();
    let scenarios = rt
        .plan
        .scens
        .iter()
        .enumerate()
        .map(|(i, s)| ScenarioLive {
            id: s.id.clone(),
            vus: rt.scen[i].busy.load(Ordering::Relaxed),
            iterations: agg.scens[i].cumulative.iterations,
            dropped: agg.scens[i].cumulative.dropped,
            target: if rt.scen[i].started.load(Ordering::Relaxed) { s.profile.value_at(scen_t(i)) } else { 0.0 },
        })
        .collect();
    let thresholds = config
        .thresholds
        .iter()
        .filter(|th| th.enabled)
        .map(|th| {
            let v = if t_load >= warmup { observe(th, rt, agg, (t_load - warmup).max(0.0)) } else { None };
            ThresholdResult {
                id: th.id.clone(),
                label: threshold_label(config, th),
                observed: v.unwrap_or(0.0),
                passed: v.is_none_or(|v| th.op.holds(v, th.value)),
                crossed_at_ms: crossed.get(&th.id).copied(),
                pending: v.is_none(),
            }
        })
        .collect();
    Snapshot {
        run_id: rt.run_id.clone(),
        t_ms: (t * 1000.0).round() as u64,
        phase,
        total: c.completed(),
        ok: c.ok,
        failed: c.failed,
        cancelled: c.cancelled,
        in_flight: rt.in_flight.load(Ordering::Relaxed),
        active_workers: rt.scen.iter().map(|s| s.allocated.load(Ordering::Relaxed)).sum(),
        bytes: c.bytes,
        rps_interval: agg.interval_counts.completed() as f64 / interval_s.max(1e-3),
        target_rps: show_target.then_some(target_rps),
        lat_interval: percentiles(&agg.interval.corrected),
        lat_interval_raw: percentiles(&agg.interval.raw),
        lat_cumulative: percentiles(&agg.cumulative.corrected),
        lat_cumulative_raw: percentiles(&agg.cumulative.raw),
        status_counts: c.status_counts(),
        error_counts: c.error_counts(),
        second,
        warnings,
        outcomes: outcome_counts(rt, agg),
        endpoints,
        scenarios,
        thresholds,
    }
}

// ---------- Try once / Send once ----------

/// Run setup, each scenario's per-user init, and one iteration of each enabled scenario (or
/// just `scenario`), capturing every request. Mix scenarios send each of their steps once.
pub async fn try_flow(config: &TestConfig, opts: &RunOptions, scenario: Option<&str>) -> Result<TryResult, EngineError> {
    let mut c = config.clone();
    if let Some(id) = scenario {
        for s in &mut c.scenarios {
            s.enabled = s.id == id;
        }
    }
    // Try once ignores the load profile, so only the test's structure must be valid.
    let errors: Vec<FieldError> = crate::validate::validate(&c, Limits { max_concurrency: u32::MAX, max_rps: u32::MAX })
        .into_iter()
        .filter(|e| !e.field.ends_with(".load") && e.field != "name")
        .collect();
    if !errors.is_empty() {
        return Err(EngineError::Invalid(errors));
    }
    let Built { rt, .. } = build(&c, opts, SamplePolicy::capture_all())?;
    let mut error = None;
    if let Err(e) = setup(&rt).await {
        error = Some(format!("Setup: {e}"));
    }
    let mut last_vars = HashMap::new();
    if error.is_none() {
        let abort = CancellationToken::new();
        for si in 0..rt.plan.scens.len() {
            let mut vu = match Vu::new(&rt, Some(si)) {
                Ok(v) => v,
                Err(_) => {
                    error = Some("a data file has no row for this virtual user".into());
                    break;
                }
            };
            let sc = &rt.plan.scens[si];
            match sc.kind {
                ScenarioKind::Flow => {
                    if rt.iteration(&mut vu, si, None, &abort).await.is_err() {
                        error = Some("a data file ran out of rows".into());
                    }
                }
                ScenarioKind::Mix => {
                    vu.initialized = true;
                    rt.run_items(&mut vu, &sc.init, None, None, &abort).await;
                    vu.iteration = 1;
                    for (s, _) in &sc.mix {
                        vu.trace.clear();
                        let r = rt.exec_step(&mut vu, *s, None, &abort).await;
                        rt.apply(&mut vu, *s, &r);
                    }
                }
            }
            for (k, v) in vu.vars {
                last_vars.insert(k, v);
            }
        }
    }
    let globals = rt.globals.read().unwrap().clone();
    let secret_names = rt.plan.secret_names.clone();
    let rt = Arc::try_unwrap(rt).map_err(|_| EngineError::Client("internal: try state still shared".into()))?;
    let mut steps = rt.sampler.into_samples();
    steps.sort_by_key(|s| s.id);
    let mut vars: Vec<KeyValue> = globals
        .iter()
        .chain(last_vars.iter())
        .map(|(k, v)| KeyValue { name: k.clone(), value: if secret_names.contains(k) { REDACTED.into() } else { v.clone() }, enabled: true })
        .collect();
    vars.sort_by(|a, b| a.name.cmp(&b.name));
    vars.dedup_by(|a, b| a.name == b.name);
    Ok(TryResult { steps, error, vars })
}

/// Send one step with the given variables (Send once in the step editor).
pub async fn send_step(config: &TestConfig, opts: &RunOptions, step_id: &str, vars: &[KeyValue]) -> Result<TryResult, EngineError> {
    let mut c = config.clone();
    let step = c.all_steps().iter().find(|r| r.step.id == step_id).map(|r| r.step.clone());
    let Some(mut step) = step else { return Err(invalid(format!("step:{step_id}"), "This step no longer exists")) };
    step.run_if = None;
    let mut sc = Scenario::new("send", "Send once");
    sc.steps = vec![FlowItem::Request { step }];
    c.setup.clear();
    c.teardown.clear();
    c.scenarios = vec![sc];
    // Variables the step reads are supplied by the caller; make them known to the plan.
    let supplied: HashMap<String, String> = vars.iter().filter(|v| v.enabled).map(|v| (v.name.clone(), v.value.clone())).collect();
    for name in supplied.keys() {
        if !c.variables.iter().any(|v| &v.name == name) {
            c.variables.push(Variable { name: name.clone(), secret: false, values: [(c.active_env.clone(), supplied[name].clone())].into() });
        } else if let Some(v) = c.variables.iter_mut().find(|v| &v.name == name) {
            v.values.insert(c.active_env.clone(), supplied[name].clone());
        }
    }
    let Built { rt, .. } = build(&c, opts, SamplePolicy::capture_all())?;
    let abort = CancellationToken::new();
    let mut vu = Vu::new(&rt, Some(0)).map_err(|_| invalid("data", "a data file has no rows"))?;
    vu.iteration = 1;
    for (fi, f) in rt.plan.feeders.iter().enumerate() {
        let row = vu.unique_rows.get(fi).copied().flatten().unwrap_or(0);
        if !f.is_empty() {
            for (k, v) in f.cells(row) {
                vu.vars.insert(k, v.to_string());
            }
        }
    }
    let r = rt.exec_step(&mut vu, 0, None, &abort).await;
    rt.apply(&mut vu, 0, &r);
    let secret_names = rt.plan.secret_names.clone();
    let mut vars: Vec<KeyValue> = vu
        .vars
        .iter()
        .map(|(k, v)| KeyValue { name: k.clone(), value: if secret_names.contains(k) { REDACTED.into() } else { v.clone() }, enabled: true })
        .collect();
    vars.sort_by(|a, b| a.name.cmp(&b.name));
    drop(vu);
    let rt = Arc::try_unwrap(rt).map_err(|_| EngineError::Client("internal: send state still shared".into()))?;
    Ok(TryResult { steps: rt.sampler.into_samples(), error: None, vars })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirects() {
        assert!(is_redirect(302) && is_redirect(308) && !is_redirect(304));
    }

    #[test]
    fn plan_order_matches_step_refs() {
        let mut c = TestConfig::blank("t", "http://localhost/a");
        c.setup.push(RequestStep::new("su", "POST", "http://localhost/login"));
        c.scenarios[0].steps.push(FlowItem::Group {
            group: ParallelGroup { id: "g".into(), name: String::new(), steps: vec![RequestStep::new("g1", "GET", "http://localhost/1"), RequestStep::new("g2", "GET", "http://localhost/2")], run_if: None },
        });
        let mut off = Scenario::new("s2", "Off");
        off.enabled = false;
        off.steps.push(FlowItem::Request { step: RequestStep::new("x", "GET", "http://localhost/x") });
        c.scenarios.push(off);
        c.teardown.push(RequestStep::new("td", "DELETE", "http://localhost/s"));
        let (plan, _) = compile(&c, None).unwrap();
        let refs = step_refs(&c);
        let ids: Vec<&str> = plan.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["su", "r1", "g1", "g2", "td"]);
        assert_eq!(refs.len(), ids.len());
        assert_eq!(refs[2].1.as_deref(), Some("g"));
        assert_eq!(refs[4].0, StepPhase::Teardown);
        assert!(!plan.steps[0].in_totals && plan.steps[1].in_totals);
    }
}
