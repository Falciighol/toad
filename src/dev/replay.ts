// Dev-only: boots the real UI in a plain browser with Tauri IPC mocked, replaying a recorded
// engine run (fixtures produced by `examples/headless_run.rs --snapshots --summary --samples`
// against `examples/mock_server.rs`). Served by `pnpm dev` at /replay.html; not part of the
// production bundle (index.html only).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { DataPreview, FieldError, HostInfo, RunSummary, Sample, Settings, Snapshot, TestConfig, TryResult } from "../bindings";
import { defaultSettings } from "../lib/defaults";
import { allSteps } from "../lib/flow";
import snapshotsJson from "./fixtures/sample-snapshots.json";
import summaryJson from "./fixtures/sample-summary.json";
import configJson from "./fixtures/sample-config.json";
import samplesJson from "./fixtures/sample-samples.json";

const snapshots = snapshotsJson as unknown as Snapshot[];
const summary = summaryJson as unknown as RunSummary;
const sampleConfig = configJson as unknown as TestConfig;
const samples = samplesJson as unknown as Sample[];
let settings: Settings = defaultSettings();
let tests: TestConfig[] = [sampleConfig];
const runs: RunSummary[] = [];
const approved = new Set<string>();
let stopRequested = false;
let nextId = 1;

async function replay(runId: string) {
  stopRequested = false;
  for (const s of snapshots) {
    await new Promise((r) => setTimeout(r, 250));
    if (stopRequested) break;
    await emit("run://snapshot", { ...s, run_id: runId });
  }
  const done = { ...summary, run_id: runId, started_at: Date.now() - summary.duration_ms };
  runs.unshift(done);
  await emit("run://finished", done);
}

function validate(c: TestConfig): FieldError[] {
  const out: FieldError[] = [];
  if (!c.name.trim()) out.push({ field: "name", message: "Give the test a name" });
  for (const r of allSteps(c)) if (!r.step.url.trim()) out.push({ field: `step:${r.step.id}.url`, message: "Enter the URL to request" });
  return out;
}

function hosts(c: TestConfig): HostInfo[] {
  const steps = allSteps(c, true).map((r) => r.step.name || r.step.url);
  const staging = c.environments.find((e) => e.id === c.active_env)?.name === "staging";
  const host = staging ? "staging.shop.test" : "127.0.0.1";
  return [
    {
      host,
      source: "static",
      steps,
      check: { host, addrs: [staging ? "203.0.113.7" : "127.0.0.1"], loopback: !staging, private: false, approved: !staging || approved.has(host) },
      error: null,
    },
  ];
}

const firstPerStep = () => {
  const seen = new Set<string>();
  return samples.filter((s) => s.outcome !== "not_taken" && !seen.has(s.step_id) && seen.add(s.step_id)).map((s) => ({ ...s, reason: "try" as const }));
};

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
      case "save_test": {
        const c = { ...(a["config"] as TestConfig) };
        if (!c.id) c.id = `t${nextId++}`;
        c.updated_at = Date.now();
        tests = [c, ...tests.filter((t) => t.id !== c.id)];
        return c;
      }
      case "duplicate_test": {
        const src = tests.find((t) => t.id === a["id"]) ?? sampleConfig;
        const copy = { ...structuredClone(src), id: `t${nextId++}`, name: `${src.name} (copy)` };
        tests = [copy, ...tests];
        return copy;
      }
      case "delete_test":
        tests = tests.filter((t) => t.id !== a["id"]);
        return null;
      case "validate_test":
        return validate(a["config"] as TestConfig);
      case "test_hosts":
        return hosts(a["config"] as TestConfig);
      case "try_flow":
        return { steps: firstPerStep(), error: null, vars: [{ name: "token", value: "[redacted]", enabled: true }, { name: "firstOrder", value: "1", enabled: true }] } satisfies TryResult;
      case "send_step": {
        const s = samples.find((x) => x.step_id === a["stepId"] && x.response) ?? firstPerStep()[0]!;
        return { steps: [{ ...s, reason: "try" }], error: null, vars: [] } satisfies TryResult;
      }
      case "get_samples":
        return samples;
      case "import_asset":
        return { file: `0123456789ab-${String(a["path"]).split("/").pop()}`, name: String(a["path"]).split("/").pop(), size: 120 };
      case "preview_data":
        return { format: "csv", has_header: true, delimiter: ",", columns: ["name", "plan"], rows: [["ada", "pro"], ["grace", "free"], ["linus", "pro"]], row_count: 8, warnings: [] } satisfies DataPreview;
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
        approved.add(String(a["host"]));
        return null;
      case "start_run": {
        const id = `run-${Date.now()}`;
        void replay(id);
        return id;
      }
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

// A past run so History, the library trend and endpoint deltas have something to show.
runs.push({ ...summary, run_id: "earlier", started_at: summary.started_at - 86_400_000 });

await import("../main");
