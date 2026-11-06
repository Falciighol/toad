//! Tauri commands and events. Thin glue over `toad-core` and `storage`.

use crate::state::{AppState, RunHandle};
use crate::storage::StorageError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::FsExt;
use tauri_specta::Event;
use tokio_util::sync::CancellationToken;
use toad_core::engine::now_ms;
use toad_core::safety::{self, ResolvedTarget};
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

// ---------- runs ----------

#[tauri::command]
#[specta::specta]
pub async fn start_run(app: AppHandle, state: State<'_, AppState>, config: TestConfig) -> CmdResult<String> {
    if state.run.lock().unwrap().is_some() {
        return Err(CommandError::new(ErrorCode::Busy, "A run is already in progress"));
    }
    let settings = state.settings();
    let limits = Limits::from(&settings);
    let fields = config.validate(limits);
    if !fields.is_empty() {
        return Err(CommandError { code: ErrorCode::Invalid, message: "Fix the highlighted fields".into(), fields });
    }
    // Re-check the target server-side; never trust the UI's confirmation state.
    let target = resolve(&config.request.url).await?;
    let check = classify(&state, &target);
    if !check.approved {
        return Err(CommandError::new(
            ErrorCode::NeedsConfirmation,
            format!("{} is not a loopback address and has not been confirmed", check.host),
        ));
    }

    let run_id = uuid::Uuid::now_v7().to_string();
    let cancel = CancellationToken::new();
    let opts = RunOptions {
        pinned: Some(target),
        approved_hosts: state.approved_hosts.lock().unwrap().clone(),
        limits,
        ..RunOptions::new(run_id.clone())
    };

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
            Ok(summary) => {
                let settings = state.settings();
                let stored = if settings.store_secrets_in_history {
                    summary.clone()
                } else {
                    RunSummary { config: summary.config.redacted(), ..summary.clone() }
                };
                if let Err(e) = state.storage.save_run(&stored, settings.history_limit as usize) {
                    let _ = RunError { run_id: task_id.clone(), message: format!("Run finished but could not be saved: {e}") }
                        .emit(&task_app);
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

/// Create (empty id) or update a saved test. Returns the stored version.
#[tauri::command]
#[specta::specta]
pub fn save_test(state: State<'_, AppState>, mut config: TestConfig) -> CmdResult<TestConfig> {
    if config.name.trim().is_empty() {
        return Err(CommandError {
            code: ErrorCode::Invalid,
            message: "Name is required".into(),
            fields: vec![FieldError { field: "name".into(), message: "Name is required".into() }],
        });
    }
    let now = now_ms();
    if config.id.is_empty() {
        config.id = uuid::Uuid::now_v7().to_string();
        config.created_at = now;
    }
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
    state.storage.save_test(&copy)?;
    Ok(copy)
}

#[tauri::command]
#[specta::specta]
pub fn delete_test(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    Ok(state.storage.delete_test(&id)?)
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
    if !fields.is_empty() {
        return Err(CommandError { code: ErrorCode::Invalid, message: "Invalid settings".into(), fields });
    }
    state.storage.save_settings(&settings)?;
    *state.settings.write().unwrap() = settings.clone();
    Ok(settings)
}
