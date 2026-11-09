//! Tauri commands and events. Thin glue over `toad-core` and `storage`.

use crate::state::{AppState, RunHandle};
use crate::storage::StorageError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::FsExt;
use tauri_specta::Event;
use tokio_util::sync::CancellationToken;
use std::collections::{BTreeMap, HashMap};
use toad_core::data::DataPreview;
use toad_core::engine::now_ms;
use toad_core::safety::{self, ResolvedTarget};
use toad_core::template::{self, Template};
use toad_core::*;

// ---------- events ----------

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
#[tauri_specta(event_name = "run://snapshot")]
pub struct RunSnapshot(pub Snapshot);

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
#[tauri_specta(event_name = "run://finished")]
pub struct RunFinished(pub RunSummary);

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
#[tauri_specta(event_name = "run://error")]
pub struct RunError {
    pub run_id: String,
    pub message: String,
}

// ---------- errors ----------

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Invalid,
    NeedsConfirmation,
    Busy,
    Dns,
    NotFound,
    Forbidden,
    Io,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
    pub fields: Vec<FieldError>,
}

impl CommandError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CommandError { code, message: message.into(), fields: vec![] }
    }
}

impl From<StorageError> for CommandError {
    fn from(e: StorageError) -> Self {
        let code = match e {
            StorageError::NotFound(_) => ErrorCode::NotFound,
            StorageError::BadId(_) => ErrorCode::Invalid,
            _ => ErrorCode::Io,
        };
        CommandError::new(code, e.to_string())
    }
}

type CmdResult<T> = Result<T, CommandError>;

// ---------- target safety ----------

fn classify(state: &AppState, target: &ResolvedTarget) -> TargetCheck {
    let settings = state.settings();
    let loopback = target.is_loopback();
    let private = target.is_private();
    let approved = loopback
        || (private && settings.private_ranges_as_local)
        || state.approved_hosts.lock().unwrap().contains(&target.host);
    TargetCheck {
        host: target.host.clone(),
        addrs: target.addrs.iter().map(|a| a.ip().to_string()).collect(),
        loopback,
        private,
        approved,
    }
}

async fn resolve(url: &str) -> CmdResult<ResolvedTarget> {
    safety::resolve(url).await.map_err(|e| match e {
        safety::SafetyError::Url(m) => CommandError::new(ErrorCode::Invalid, m),
        e @ safety::SafetyError::Dns { .. } => CommandError::new(ErrorCode::Dns, e.to_string()),
    })
}

/// Resolve the URL and report whether it needs a confirmation before running.
#[tauri::command]
#[specta::specta]
pub async fn check_target(state: State<'_, AppState>, url: String) -> CmdResult<TargetCheck> {
    let target = resolve(&url).await?;
    Ok(classify(&state, &target))
}

/// Remember a confirmation for this host until the app quits.
#[tauri::command]
#[specta::specta]
pub fn approve_host(state: State<'_, AppState>, host: String) {
    state.approved_hosts.lock().unwrap().insert(host.trim().to_ascii_lowercase());
}

// ---------- hosts ----------

/// The host a step's URL reaches, when its URL only uses environment variables.
fn static_host(c: &TestConfig, url: &str) -> Option<String> {
    let t = Template::parse(url.trim()).ok()?;
    let mut vars: HashMap<String, String> =
        c.variables.iter().map(|v| (v.name.trim().to_string(), v.values.get(&c.active_env).cloned().unwrap_or_default())).collect();
    if !c.defaults.base_url.trim().is_empty() {
        vars.entry("baseUrl".into()).or_insert_with(|| c.defaults.base_url.trim().to_string());
    }
    if t.vars().iter().any(|v| !vars.contains_key(v)) || t.parts.iter().any(|p| matches!(p, template::Part::Gen(..))) {
        return None;
    }
    let mut rng = fastrand_rng();
    let seq = std::sync::atomic::AtomicU64::new(0);
    let rendered = t.render(&mut template::Ctx { scope: &vars, rng: &mut rng, seq: &seq }).ok()?;
    safety::url_host(&rendered).ok().map(|(h, _)| h)
}

