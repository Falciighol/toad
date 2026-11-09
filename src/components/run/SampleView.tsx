import { useMemo, useState } from "react";
import type { KeyValue, Sample, StepOutcome, TraceEntry } from "../../bindings";
import { fmtBytes, fmtLatency } from "../../lib/format";
import { Icon, Pill, Tabs, type Tone } from "../ui";

export const OUTCOME: Record<StepOutcome, { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "warning" },
  not_taken: { label: "Not taken", tone: "neutral" },
  blocked: { label: "Blocked", tone: "warning" },
  build_error: { label: "Build error", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function statusTone(code: number | null | undefined): Tone {
  if (!code) return "neutral";
  if (code < 300) return "success";
  if (code < 400) return "info";
  if (code < 500) return "warning";
  return "danger";
}

function pretty(body: string, headers: KeyValue[]): { text: string; lang: "json" | "xml" | "text" } {
  const ct = headers.find((h) => h.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  const t = body.trim();
  if (ct.includes("json") || t.startsWith("{") || t.startsWith("[")) {
    try {
      return { text: JSON.stringify(JSON.parse(t), null, 2), lang: "json" };
    } catch {
      return { text: body, lang: "text" };
    }
  }
  if (ct.includes("xml") || t.startsWith("<")) return { text: body.replace(/>\s*</g, ">\n<"), lang: "xml" };
  if (ct.includes("x-www-form-urlencoded")) return { text: body.split("&").map((kv) => decodeURIComponent(kv.replace(/\+/g, " "))).join("\n"), lang: "text" };
  return { text: body, lang: "text" };
}

function Headers({ rows }: { rows: KeyValue[] }) {
  if (!rows.length) return <p className="text-small text-text4">No headers captured.</p>;
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-3 gap-y-1 font-mono text-small">
      {rows.map((h, i) => (
        <div key={i} className="contents">
          <dt className="truncate text-text3">{h.name}</dt>
          <dd className="min-w-0 break-all text-text select-text">{h.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Body({ body, bytes, truncated, binary, headers }: { body: string; bytes: number; truncated: boolean; binary: boolean; headers: KeyValue[] }) {
  const p = useMemo(() => pretty(body, headers), [body, headers]);
  if (!bytes) return <p className="text-small text-text4">Empty body.</p>;
  if (binary) return <p className="text-small text-text3">{body}</p>;
  if (!body) return <p className="text-small text-text3">{fmtBytes(bytes)} received; the body wasn't kept for this request (only failures, the slowest and the random sample keep bodies).</p>;
  return (
    <div>
      <pre className="max-h-96 overflow-auto rounded-lg bg-raised p-3 font-mono text-small leading-[18px] whitespace-pre-wrap break-all text-text select-text">{p.text}</pre>
      <p className="mt-1 text-micro text-text4">
        {fmtBytes(bytes)}
        {truncated && " · truncated: only the start was kept"}
      </p>
    </div>
  );
}

/** The request, response and context of one captured request. */
export function SampleView({ sample, stepName }: { sample: Sample; stepName?: (id: string) => string }) {
  const [tab, setTab] = useState<"response" | "request" | "context">(sample.response ? "response" : "request");
  const o = OUTCOME[sample.outcome];
  const req = sample.request;
  const resp = sample.response;
  const failedChecks = sample.checks.filter((c) => !c.passed).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={o.tone}>{o.label}</Pill>
        {resp && <Pill tone={statusTone(resp.status)}>{resp.status}</Pill>}
        {sample.branch === false && <Pill tone="neutral"><Icon name="branch" /> branch not taken</Pill>}
        <span className="tabular font-mono text-small text-text2">{fmtLatency(sample.latency_us)}</span>
        {sample.raw_us !== sample.latency_us && sample.raw_us > 0 && <span className="tabular font-mono text-small text-text4">service {fmtLatency(sample.raw_us)}</span>}
        <span className="ml-auto tabular font-mono text-micro text-text4">
          VU {sample.vu} · iteration {sample.iteration} · t+{(sample.t_ms / 1000).toFixed(2)} s
        </span>
      </div>
      {req && (
        <p className="font-mono text-small break-all text-text select-text">
          <span className="font-semibold">{req.method}</span> {req.url}
        </p>
      )}
      {sample.error && (
        <p className="flex gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-small text-danger">
          <Icon name="alert" className="mt-px size-3.5" />
          <span className="min-w-0 break-words">{sample.error}</span>
        </p>
      )}
      {sample.redirects.length > 0 && (
        <ol className="space-y-0.5 text-small text-text3">
          {sample.redirects.map((h, i) => (
            <li key={i} className="font-mono break-all">
              {h.status} → {h.url}
            </li>
          ))}
        </ol>
      )}
      <Tabs
        aria-label="Sample sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "response", label: "Response" },
          { value: "request", label: "Request" },
          { value: "context", label: "Checks & variables", count: sample.checks.length + sample.extracted.length, dot: failedChecks ? "danger" : null },
        ]}
      />
      {tab === "response" &&
        (resp ? (
          <div className="space-y-3">
            <Headers rows={resp.headers} />
            <Body body={resp.body} bytes={resp.body_bytes} truncated={resp.truncated} binary={resp.binary} headers={resp.headers} />
          </div>
        ) : (
          <p className="text-small text-text3">No response: {sample.error ?? "the request wasn't sent"}.</p>
        ))}
      {tab === "request" &&
        (req ? (
          <div className="space-y-3">
            <Headers rows={req.headers} />
            <Body body={req.body} bytes={req.body_bytes} truncated={req.truncated} binary={req.binary} headers={req.headers} />
          </div>
        ) : (
          <p className="text-small text-text3">Not sent.</p>
        ))}
      {tab === "context" && <Context sample={sample} stepName={stepName} />}
    </div>
  );
}

function Context({ sample, stepName }: { sample: Sample; stepName?: (id: string) => string }) {
  return (
    <div className="space-y-4">
      <section>
        <h4 className="mb-1.5 text-small font-medium text-text3">Checks</h4>
        {sample.checks.length === 0 ? (
          <p className="text-small text-text4">No checks on this step.</p>
        ) : (
          <ul className="space-y-1">
            {sample.checks.map((c) => (
              <li key={c.id} className="flex items-baseline gap-2 text-small">
                <Icon name={c.passed ? "check" : "x"} className={`size-3.5 self-center ${c.passed ? "text-success" : "text-danger"}`} />
                <span className="font-mono text-text">{c.label}</span>
                <span className="min-w-0 truncate font-mono text-text4">got {c.actual}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="mb-1.5 text-small font-medium text-text3">Extracted</h4>
        {sample.extracted.length === 0 ? (
          <p className="text-small text-text4">Nothing extracted here.</p>
        ) : (
          <ul className="space-y-1">
            {sample.extracted.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2 text-small">
                <span className="font-mono text-info">{e.var}</span>
                <span className="min-w-0 truncate font-mono text-text select-text">{e.value ?? <span className="text-danger">{e.error ?? "missing"}</span>}</span>
                {e.secret && <Icon name="lock" className="size-3 self-center text-text4" />}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="mb-1.5 text-small font-medium text-text3">Variables in scope</h4>
        {sample.vars.length === 0 ? (
          <p className="text-small text-text4">No variables were set yet.</p>
        ) : (
          <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-3 gap-y-1 font-mono text-small">
            {sample.vars.map((v) => (
              <div key={v.name} className="contents">
                <dt className="truncate text-text3">{v.name}</dt>
                <dd className="min-w-0 break-all text-text select-text">{v.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      {sample.trace.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-small font-medium text-text3">Earlier in this iteration</h4>
          <Trace entries={sample.trace} stepName={stepName} />
        </section>
      )}
    </div>
  );
}

/** The steps a virtual user went through before this one: outcome, status, latency. */
export function Trace({ entries, stepName }: { entries: TraceEntry[]; stepName?: (id: string) => string }) {
  const max = Math.max(1, ...entries.map((e) => e.latency_us));
  return (
    <ol className="space-y-1">
      {entries.map((e, i) => {
        const o = OUTCOME[e.outcome];
        return (
          <li key={i} className="grid grid-cols-[1fr_auto_120px] items-center gap-2 text-small">
            <span className="min-w-0 truncate text-text2">{stepName?.(e.step_id) ?? e.name}</span>
            <span className="flex items-center gap-1.5">
              {e.status ? <Pill tone={statusTone(e.status)}>{e.status}</Pill> : <Pill tone={o.tone}>{o.label}</Pill>}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 rounded-full bg-series1" style={{ width: `${Math.max(2, (e.latency_us / max) * 80)}px` }} />
              <span className="tabular font-mono text-micro text-text3">{e.latency_us ? fmtLatency(e.latency_us) : "–"}</span>
            </span>
            {e.note && e.outcome !== "ok" && <span className="col-span-3 -mt-0.5 text-micro text-text4">{e.note}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Build a curl command for a captured request. */
export function asCurl(s: Sample): string {
  const r = s.request;
  if (!r) return "";
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${r.method} ${q(r.url)}`];
  for (const h of r.headers) parts.push(`-H ${q(`${h.name}: ${h.value}`)}`);
  if (r.body && !r.binary) parts.push(`--data-raw ${q(r.body)}`);
  return parts.join(" \\\n  ");
}
