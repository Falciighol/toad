// Paste a cURL command, get a request step. Supports the flags browsers' "Copy as cURL"
// and API docs use; anything else is reported, not silently dropped.
import type { BodyKind, KeyValue, RequestStep } from "../bindings";
import { newBody, newStep } from "./defaults";

export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let any = false;
  const s = cmd.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      any = true;
    } else if (c === "$" && s[i + 1] === "'") {
      // ANSI-C quoting: $'...'
      let j = i + 2;
      while (j < s.length && s[j] !== "'") {
        if (s[j] === "\\" && j + 1 < s.length) {
          const n = s[++j]!;
          cur += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
        } else cur += s[j];
        j++;
      }
      i = j;
      any = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (cur || any) out.push(cur);
  return out;
}

export type CurlResult = { step: RequestStep; ignored: string[] } | { error: string };

const NO_ARG = new Set(["--compressed", "-s", "--silent", "-L", "--location", "-k", "--insecure", "-i", "--include", "-v", "--verbose", "-S", "--show-error", "-f", "--fail", "-g", "--globoff", "--http1.1", "--http2"]);

export function parseCurl(cmd: string): CurlResult {
  const w = shellWords(cmd.trim());
  if (w[0] !== "curl") return { error: "Paste a command that starts with curl" };
  const step = newStep("");
  const headers: KeyValue[] = [];
  const data: string[] = [];
  const form: { name: string; value: string }[] = [];
  const ignored: string[] = [];
  let method: string | null = null;
  let user: string | null = null;
  let dataKind: "raw" | "urlencode" | null = null;
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    const next = () => w[++i] ?? "";
    if (a === "-X" || a === "--request") method = next().toUpperCase();
    else if (a === "-H" || a === "--header") {
      const h = next();
      const k = h.indexOf(":");
      if (k > 0) headers.push({ name: h.slice(0, k).trim(), value: h.slice(k + 1).trim(), enabled: true });
    } else if (a === "-d" || a === "--data" || a === "--data-raw" || a === "--data-binary" || a === "--data-ascii") {
      const v = next();
      if (v.startsWith("@")) ignored.push(`${a} ${v} (file bodies: choose the file in Body → Binary)`);
      else data.push(v);
      dataKind ??= "raw";
    } else if (a === "--data-urlencode") {
      data.push(next());
      dataKind = "urlencode";
    } else if (a === "-F" || a === "--form") {
      const v = next();
      const k = v.indexOf("=");
      if (k > 0) form.push({ name: v.slice(0, k), value: v.slice(k + 1) });
    } else if (a === "-u" || a === "--user") user = next();
    else if (a === "-b" || a === "--cookie") {
      for (const part of next().split(";")) {
        const k = part.indexOf("=");
        if (k > 0) step.cookies.push({ name: part.slice(0, k).trim(), value: part.slice(k + 1).trim(), enabled: true });
      }
    } else if (a === "-A" || a === "--user-agent") headers.push({ name: "User-Agent", value: next(), enabled: true });
    else if (a === "-e" || a === "--referer") headers.push({ name: "Referer", value: next(), enabled: true });
    else if (a === "--url") step.url = next();
    else if (a === "-k" || a === "--insecure") ignored.push(`${a} (set "Allow invalid certificates" in Load → Connection)`);
    else if (NO_ARG.has(a)) continue;
    else if (a.startsWith("-")) ignored.push(a);
    else if (!step.url) step.url = a;
  }
  if (!step.url) return { error: "No URL found in the command" };
  if (!/^https?:\/\//i.test(step.url)) step.url = `http://${step.url}`;

  // Body.
  const ctIdx = headers.findIndex((h) => h.name.toLowerCase() === "content-type");
  const ct = ctIdx >= 0 ? headers[ctIdx]!.value.toLowerCase() : "";
  if (form.length) {
    step.body = { ...newBody("multipart"), fields: form.map((f) => ({ name: f.name, value: f.value.startsWith("@") ? "" : f.value, enabled: true, file: f.value.startsWith("@") })) };
    if (form.some((f) => f.value.startsWith("@"))) ignored.push("-F file fields (choose the files in Body)");
    if (ctIdx >= 0) headers.splice(ctIdx, 1);
  } else if (data.length) {
    const text = data.join("&");
    const urlencoded = dataKind === "urlencode" || ct.includes("x-www-form-urlencoded") || (!ct && /^[^{<\s][^=\s]*=/.test(text));
    let kind: BodyKind = "text";
    if (ct.includes("json") || (!ct && /^\s*[[{]/.test(text))) kind = "json";
    else if (ct.includes("xml")) kind = "xml";
    else if (ct.includes("graphql")) kind = "graphql";
    if (urlencoded && kind === "text") {
      const fields = text.split("&").map((kv) => {
        const k = kv.indexOf("=");
        const dec = (x: string) => {
          try {
            return decodeURIComponent(x.replace(/\+/g, " "));
          } catch {
            return x;
          }
        };
        return { name: dec(k < 0 ? kv : kv.slice(0, k)), value: dec(k < 0 ? "" : kv.slice(k + 1)), enabled: true, file: false };
      });
      step.body = { ...newBody("form"), fields };
      if (ctIdx >= 0) headers.splice(ctIdx, 1);
    } else {
      step.body = { ...newBody(kind), content: kind === "json" ? prettyJson(text) : text };
      if (ctIdx >= 0 && (kind === "json" || kind === "xml") && /^(application|text)\/(json|xml)\s*$/.test(ct)) headers.splice(ctIdx, 1);
      else if (ctIdx >= 0) {
        step.body.content_type = headers[ctIdx]!.value;
        headers.splice(ctIdx, 1);
      }
    }
  }
  step.method = method ?? (step.body ? "POST" : "GET");

  // Auth.
  const authIdx = headers.findIndex((h) => h.name.toLowerCase() === "authorization");
  if (authIdx >= 0) {
    const v = headers[authIdx]!.value;
    const m = v.match(/^Bearer\s+(.+)$/i);
    if (m) {
      step.auth = { kind: "bearer", token: m[1]!.trim() };
      headers.splice(authIdx, 1);
    }
  }
  if (user !== null) {
    const k = user.indexOf(":");
    step.auth = { kind: "basic", username: k < 0 ? user : user.slice(0, k), password: k < 0 ? "" : user.slice(k + 1) };
  }

  // Query string → params.
  try {
    const u = new URL(step.url);
    if (u.search) {
      u.searchParams.forEach((value, name) => step.params.push({ name, value, enabled: true }));
      step.url = step.url.slice(0, step.url.indexOf("?"));
    }
  } catch {
    // Leave the URL as written; validation reports it.
  }
  step.headers = headers.filter((h) => !["content-length", "host", "connection", "accept-encoding"].includes(h.name.toLowerCase()));
  return { step, ignored };
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