fn fastrand_rng() -> toad_core::template::Rng {
    toad_core::template::Rng::with_seed(1)
}

/// Every host a test touches: static ones (resolved and classified), ones only known at
/// runtime, and the proxy.
async fn collect_hosts(state: &AppState, c: &TestConfig) -> Vec<HostInfo> {
    let mut by_host: BTreeMap<String, (HostSource, Vec<String>, String)> = BTreeMap::new();
    let enabled: std::collections::HashSet<&str> = c.enabled_scenarios().map(|s| s.id.as_str()).collect();
    for r in c.all_steps() {
        if r.scenario.is_some_and(|s| !enabled.contains(s.id.as_str())) {
            continue;
        }
        let label = r.step.label();
        match static_host(c, &r.step.url) {
            Some(h) => {
                let url = template_free_url(c, &r.step.url).unwrap_or_default();
                let e = by_host.entry(h).or_insert((HostSource::Static, vec![], url));
                e.1.push(label);
            }
            None => by_host.entry("(runtime)".into()).or_insert((HostSource::Runtime, vec![], String::new())).1.push(label),
        }
    }
    if c.connection.proxy.enabled && !c.connection.proxy.address.trim().is_empty() {
        let a = c.connection.proxy.address.trim();
        let a = a.split_once("://").map_or(a, |(_, r)| r);
        if let Some((h, _)) = a.rsplit_once(':') {
            by_host.insert(h.trim_matches(['[', ']']).to_ascii_lowercase(), (HostSource::Proxy, vec!["Proxy".into()], format!("http://{a}/")));
        }
    }
    let overrides: HashMap<String, String> = c.connection.host_overrides.iter().map(|o| (o.host.trim().to_ascii_lowercase(), o.address.trim().to_string())).collect();
    let mut out = Vec::new();
    for (host, (source, steps, url)) in by_host {
        if source == HostSource::Runtime {
            out.push(HostInfo { host: String::new(), source, steps, check: None, error: None });
            continue;
        }
        let resolved = match overrides.get(&host) {
            Some(addr) => {
                let ip = addr.parse::<std::net::SocketAddr>().map(|a| a.ip()).or_else(|_| addr.parse::<std::net::IpAddr>());
                ip.map(|ip| ResolvedTarget { host: host.clone(), addrs: vec![std::net::SocketAddr::new(ip, 0)] }).map_err(|_| format!("override {addr} isn't an IP"))
            }
            None => safety::resolve(&url).await.map_err(|e| e.to_string()),
        };
        match resolved {
            Ok(t) => out.push(HostInfo { host, source, steps, check: Some(classify(state, &t)), error: None }),
            Err(e) => out.push(HostInfo { host, source, steps, check: None, error: Some(e) }),
        }
    }
    out
}

fn template_free_url(c: &TestConfig, url: &str) -> Option<String> {
    let t = Template::parse(url.trim()).ok()?;
    let mut vars: HashMap<String, String> =
        c.variables.iter().map(|v| (v.name.trim().to_string(), v.values.get(&c.active_env).cloned().unwrap_or_default())).collect();
    vars.entry("baseUrl".into()).or_insert_with(|| c.defaults.base_url.trim().to_string());
    let mut rng = fastrand_rng();
    let seq = std::sync::atomic::AtomicU64::new(0);
    t.render(&mut template::Ctx { scope: &vars, rng: &mut rng, seq: &seq }).ok()
}

/// The engine's own validation, for inline field errors.
#[tauri::command]
#[specta::specta]
pub fn validate_test(state: State<'_, AppState>, config: TestConfig) -> Vec<FieldError> {
    toad_core::validate::validate(&config, Limits::from(&state.settings()))
}

/// Hosts a test touches, for the Review stage.
#[tauri::command]
#[specta::specta]
pub async fn test_hosts(state: State<'_, AppState>, config: TestConfig) -> CmdResult<Vec<HostInfo>> {
    Ok(collect_hosts(&state, &config).await)
}

