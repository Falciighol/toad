// Inline validation for the editor. Mirrors toad-core's `validate()`; the backend
// re-validates on start and is authoritative. Keys match Rust FieldError.field.
import type { LoadSpec, RequestSpec, Settings, TestConfig } from "../bindings";

export type Errors = Record<string, string>;
export type Limits = Pick<Settings, "max_concurrency" | "max_rps">;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Visible ASCII, space and tab (what an HTTP header value may contain).
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

export function validateUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return "URL is required";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Invalid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "URL must start with http:// or https://";
  if (!u.hostname) return "URL has no host";
  return null;
}

export function validateRequest(r: RequestSpec): Errors {
  const e: Errors = {};
  const urlErr = validateUrl(r.url);
  if (urlErr) e["request.url"] = urlErr;
  r.headers.forEach((h, i) => {
    if (!h.enabled) return;
    const key = `request.headers.${i}`;
    if (!h.name.trim()) e[key] = "Header name is required";
    else if (!TOKEN.test(h.name.trim())) e[key] = "Invalid header name";
    else if (!HEADER_VALUE.test(h.value)) e[key] = "Invalid header value";
  });
  if (r.body?.kind === "json" && r.body.content.trim()) {
    try {
      JSON.parse(r.body.content);
    } catch (err) {
      e["request.body"] = `Invalid JSON: ${err instanceof Error ? err.message : "parse error"}`;
    }
  }
  if (r.bearer && !HEADER_VALUE.test(r.bearer)) e["request.bearer"] = "Token contains invalid characters";
  return e;
}

const int = (n: number) => Number.isFinite(n) && Number.isInteger(n);

export function validateLoad(l: LoadSpec, limits: Limits): Errors {
  const e: Errors = {};
  if (!int(l.concurrency) || l.concurrency < 1) e["load.concurrency"] = "Concurrency must be at least 1";
  else if (l.concurrency > limits.max_concurrency)
    e["load.concurrency"] = `Concurrency is capped at ${limits.max_concurrency} (Settings)`;
  if (l.stop.kind === "requests") {
    if (!int(l.stop.count) || l.stop.count < 1) e["load.stop"] = "Request count must be at least 1";
  } else if (!int(l.stop.secs) || l.stop.secs < 1) e["load.stop"] = "Duration must be at least 1 second";
  else if (l.stop.secs > 86_400) e["load.stop"] = "Duration must be at most 24 hours";
  if (l.rps_cap !== null) {
    if (!int(l.rps_cap) || l.rps_cap < 1) e["load.rps_cap"] = "RPS cap must be at least 1";
    else if (l.rps_cap > limits.max_rps) e["load.rps_cap"] = `RPS is capped at ${limits.max_rps} (Settings)`;
  }
  if (l.ramp_up_secs !== null) {
    if (!int(l.ramp_up_secs) || l.ramp_up_secs < 0) e["load.ramp_up_secs"] = "Ramp-up must be a whole number of seconds";
    else if (l.ramp_up_secs > 3600) e["load.ramp_up_secs"] = "Ramp-up must be at most 3600 s";
    else if (l.stop.kind === "duration" && l.ramp_up_secs > 0 && l.ramp_up_secs >= l.stop.secs)
      e["load.ramp_up_secs"] = "Ramp-up must be shorter than the duration";
  }
  if (!int(l.timeout_ms) || l.timeout_ms < 1 || l.timeout_ms > 300_000)
    e["load.timeout_ms"] = "Timeout must be between 1 ms and 300 s";
  const r = l.success_range;
  if (!int(r.min) || !int(r.max) || r.min < 100 || r.max > 599 || r.min > r.max)
    e["load.success_range"] = "Status range must be within 100–599 and min ≤ max";
  return e;
}

export function validateConfig(c: TestConfig, limits: Limits): Errors {
  const e: Errors = { ...validateRequest(c.request), ...validateLoad(c.load, limits) };
  if (!c.name.trim()) e["name"] = "Name is required";
  return e;
}

export const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key"];
export const isSensitiveHeader = (name: string) => SENSITIVE_HEADERS.includes(name.trim().toLowerCase());
