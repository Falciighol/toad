// `{{templates}}` in the UI: tokenizing for highlight, the names a step can read (for
// autocomplete), and rendering a preview with sample values. Mirrors toad-core's template.rs.
import type { TestConfig } from "../bindings";
import { extractedBefore } from "./flow";

export type Token =
  | { kind: "lit"; text: string }
  | { kind: "var"; text: string; name: string }
  | { kind: "gen"; text: string; name: string }
  | { kind: "bad"; text: string; error: string };

export const GENERATORS: { name: string; args: string; doc: string; sample: (args: string[]) => string }[] = [
  { name: "uuid", args: "", doc: "Random UUID v4", sample: () => crypto.randomUUID() },
  { name: "randomInt", args: "min, max", doc: "Integer from min to max", sample: ([a, b]) => String(Math.floor(Number(a) + Math.random() * (Number(b) - Number(a) + 1))) },
  { name: "randomFloat", args: "min, max, decimals", doc: "Decimal from min to max", sample: ([a, b, d]) => (Number(a) + Math.random() * (Number(b) - Number(a))).toFixed(Number(d ?? 2)) },
  { name: "randomString", args: "length", doc: "Letters and digits", sample: ([n]) => Array.from({ length: Math.min(64, Number(n) || 8) }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join("") },
  { name: "pick", args: "a, b, …", doc: "One of the arguments at random", sample: (a) => a[Math.floor(Math.random() * a.length)] ?? "" },
  { name: "seq", args: "", doc: "1, 2, 3… shared by every virtual user", sample: () => "1" },
  { name: "email", args: "", doc: "Random email at example.com", sample: () => `ada.lovelace${Math.floor(Math.random() * 9999)}@example.com` },
  { name: "name", args: "", doc: "Random first and last name", sample: () => "Grace Hopper" },
  { name: "firstName", args: "", doc: "Random first name", sample: () => "Grace" },
  { name: "lastName", args: "", doc: "Random last name", sample: () => "Hopper" },
  { name: "word", args: "", doc: "Random lowercase word", sample: () => "lantern" },
  { name: "timestamp", args: "", doc: "Epoch milliseconds at send time", sample: () => String(Date.now()) },
  { name: "timestampSec", args: "", doc: "Epoch seconds at send time", sample: () => String(Math.floor(Date.now() / 1000)) },
  { name: "isoDate", args: "", doc: "UTC date-time at send time", sample: () => new Date().toISOString() },
  { name: "base64", args: "text", doc: "Base64 of the argument", sample: ([t]) => btoa(unescape(encodeURIComponent(t ?? ""))) },
  { name: "urlencode", args: "text", doc: "Percent-encode the argument", sample: ([t]) => encodeURIComponent(t ?? "") },
  { name: "lower", args: "text", doc: "Lowercase the argument", sample: ([t]) => (t ?? "").toLowerCase() },
  { name: "upper", args: "text", doc: "Uppercase the argument", sample: ([t]) => (t ?? "").toUpperCase() },
];

export const BUILTINS: { name: string; doc: string; sample: string }[] = [
  { name: "vu.id", doc: "This virtual user's number", sample: "1" },
  { name: "iteration", doc: "Iteration number of this virtual user", sample: "1" },
  { name: "scenario", doc: "Scenario name", sample: "Main" },
  { name: "run.id", doc: "This run's id", sample: "run" },
];

function findClose(s: string, from: number): number {
  let depth = 0;
  for (let i = from; i + 1 < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "{") {
      i++;
      continue;
    }
    if (s[i] === "{" && s[i + 1] === "{") {
      depth++;
      i++;
    } else if (s[i] === "}" && s[i + 1] === "}") {
      if (depth === 0) return i;
      depth--;
      i++;
    }
  }
  return -1;
}

