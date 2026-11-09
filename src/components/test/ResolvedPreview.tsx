import { useMemo, useState } from "react";
import type { KeyValue, RequestStep, TestConfig } from "../../bindings";
import { extractedBefore } from "../../lib/flow";
import { preview, type Resolved } from "../../lib/template";
import { isSensitiveHeader } from "../../lib/validate";
import { Icon, IconButton } from "../ui";

function Line({ parts }: { parts: Resolved[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "lit" ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === "value" ? (
          <span key={i} className="rounded-sm bg-info-soft text-info" title={p.note}>
            {p.text}
          </span>
        ) : p.kind === "secret" ? (
          <span key={i} className="text-text3" title={p.note}>
            {p.text}
          </span>
        ) : (
          <span key={i} className={`rounded-sm ${p.kind === "pending" ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger"}`} title={p.note}>
            {p.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * The selected step as virtual user 1 would send it on its first iteration: every template
 * filled in. Values from earlier steps come from the last Try once; until then they're
 * shown pending, with where they come from.
 */
export function ResolvedPreview({ config, step, tryVars }: { config: TestConfig; step: RequestStep; tryVars: KeyValue[] | null }) {
  const [seed, setSeed] = useState(0);
  const ctx = useMemo(() => {
    const vars = new Map<string, string>();
    const pending = new Map<string, string>();
    const secrets = new Set<string>();
    if (config.defaults.base_url.trim()) vars.set("baseUrl", config.defaults.base_url.trim().replace(/\/$/, ""));
    for (const v of config.variables) {
      vars.set(v.name, v.values[config.active_env] ?? "");
      if (v.secret) secrets.add(v.name);
    }
    for (const f of config.data) for (const c of f.columns) pending.set(`${f.name}.${c}`, `a row of ${f.original_name}, picked at run time`);
    for (const e of extractedBefore(config, step.id)) pending.set(e.name, `extracted ${e.from}. Run Try once to fill it`);
    vars.set("vu.id", "1");
    vars.set("iteration", "1");
    vars.set("scenario", config.scenarios[0]?.name ?? "Main");
    vars.set("run.id", "preview");
    for (const v of tryVars ?? []) {
      vars.set(v.name, v.value);
      pending.delete(v.name);
    }
    for (const v of step.values.filter((x) => x.enabled && x.name.trim())) vars.set(v.name.trim(), preview(v.value, { vars, pending, secrets }).map((p) => p.text).join(""));
    return { vars, pending, secrets };
    // `seed` re-rolls the generators.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, step, tryVars, seed]);

  const url = useMemo(() => {
    const base = preview(step.url, ctx);
    const params = step.params.filter((p) => p.enabled && p.name.trim());
    const q: Resolved[] = [];
    params.forEach((p, i) => {
      q.push({ text: i === 0 && !step.url.includes("?") ? "?" : "&", kind: "lit" });
      q.push(...preview(p.name, ctx), { text: "=", kind: "lit" }, ...preview(p.value, ctx));
    });
    if (step.auth.kind === "api_key" && step.auth.location === "query") q.push({ text: `${q.length || step.url.includes("?") ? "&" : "?"}${step.auth.name}=`, kind: "lit" }, ...preview(step.auth.value, ctx));
    return [...base, ...q];
  }, [step, ctx]);

  const auth = config.defaults.auth;
  const effAuth = step.auth.kind === "inherit" ? auth : step.auth;
  const headers: [string, Resolved[]][] = [];
  for (const h of config.defaults.headers.filter((h) => h.enabled && h.name.trim()))
    if (!step.headers.some((x) => x.enabled && x.name.trim().toLowerCase() === h.name.trim().toLowerCase())) headers.push([h.name, preview(h.value, ctx)]);
  for (const h of step.headers.filter((h) => h.enabled && h.name.trim())) headers.push([h.name, isSensitiveHeader(h.name) ? [{ text: "••••••", kind: "secret" }] : preview(h.value, ctx)]);
  if (effAuth.kind === "bearer") headers.push(["Authorization", [{ text: "Bearer ", kind: "lit" }, ...preview(effAuth.token, ctx).map((p) => (p.kind === "value" ? { ...p, text: "••••••", kind: "secret" as const } : p))]]);
  if (effAuth.kind === "basic") headers.push(["Authorization", [{ text: "Basic ••••••", kind: "secret" }]]);
  if (effAuth.kind === "api_key" && effAuth.location === "header") headers.push([effAuth.name, [{ text: "••••••", kind: "secret" }]]);
  if (step.cookies.some((c) => c.enabled)) headers.push(["Cookie", [{ text: `${step.cookies.filter((c) => c.enabled).map((c) => `${c.name}=••••`).join("; ")} + jar`, kind: "lit" }]]);
  const b = step.body;
  let body: Resolved[] | null = null;
  if (b) {
    if (b.kind === "form") body = b.fields.filter((f) => f.enabled).flatMap((f, i) => [{ text: i ? "&" : "", kind: "lit" as const }, ...preview(f.name, ctx), { text: "=", kind: "lit" as const }, ...preview(f.value, ctx)]);
    else if (b.kind === "multipart") body = [{ text: b.fields.filter((f) => f.enabled).map((f) => `${f.name}: ${f.file ? `<file ${f.value.replace(/^[0-9a-f]{12}-/, "") || "not chosen"}>` : f.value}`).join("\n"), kind: "lit" }];
    else if (b.kind === "binary") body = [{ text: b.file ? `<${b.file.replace(/^[0-9a-f]{12}-/, "")}>` : "<no file chosen>", kind: "lit" }];
    else if (b.kind === "graphql") body = [{ text: '{"query": "', kind: "lit" }, ...preview(b.content, ctx), { text: '", "variables": ', kind: "lit" }, ...preview(b.variables || "null", ctx), { text: "}", kind: "lit" }];
    else body = preview(b.content, ctx);
  }
  const unresolved = [...url, ...headers.flatMap(([, v]) => v), ...(body ?? [])].filter((p) => p.kind === "missing" || p.kind === "pending");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="text-small font-medium text-text2">Resolved request</span>
        <span className="text-micro text-text4">VU 1 · iteration 1</span>
        {unresolved.length > 0 && <span className="text-micro text-warning">{unresolved.length} pending</span>}
        <span className="flex-1" />
        <IconButton icon="layers" size="sm" label="Re-roll generated values" onClick={() => setSeed((s) => s + 1)} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-small leading-[18px] text-text select-text">
        <div className="break-all">
          <span className="font-semibold">{step.method}</span> <Line parts={url} />
        </div>
        {headers.map(([n, v], i) => (
          <div key={i} className="break-all">
            <span className="text-text3">{n}:</span> <Line parts={v} />
          </div>
        ))}
        {body && (
          <pre className="mt-2 font-mono whitespace-pre-wrap break-all">
            <Line parts={body} />
          </pre>
        )}
        {unresolved.length > 0 && (
          <ul className="mt-3 space-y-0.5 font-sans text-micro">
            {[...new Map(unresolved.map((p) => [p.text, p])).values()].map((p) => (
              <li key={p.text} className={p.kind === "pending" ? "text-warning" : "text-danger"}>
                <Icon name="alert" className="mr-1 inline size-3 align-[-2px]" />
                <span className="font-mono">{p.text}</span> {p.note}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
