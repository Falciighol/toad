//! Toad desktop app: a thin Tauri layer over `toad-core`.

pub mod commands;
pub mod state;
pub mod storage;

use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};

/// Typed command/event registry; also drives `src/bindings.ts` generation.
pub fn specta_builder() -> Builder<tauri::Wry> {
    use commands::*;
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            check_target,
            approve_host,
            start_run,
            stop_run,
            current_run,
            list_runs,
            get_run,
            delete_run,
            export_run,
            list_tests,
            save_test,
            duplicate_test,
            delete_test,
            get_settings,
            save_settings,
        ])
        .events(collect_events![RunSnapshot, RunFinished, RunError])
        // All u64 counters stay far below 2^53.
        .dangerously_cast_bigints_to_number()
        // Models have identical serialize/deserialize shapes; emit one type each.
        .disable_serde_phases()
}

pub const BINDINGS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings.ts");

pub fn export_bindings(builder: &Builder<tauri::Wry>, path: &str) {
    builder
        .export(specta_typescript::Typescript::default().header("/* eslint-disable */\n// @ts-nocheck"), path)
        .expect("failed to export TypeScript bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();
    #[cfg(debug_assertions)]
    export_bindings(&builder, BINDINGS_PATH);

    if let Some(limit) = toad_core::raise_fd_limit() {
        eprintln!("toad: open-file limit raised to {limit}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let dir = app.path().app_data_dir()?;
            let storage = storage::Storage::open(dir)?;
            app.manage(state::AppState::new(storage));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Toad");
}

#[cfg(test)]
mod tests {
    /// Fails when `src/bindings.ts` is stale. Regenerate with
    /// `TOAD_WRITE_BINDINGS=1 cargo test -p toad bindings` (or run the app in debug).
    #[test]
    fn bindings_are_up_to_date() {
        let builder = super::specta_builder();
        if std::env::var_os("TOAD_WRITE_BINDINGS").is_some() {
            super::export_bindings(&builder, super::BINDINGS_PATH);
            return;
        }
        let tmp = std::env::temp_dir().join(format!("toad-bindings-{}.ts", std::process::id()));
        super::export_bindings(&builder, tmp.to_str().unwrap());
        let fresh = std::fs::read_to_string(&tmp).unwrap();
        let _ = std::fs::remove_file(&tmp);
        let current = std::fs::read_to_string(super::BINDINGS_PATH).unwrap_or_default();
        assert!(fresh == current, "src/bindings.ts is stale; run TOAD_WRITE_BINDINGS=1 cargo test -p toad bindings");
    }
}
