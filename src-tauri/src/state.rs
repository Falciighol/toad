//! Process-wide app state, managed by Tauri.

use crate::storage::Storage;
use std::collections::HashSet;
use std::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use toad_core::Settings;

pub struct RunHandle {
    pub run_id: String,
    pub cancel: CancellationToken,
    pub join: tauri::async_runtime::JoinHandle<()>,
}

pub struct AppState {
    /// Only one run at a time.
    pub run: Mutex<Option<RunHandle>>,
    /// Non-loopback hosts the user confirmed this session (not persisted).
    pub approved_hosts: Mutex<HashSet<String>>,
    pub settings: RwLock<Settings>,
    pub storage: Storage,
}

impl AppState {
    pub fn new(storage: Storage) -> Self {
        let settings = storage.load_settings();
        AppState {
            run: Mutex::new(None),
            approved_hosts: Mutex::new(HashSet::new()),
            settings: RwLock::new(settings),
            storage,
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }
}