/// Re-check every static host server-side; never trust the UI's confirmation state.
/// Returns the run options with every checked host pinned.
async fn preflight(state: &AppState, config: &TestConfig, run_id: String) -> CmdResult<RunOptions> {
    let settings = state.settings();
    let hosts = collect_hosts(state, config).await;
    let mut pinned = HashMap::new();
    let mut unconfirmed = Vec::new();
    for h in &hosts {
        if let Some(e) = &h.error {
            if h.source == HostSource::Proxy {
                return Err(CommandError::new(ErrorCode::Dns, format!("proxy {}: {e}", h.host)));
            }
            // DNS failures surface per request as DNS errors.
            continue;
        }
        if let Some(c) = &h.check {
            if !c.approved {
                unconfirmed.push(c.host.clone());
            } else if h.source == HostSource::Static && c.host.parse::<std::net::IpAddr>().is_err() {
                let addrs = c.addrs.iter().filter_map(|a| a.parse::<std::net::IpAddr>().ok()).map(|ip| std::net::SocketAddr::new(ip, 0)).collect();
                pinned.insert(c.host.clone(), addrs);
            }
        }
    }
    if !unconfirmed.is_empty() {
        return Err(CommandError::new(
            ErrorCode::NeedsConfirmation,
            format!("{} {} not loopback and {} not been confirmed", unconfirmed.join(", "), if unconfirmed.len() == 1 { "is" } else { "are" }, if unconfirmed.len() == 1 { "has" } else { "have" }),
        ));
    }
    let asset_dir = if config.id.is_empty() { None } else { state.storage.test_dir(&config.id).ok() };
    Ok(RunOptions {
        approved_hosts: state.approved_hosts.lock().unwrap().clone(),
        private_ok: settings.private_ranges_as_local,
        pinned,
        limits: Limits::from(&settings),
        asset_dir,
        sampling: (&settings).into(),
        redact: !settings.store_secrets_in_history,
        ..RunOptions::new(run_id)
    })
}

fn engine_error(e: EngineError) -> CommandError {
    match e {
        EngineError::Invalid(fields) => CommandError { code: ErrorCode::Invalid, message: "Fix the highlighted fields".into(), fields },
        EngineError::Client(m) => CommandError::new(ErrorCode::Invalid, m),
    }
}

// ---------- runs ----------

#[tauri::command]
#[specta::specta]
pub async fn start_run(app: AppHandle, state: State<'_, AppState>, config: TestConfig) -> CmdResult<String> {
    if state.run.lock().unwrap().is_some() {
        return Err(CommandError::new(ErrorCode::Busy, "A run is already in progress"));
    }
    let settings = state.settings();
    let fields = toad_core::validate::validate(&config, Limits::from(&settings));
    if !fields.is_empty() {
        return Err(CommandError { code: ErrorCode::Invalid, message: "Fix the highlighted fields".into(), fields });
    }
    let run_id = uuid::Uuid::now_v7().to_string();
    let opts = preflight(&state, &config, run_id.clone()).await?;
    let cancel = CancellationToken::new();

    let mut slot = state.run.lock().unwrap();
    if slot.is_some() {
        return Err(CommandError::new(ErrorCode::Busy, "A run is already in progress"));
    }
    let (task_app, task_id, task_cancel) = (app.clone(), run_id.clone(), cancel.clone());
    let join = tauri::async_runtime::spawn(async move {
        let emit_app = task_app.clone();
        let result = toad_core::run(config, opts, task_cancel, move |s| {
            let _ = RunSnapshot(s).emit(&emit_app);
        })
        .await;
        let state = task_app.state::<AppState>();
        match result {
            Ok(RunResult { summary, samples }) => {
                let settings = state.settings();
                let stored = if settings.store_secrets_in_history {
                    summary.clone()
                } else {
                    RunSummary { config: summary.config.redacted(), ..summary.clone() }
                };
                let saved = state.storage.save_run(&stored, settings.history_limit as usize).and_then(|_| state.storage.save_samples(&summary.run_id, &samples));
                if let Err(e) = saved {
                    let _ = RunError { run_id: task_id.clone(), message: format!("Run finished but could not be saved: {e}") }.emit(&task_app);
                }
                let _ = RunFinished(summary).emit(&task_app);
            }
            Err(e) => {
                let _ = RunError { run_id: task_id.clone(), message: e.to_string() }.emit(&task_app);
            }
        }
        let mut slot = state.run.lock().unwrap();
        if slot.as_ref().is_some_and(|h| h.run_id == task_id) {
            *slot = None;
        }
    });
    *slot = Some(RunHandle { run_id: run_id.clone(), cancel, join });
    Ok(run_id)
}

