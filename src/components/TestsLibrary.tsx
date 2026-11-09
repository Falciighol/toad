import { useState } from "react";
import type { RunSummary, TestConfig } from "../bindings";
import { parseCurl } from "../lib/curl";
import { newTest } from "../lib/defaults";
import { allSteps } from "../lib/flow";
import { fmtDate, fmtLatency } from "../lib/format";
import { Icon, IconButton, Menu, Pill } from "./ui";

function Trend({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-micro text-text4">{values.length ? "1 run" : "–"}</span>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 72},${17 - ((v - min) / span) * 14}`).join(" ");
  return (
    <svg width="72" height="20" className="text-series1" aria-label={`p95 over the last ${values.length} runs`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="72" cy={17 - ((values[values.length - 1]! - min) / span) * 14} r="2" fill="currentColor" />
    </svg>
  );
}

function verdictOf(r: RunSummary | undefined): { tone: "success" | "danger" | "neutral"; label: string } | null {
  if (!r) return null;
  if (r.end_reason === "failed") return { tone: "danger", label: "Failed" };
  if (r.end_reason === "aborted") return { tone: "danger", label: "Aborted" };
  const v = r.verdict ?? [];
  if (v.length) return v.every((x) => x.passed || x.pending) ? { tone: "success", label: "Pass" } : { tone: "danger", label: "Fail" };
  return { tone: "neutral", label: r.end_reason === "stopped" ? "Stopped" : "No verdict" };
}

export function TestsLibrary(props: {
  tests: TestConfig[];
  runs: RunSummary[];
  onOpen: (t: TestConfig) => void;
  onNew: (t: TestConfig) => void;
  onDuplicate: (id: string) => void;
  onDelete: (t: TestConfig) => void;
}) {
  const [curl, setCurl] = useState(false);
  const [text, setText] = useState("");
  const parsed = text.trim() ? parseCurl(text) : null;
  const runsOf = (id: string) => props.runs.filter((r) => r.config.id === id);
  return (
    <div className="mx-auto max-w-5xl px-8 py-7">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">Tests</h1>
          <p className="mt-1 text-body text-text3">Every test saves as you edit. Open one to change it or run it again.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={() => setCurl((o) => !o)} aria-expanded={curl}>
            <Icon name="terminal" className="size-3.5" /> From cURL
          </button>
          <button type="button" className="btn btn-primary" onClick={() => props.onNew(newTest())}>
            <Icon name="plus" className="size-3.5" /> New test
          </button>
        </div>
      </div>
      {curl && (
        <div className="card mb-5 space-y-2 p-4">
          <label htmlFor="curl-new" className="label">
            Paste a cURL command; it becomes the test's first step
          </label>
          <textarea id="curl-new" autoFocus className="input h-28 font-mono text-small" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder="curl https://api.example.com/users -H 'Accept: application/json'" />
          {parsed && "error" in parsed && <p role="alert" className="text-small text-danger">{parsed.error}</p>}
          {parsed && "step" in parsed && parsed.ignored.length > 0 && <p className="text-small text-warning">Not imported: {parsed.ignored.join(", ")}</p>}
          <div className="flex justify-end">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!parsed || "error" in parsed}
              onClick={() => {
                if (!parsed || !("step" in parsed)) return;
                const t = newTest();
                t.scenarios[0]!.steps = [{ kind: "request", step: parsed.step }];
                try {
                  t.name = new URL(parsed.step.url).host;
                } catch {
                  /* keep the default name */
                }
                props.onNew(t);
              }}
            >
              Create test
            </button>
          </div>
        </div>
      )}
      {props.tests.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-line2 px-6 py-14 text-center">
          <Icon name="flow" className="size-8 text-text4" />
          <p className="mt-3 text-title font-semibold">No tests yet</p>
          <p className="mt-1 max-w-md text-body text-text3">Start with one request and press Start, or build a flow: log in, extract a token, call the API with it.</p>
          <p className="mt-4 text-small text-text3">No API handy? Run the bundled mock server:</p>
          <code className="mt-1.5 rounded border border-line2 px-2 py-1 font-mono text-small text-text2 select-all">cargo run --release --example mock_server</code>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b border-line text-left text-small text-text3">
                <th className="py-2 pr-2 pl-4 font-medium">Test</th>
                <th className="px-2 py-2 font-medium">Last run</th>
                <th className="px-2 py-2 font-medium">p95 trend</th>
                <th className="w-20 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {props.tests.map((t) => {
                const runs = runsOf(t.id);
                const last = runs[0];
                const v = verdictOf(last);
                const steps = allSteps(t, true).filter((r) => r.phase === "main").length;
                const scen = t.scenarios.filter((s) => s.enabled).length;
                const env = t.environments.find((e) => e.id === t.active_env);
                const trend = runs
                  .slice(0, 12)
                  .reverse()
                  .map((r) => (r.capped ? r.latency_corrected : r.latency_raw).p95)
                  .filter((x) => x > 0);
                return (
                  <tr key={t.id} className="border-b border-line last:border-0 hover:bg-raised">
                    <td className="max-w-0 py-2.5 pr-2 pl-4">
                      <button type="button" className="block w-full text-left" onClick={() => props.onOpen(t)}>
                        <span className="block truncate font-medium text-text">{t.name || "Untitled test"}</span>
                        <span className="block truncate text-small text-text3">
                          {steps} {steps === 1 ? "step" : "steps"}
                          {scen > 1 && ` · ${scen} scenarios`}
                          {env && ` · ${env.name}`} · edited {fmtDate(t.updated_at)}
                        </span>
                      </button>
                    </td>
                    <td className="px-2 py-2.5">
                      {last ? (
                        <span className="flex items-center gap-2">
                          {v && <Pill tone={v.tone}>{v.label}</Pill>}
                          <span className="tabular font-mono text-small text-text3">{fmtLatency((last.capped ? last.latency_corrected : last.latency_raw).p95)}</span>
                        </span>
                      ) : (
                        <span className="text-small text-text4">Never run</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <Trend values={trend} />
                    </td>
                    <td className="py-2 pr-3 pl-2 text-right">
                      <span className="inline-flex gap-0.5">
                        <IconButton icon="copy" size="sm" label={`Duplicate ${t.name}`} onClick={() => props.onDuplicate(t.id)} />
                        <Menu label={`More for ${t.name}`} items={[{ label: "Delete test", icon: "trash", danger: true, hint: "Its runs stay in Runs", onSelect: () => props.onDelete(t) }]} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
