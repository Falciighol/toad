// Typed wrappers over the generated bindings. Commands that can fail throw ApiError.
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  commands,
  events,
  type Asset,
  type CommandError,
  type DataFormat,
  type DataPreview,
  type ExportFormat,
  type FieldError,
  type HostInfo,
  type KeyValue,
  type RunError,
  type RunSummary,
  type Sample,
  type Settings,
  type Snapshot,
  type TargetCheck,
  type TestConfig,
  type TryResult,
} from "../bindings";

export class ApiError extends Error {
  readonly code: CommandError["code"];
  readonly fields: CommandError["fields"];
  constructor(e: CommandError) {
    super(e.message);
    this.code = e.code;
    this.fields = e.fields;
  }
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError };

async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.status === "error") throw new ApiError(r.error);
  return r.data;
}

export const api = {
  checkTarget: (url: string): Promise<TargetCheck> => unwrap(commands.checkTarget(url)),
  approveHost: (host: string): Promise<void> => commands.approveHost(host),
  startRun: (config: TestConfig): Promise<string> => unwrap(commands.startRun(config)),
  stopRun: (): Promise<void> => commands.stopRun(),
  currentRun: (): Promise<string | null> => commands.currentRun(),
  listRuns: (): Promise<RunSummary[]> => commands.listRuns(),
  getRun: (runId: string): Promise<RunSummary> => unwrap(commands.getRun(runId)),
  deleteRun: (runId: string): Promise<null> => unwrap(commands.deleteRun(runId)),
  exportRun: (runId: string, format: ExportFormat, path: string): Promise<null> => unwrap(commands.exportRun(runId, format, path)),
  listTests: (): Promise<TestConfig[]> => unwrap(commands.listTests()),
  saveTest: (config: TestConfig): Promise<TestConfig> => unwrap(commands.saveTest(config)),
  duplicateTest: (id: string): Promise<TestConfig> => unwrap(commands.duplicateTest(id)),
  deleteTest: (id: string): Promise<null> => unwrap(commands.deleteTest(id)),
  importAsset: (testId: string, path: string): Promise<Asset> => unwrap(commands.importAsset(testId, path)),
  previewData: (testId: string, file: string, format: DataFormat, hasHeader: boolean): Promise<DataPreview> =>
    unwrap(commands.previewData(testId, file, format, hasHeader)),
  testHosts: (config: TestConfig): Promise<HostInfo[]> => unwrap(commands.testHosts(config)),
  validateTest: (config: TestConfig): Promise<FieldError[]> => commands.validateTest(config),
  tryFlow: (config: TestConfig, scenario: string | null = null): Promise<TryResult> => unwrap(commands.tryFlow(config, scenario)),
  sendStep: (config: TestConfig, stepId: string, vars: KeyValue[]): Promise<TryResult> => unwrap(commands.sendStep(config, stepId, vars)),
  getSamples: (runId: string): Promise<Sample[]> => unwrap(commands.getSamples(runId)),
  getSettings: (): Promise<Settings> => commands.getSettings(),
  saveSettings: (s: Settings): Promise<Settings> => unwrap(commands.saveSettings(s)),
};

export const on = {
  snapshot: (cb: (s: Snapshot) => void): Promise<UnlistenFn> => events.runSnapshot.listen((e) => cb(e.payload)),
  finished: (cb: (s: RunSummary) => void): Promise<UnlistenFn> => events.runFinished.listen((e) => cb(e.payload)),
  error: (cb: (e: RunError) => void): Promise<UnlistenFn> => events.runError.listen((e) => cb(e.payload)),
};

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unexpected error";
}