export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let lit = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("\\{{", i)) {
      lit += "\\{{";
      i += 3;
      continue;
    }
    if (s.startsWith("{{", i)) {
      const close = findClose(s, i + 2);
      if (lit) out.push({ kind: "lit", text: lit });
      lit = "";
      if (close < 0) {
        out.push({ kind: "bad", text: s.slice(i), error: "`{{` is never closed" });
        return out;
      }
      const text = s.slice(i, close + 2);
      const inner = s.slice(i + 2, close).trim();
      if (inner.startsWith("$")) {
        const name = inner.slice(1).split("(")[0]!.trim();
        if (GENERATORS.some((g) => g.name === name)) out.push({ kind: "gen", text, name });
        else out.push({ kind: "bad", text, error: `unknown generator $${name}` });
      } else if (/^[A-Za-z0-9_.-]+$/.test(inner)) out.push({ kind: "var", text, name: inner });
      else out.push({ kind: "bad", text, error: inner ? "variable names use letters, digits, _ - ." : "empty {{}}" });
      i = close + 2;
      continue;
    }
    lit += s[i];
    i++;
  }
  if (lit) out.push({ kind: "lit", text: lit });
  return out;
}

export const hasTemplates = (s: string) => s.includes("{{");

export type NameSource = "env" | "data" | "extract" | "builtin" | "value" | "base";
export type Name = { name: string; source: NameSource; detail: string; secret?: boolean };

/** Every name a step can read, with where it comes from. */
export function namesFor(c: TestConfig, stepId: string | null): Name[] {
  const out: Name[] = [];
  const env = c.environments.find((e) => e.id === c.active_env);
  if (c.defaults.base_url.trim() && !c.variables.some((v) => v.name === "baseUrl"))
    out.push({ name: "baseUrl", source: "base", detail: c.defaults.base_url.trim() });
  for (const v of c.variables)
    out.push({ name: v.name, source: "env", detail: v.secret ? "secret" : (v.values[c.active_env] ?? "") || (env ? `empty in ${env.name}` : "no value"), secret: v.secret });
  for (const f of c.data) for (const col of f.columns) out.push({ name: `${f.name}.${col}`, source: "data", detail: f.original_name, secret: f.secret_columns.includes(col) });
  for (const e of extractedBefore(c, stepId)) out.push({ name: e.name, source: "extract", detail: `from ${e.from}` });
  for (const b of BUILTINS) out.push({ name: b.name, source: "builtin", detail: b.doc });
  return out;
}

export type Resolved = { text: string; kind: "lit" | "value" | "missing" | "pending" | "secret"; note?: string };

/**
 * Render with sample values. Variables come from the environment, a data file's first
 * row, the last Try once, or are reported as pending/missing with the reason.
 */
export function preview(s: string, ctx: { vars: Map<string, string>; pending: Map<string, string>; secrets: Set<string> }): Resolved[] {
  const out: Resolved[] = [];
  for (const t of tokenize(s)) {
    if (t.kind === "lit") out.push({ text: t.text.replaceAll("\\{{", "{{"), kind: "lit" });
    else if (t.kind === "var") {
      if (ctx.secrets.has(t.name) && ctx.vars.has(t.name)) out.push({ text: "••••••", kind: "secret", note: `${t.name} (secret)` });
      else if (ctx.vars.has(t.name)) out.push({ text: ctx.vars.get(t.name)!, kind: "value", note: t.name });
      else if (ctx.pending.has(t.name)) out.push({ text: `{{${t.name}}}`, kind: "pending", note: ctx.pending.get(t.name) });
      else out.push({ text: `{{${t.name}}}`, kind: "missing", note: `${t.name} isn't defined before this step` });
    } else if (t.kind === "gen") {
      const g = GENERATORS.find((x) => x.name === t.name)!;
      const inner = t.text.slice(2, -2).trim();
      const argText = inner.includes("(") ? inner.slice(inner.indexOf("(") + 1, inner.lastIndexOf(")")) : "";
      const args = argText ? argText.split(",").map((a) => preview(a.trim(), ctx).map((r) => r.text).join("")) : [];
      out.push({ text: g.sample(args), kind: "value", note: `$${g.name}` });
    } else out.push({ text: t.text, kind: "missing", note: t.error });
  }
  return out;
}

/** The `{{…` being typed at the caret, for autocomplete: [start index, query]. */
export function openPlaceholder(s: string, caret: number): [number, string] | null {
  const before = s.slice(0, caret);
  const start = before.lastIndexOf("{{");
  if (start < 0 || before.indexOf("}}", start) >= 0) return null;
  const q = before.slice(start + 2);
  if (/[\s}]/.test(q) && !q.startsWith("$")) return null;
  return [start, q];
}
