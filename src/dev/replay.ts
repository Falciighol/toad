// Dev-only: boots the real UI in a plain browser with Tauri IPC mocked, replaying a
// recorded engine run (fixtures produced by `examples/headless_run.rs`). Served by
// `pnpm dev` at /replay.html; not part of the production bundle (index.html only).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { RunSummary, Settings, Snapshot, TestConfig } from "../bindings";
import { defaultSettings } from "../lib/defaults";
import snapshotsJson from "./fixtures/sample-snapshots.json";
import summaryJson from "./fixtures/sample-summary.json";
import configJson from "./fixtures/sample-config.json";

const snapshots = snapshotsJson as unknown as Snapshot[];
const summary = summaryJson as unknown as RunSummary;
const sampleConfig = configJson as unknown as TestConfig;
let settings: Settings = defaultSettings();
let tests: TestConfig[] = [sampleConfig];
const runs: RunSummary[] = [];
let stopRequested = false;

async function replay() {
  stopRequested = false;
  for (const s of snapshots) {
    await new Promise((r) => setTimeout(r, 250));
    if (stopRequested) break;
    await emit("run://snapshot", s);
  }
  runs.unshift(summary);
  await emit("run://finished", summary);
}

mockWindows("main");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "get_settings":
        return settings;
      case "save_settings":
        settings = a["settings"] as Settings;
        return settings;
      case "list_tests":
        return tests;
      case "save_test":
      case "duplicate_test":
        return a["config"] ?? sampleConfig;
      case "delete_test":
        tests = tests.filter((t) => t.id !== a["id"]);
        return null;
      case "list_runs":
        return runs.map((r) => ({ ...r, series: [] }));
      case "get_run":
        return runs.find((r) => r.run_id === a["runId"]) ?? summary;
      case "delete_run":
        return null;
      case "current_run":
        return null;
      case "check_target":
        return { host: "127.0.0.1", addrs: ["127.0.0.1"], loopback: true, private: false, approved: true };
      case "approve_host":
        return null;
      case "start_run":
        void replay();
        return summary.run_id;
      case "stop_run":
        stopRequested = true;
        return null;
      default:
        console.warn("replay: unmocked command", cmd);
        return null;
    }
  },
  { shouldMockEvents: true },
);

await import("../main");