/// One virtual user through setup, init and one iteration of each scenario (or one scenario).
#[tauri::command]
#[specta::specta]
pub async fn try_flow(state: State<'_, AppState>, config: TestConfig, scenario: Option<String>) -> CmdResult<TryResult> {
    let opts = preflight(&state, &config, "try".into()).await?;
    let opts = RunOptions { redact: false, ..opts };
    toad_core::try_flow(&config, &opts, scenario.as_deref()).await.map_err(engine_error)
}

/// Send one step with the given variables.
#[tauri::command]
#[specta::specta]
pub async fn send_step(state: State<'_, AppState>, config: TestConfig, step_id: String, vars: Vec<KeyValue>) -> CmdResult<TryResult> {
    let opts = preflight(&state, &config, "send".into()).await?;
    let opts = RunOptions { redact: false, ..opts };
    toad_core::send_step(&config, &opts, &step_id, &vars).await.map_err(engine_error)
}

#[tauri::command]
#[specta::specta]
pub fn get_samples(state: State<'_, AppState>, run_id: String) -> CmdResult<Vec<Sample>> {
    Ok(state.storage.get_samples(&run_id)?)
}

/// Stop scheduling new requests; in-flight ones get 2 s before they are cancelled.
#[tauri::command]
#[specta::specta]
pub fn stop_run(state: State<'_, AppState>) {
    if let Some(h) = state.run.lock().unwrap().as_ref() {
        h.cancel.cancel();
    }
}

/// The id of the run in progress, if any (lets the UI recover after a reload).
#[tauri::command]
#[specta::specta]
pub fn current_run(state: State<'_, AppState>) -> Option<String> {
    state.run.lock().unwrap().as_ref().map(|h| h.run_id.clone())
}

#[tauri::command]
#[specta::specta]
pub fn list_runs(state: State<'_, AppState>) -> Vec<RunSummary> {
    state.storage.list_runs()
}

#[tauri::command]
#[specta::specta]
pub fn get_run(state: State<'_, AppState>, run_id: String) -> CmdResult<RunSummary> {
    Ok(state.storage.get_run(&run_id)?)
}

#[tauri::command]
#[specta::specta]
pub fn delete_run(state: State<'_, AppState>, run_id: String) -> CmdResult<()> {
    Ok(state.storage.delete_run(&run_id)?)
}

/// Write a run to `path`, which must have been chosen in the save dialog.
#[tauri::command]
#[specta::specta]
pub fn export_run(app: AppHandle, state: State<'_, AppState>, run_id: String, format: ExportFormat, path: String) -> CmdResult<()> {
    let path = PathBuf::from(path);
    if !app.fs_scope().is_allowed(&path) {
        return Err(CommandError::new(ErrorCode::Forbidden, "Choose the export location with the save dialog"));
    }
    let summary = state.storage.get_run(&run_id)?;
    let content = toad_core::export::export(&summary, format, state.settings().strip_secrets_on_export);
    std::fs::write(&path, content).map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))
}

// ---------- saved tests ----------

#[tauri::command]
#[specta::specta]
pub fn list_tests(state: State<'_, AppState>) -> CmdResult<Vec<TestConfig>> {
    Ok(state.storage.list_tests()?)
}

