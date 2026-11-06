import type { LoadSpec, Settings, TestConfig } from "../bindings";

export const defaultLoad = (): LoadSpec => ({
  concurrency: 50,
  stop: { kind: "duration", secs: 30 },
  rps_cap: null,
  ramp_up_secs: null,
  timeout_ms: 10_000,
  success_range: { min: 200, max: 399 },
  follow_redirects: true,
  allow_invalid_certs: false,
});

export const newConfig = (): TestConfig => ({
  id: "",
  name: "Untitled test",
  request: { method: "GET", url: "http://localhost:8787/", headers: [], body: null, bearer: null },
  load: defaultLoad(),
  created_at: 0,
  updated_at: 0,
});

export const defaultSettings = (): Settings => ({
  max_concurrency: 1000,
  max_rps: 20_000,
  history_limit: 100,
  strip_secrets_on_export: true,
  store_secrets_in_history: false,
  private_ranges_as_local: false,
});
