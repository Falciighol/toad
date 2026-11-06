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
  if (!url) return "Enter the URL to test";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Enter a full URL, like https://api.example.com/users";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "URL must start with http:// or https://";
  if (!u.hostname) return "Add a host after the scheme, like https://localhost:8080";
  return null;
}

export function validateRequest(r: RequestSpec): Errors {
  const e: Errors = {};
  const urlErr = validateUrl(r.url);
  if (urlErr) e["request.url"] = urlErr;
  r.headers.forEach((h, i) => {
    if (!h.enabled) return;
    const key = `request.headers.${i}`;
    if (!h.name.trim()) e[key] = "Name this header, or untick it to skip it";
    else if (!TOKEN.test(h.name.trim())) e[key] = "Header names can't contain spaces or : ( ) , ; \" / [ ] { } < > = ? @";
    else if (!HEADER_VALUE.test(h.value)) e[key] = "Header value has a line break or control character";
  });
  if (r.body?.kind === "json" && r.body.content.trim()) {
    try {
      JSON.parse(r.body.content);
    } catch (err) {
      e["request.body"] = `Not valid JSON: ${err instanceof Error ? err.message : "parse error"}`;
    }
  }
  if (r.bearer && !HEADER_VALUE.test(r.bearer)) e["request.bearer"] = "Token has a line break or control character";
  return e;
}

const int = (n: number) => Number.isFinite(n) && Number.isInteger(n);

export function validateLoad(l: LoadSpec, limits: Limits): Errors {
  const e: Errors = {};
  if (!int(l.concurrency) || l.concurrency < 1) e["load.concurrency"] = "Use at least 1 worker";
  else if (l.concurrency > limits.max_concurrency)
    e["load.concurrency"] = `Use at most ${limits.max_concurrency} workers, or raise the limit in Settings`;
  if (l.stop.kind === "requests") {
    if (!int(l.stop.count) || l.stop.count < 1) e["load.stop"] = "Send at least 1 request";
  } else if (!int(l.stop.secs) || l.stop.secs < 1) e["load.stop"] = "Run for at least 1 second";
  else if (l.stop.secs > 86_400) e["load.stop"] = "Run for at most 86400 s (24 hours)";
  if (l.rps_cap !== null) {
    if (!int(l.rps_cap) || l.rps_cap < 1) e["load.rps_cap"] = "Set the cap to at least 1 rps, or leave it empty";
    else if (l.rps_cap > limits.max_rps) e["load.rps_cap"] = `Use at most ${limits.max_rps} rps, or raise the limit in Settings`;
  }
  if (l.ramp_up_secs !== null) {
    if (!int(l.ramp_up_secs) || l.ramp_up_secs < 0) e["load.ramp_up_secs"] = "Use a whole number of seconds";
    else if (l.ramp_up_secs > 3600) e["load.ramp_up_secs"] = "Ramp up for at most 3600 s (1 hour)";
    else if (l.stop.kind === "duration" && l.ramp_up_secs > 0 && l.ramp_up_secs >= l.stop.secs)
      e["load.ramp_up_secs"] = "Ramp-up must end before the run does; shorten it or lengthen the duration";
  }
  if (!int(l.timeout_ms) || l.timeout_ms < 1 || l.timeout_ms > 300_000)
    e["load.timeout_ms"] = "Use a timeout from 1 to 300000 ms (5 minutes)";
  const r = l.success_range;
  if (!int(r.min) || !int(r.max) || r.min < 100 || r.max > 599 || r.min > r.max)
    e["load.success_range"] = "Use codes from 100 to 599, with the first no higher than the second";
  return e;
}

export function validateConfig(c: TestConfig, limits: Limits): Errors {
  const e: Errors = { ...validateRequest(c.request), ...validateLoad(c.load, limits) };
  if (!c.name.trim()) e["name"] = "Give the test a name";
  return e;
}

export const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key"];
export const isSensitiveHeader = (name: string) => SENSITIVE_HEADERS.includes(name.trim().toLowerCase());