/// Create (empty id) or update a saved test. Tests autosave, so this accepts unfinished
/// tests; validation happens on Start. Returns the stored version.
#[tauri::command]
#[specta::specta]
pub fn save_test(state: State<'_, AppState>, mut config: TestConfig) -> CmdResult<TestConfig> {
    let now = now_ms();
    if config.id.is_empty() {
        config.id = uuid::Uuid::now_v7().to_string();
        config.created_at = now;
    }
    config.version = toad_core::spec::FORMAT_VERSION;
    config.updated_at = now;
    state.storage.save_test(&config)?;
    Ok(config)
}

#[tauri::command]
#[specta::specta]
pub fn duplicate_test(state: State<'_, AppState>, id: String) -> CmdResult<TestConfig> {
    let mut copy = state.storage.get_test(&id)?;
    let now = now_ms();
    copy.id = uuid::Uuid::now_v7().to_string();
    copy.name = format!("{} (copy)", copy.name);
    copy.created_at = now;
    copy.updated_at = now;
    state.storage.copy_assets(&id, &copy.id)?;
    state.storage.save_test(&copy)?;
    Ok(copy)
}

#[tauri::command]
#[specta::specta]
pub fn delete_test(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.storage.delete_test(&id)?)
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Asset {
    /// Stored file name inside the test folder.
    pub file: String,
    /// The name the user's file had.
    pub name: String,
    pub size: u64,
}

/// Copy a file chosen in the open dialog into the test's folder.
#[tauri::command]
#[specta::specta]
pub fn import_asset(app: AppHandle, state: State<'_, AppState>, test_id: String, path: String) -> CmdResult<Asset> {
    let path = PathBuf::from(path);
    if !app.fs_scope().is_allowed(&path) {
        return Err(CommandError::new(ErrorCode::Forbidden, "Choose the file with the open dialog"));
    }
    let meta = std::fs::metadata(&path).map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))?;
    if meta.len() > toad_core::data::MAX_DATA_BYTES {
        return Err(CommandError::new(ErrorCode::Invalid, "Files over 100 MB can't be added to a test"));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (file, size) = state.storage.import_asset(&test_id, &path)?;
    Ok(Asset { file, name, size })
}

/// Parse a data file in the test folder: columns, the first rows, and the row count.
#[tauri::command]
#[specta::specta]
pub fn preview_data(state: State<'_, AppState>, test_id: String, file: String, format: DataFormat, has_header: bool) -> CmdResult<DataPreview> {
    let bytes = state.storage.read_asset(&test_id, &file)?;
    toad_core::data::preview(&bytes, format, has_header).map_err(|m| CommandError::new(ErrorCode::Invalid, m))
}

// ---------- settings ----------

#[tauri::command]
#[specta::specta]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
#[specta::specta]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<Settings> {
    let mut fields = Vec::new();
    let mut check = |ok: bool, field: &str, message: &str| {
        if !ok {
            fields.push(FieldError { field: field.into(), message: message.into() });
        }
    };
    check((1..=100_000).contains(&settings.max_concurrency), "max_concurrency", "Must be between 1 and 100000");
    check((1..=1_000_000).contains(&settings.max_rps), "max_rps", "Must be between 1 and 1000000");
    check((1..=10_000).contains(&settings.history_limit), "history_limit", "Must be between 1 and 10000");
    check(settings.sample_failures <= 10_000, "sample_failures", "At most 10000");
    check(settings.sample_slowest <= 1000, "sample_slowest", "At most 1000");
    check(settings.sample_random <= 10_000, "sample_random", "At most 10000");
    check((1..=4096).contains(&settings.sample_body_kb), "sample_body_kb", "Between 1 and 4096 KB");
    check((1..=2048).contains(&settings.sample_run_mb), "sample_run_mb", "Between 1 and 2048 MB");
    if !fields.is_empty() {
        return Err(CommandError { code: ErrorCode::Invalid, message: "Invalid settings".into(), fields });
    }
    state.storage.save_settings(&settings)?;
    *state.settings.write().unwrap() = settings.clone();
    Ok(settings)
}
