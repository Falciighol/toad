fn main() {
    // Declaring app commands generates `allow-<command>` permissions, so each command
    // must be granted explicitly in capabilities/default.json (least privilege).
    let commands = &[
        "check_target", "approve_host", "start_run", "stop_run", "current_run",
        "list_runs", "get_run", "delete_run", "export_run",
        "list_tests", "save_test", "duplicate_test", "delete_test",
        "import_asset", "preview_data", "test_hosts", "validate_test", "try_flow", "send_step", "get_samples",
        "get_settings", "save_settings",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
