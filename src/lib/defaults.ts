import type {
  BodyKind,
  BodySpec,
  Check,
  Executor,
  Extractor,
  FlowItem,
  RequestStep,
  Scenario,
  Settings,
  TestConfig,
  Threshold,
} from "../bindings";

/** Short random ids for steps, scenarios and rules (unique within a test). */
export function uid(prefix = ""): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return prefix + (a[0]!.toString(36) + a[1]!.toString(36)).slice(0, 10);
}

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export const newStep = (url = "", method = "GET"): RequestStep => ({
  id: uid("r"),
  name: "",
  method,
  url,
  params: [],
  headers: [],
  cookies: [],
  cookie_mode: "jar",
  body: null,
  auth: { kind: "inherit" },
  values: [],
  extract: [],
  checks: [],
  run_if: null,
  timeout_ms: null,
  follow_redirects: null,
  max_response_kb: null,
  weight: 1,
});

export const newBody = (kind: BodyKind, prev?: BodySpec | null): BodySpec => ({
  kind,
  content: prev?.content ?? "",
  fields: prev?.fields ?? [],
  variables: prev?.variables ?? "",
  file: prev?.file ?? null,
  content_type: "",
  gzip: prev?.gzip ?? false,
});

export const defaultExecutor = (): Executor => ({ kind: "vus", vus: 50, duration_secs: 30 });

export const newScenario = (name: string, url = ""): Scenario => ({
  id: uid("s"),
  name,
  kind: "flow",
  enabled: true,
  init: [],
  steps: url ? [{ kind: "request", step: newStep(url) }] : [],
  executor: defaultExecutor(),
  start_offset_secs: 0,
  graceful_stop_secs: 2,
  think: null,
});

export function newTest(url = "http://localhost:8787/"): TestConfig {
  return {
    version: 2,
    id: "",
    name: "Untitled test",
    created_at: 0,
    updated_at: 0,
    defaults: {
      base_url: "",
      headers: [],
      auth: { kind: "none" },
      user_agent: "",
      timeout_ms: 10_000,
      success_range: { min: 200, max: 399 },
      follow_redirects: true,
      max_redirects: 5,
      max_response_kb: 1024,
    },
    environments: [],
    active_env: "",
    variables: [],
    data: [],
    cookies: { mode: "per_vu", clear_each_iteration: false, seed: [] },
    connection: {
      keep_alive: true,
      pool: "shared",
      http: "auto",
      allow_invalid_certs: false,
      host_overrides: [],
      client_certs: [],
      proxy: { enabled: false, kind: "http", address: "", username: "", password: "", no_proxy: "" },
    },
    setup: [],
    teardown: [],
    scenarios: [newScenario("Main", url)],
    thresholds: [],
    warmup_secs: 0,
  };
}

export const newExtractor = (): Extractor => ({
  id: uid("x"),
  var: "",
  source: "json",
  expr: "$.",
  pick: "first",
  index: 0,
  default: "",
  on_missing: "skip_iteration",
  secret: false,
  enabled: true,
});

export const newCheck = (): Check => ({
  id: uid("c"),
  kind: "status",
  expr: "",
  op: "in_range",
  value: "200-299",
  fails_request: true,
  enabled: true,
});

export const newThreshold = (): Threshold => ({
  id: uid("t"),
  metric: "p95",
  scope: "",
  op: "lt",
  value: 500,
  abort: false,
  delay_secs: 0,
  enabled: true,
});

export const pauseItem = (): FlowItem => ({ kind: "pause", pause: { id: uid("p"), think: { kind: "fixed", ms: 1000 }, run_if: null } });

export const groupItem = (url = ""): FlowItem => ({
  kind: "group",
  group: { id: uid("g"), name: "", steps: [newStep(url), newStep(url)], run_if: null },
});

export const defaultSettings = (): Settings => ({
  max_concurrency: 1000,
  max_rps: 20_000,
  history_limit: 100,
  strip_secrets_on_export: true,
  store_secrets_in_history: false,
  private_ranges_as_local: false,
  sample_failures: 200,
  sample_slowest: 50,
  sample_random: 100,
  sample_body_kb: 64,
  sample_run_mb: 50,
  sample_bodies: true,
});
