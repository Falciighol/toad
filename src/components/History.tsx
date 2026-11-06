import { useState } from "react";
import type { ExportFormat, RunSummary } from "../bindings";
import { fmtDate, fmtInt, fmtLatency, fmtPct, fmtRps } from "../lib/format";

export function History(props: {
  runs: RunSummary[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string, f: ExportFormat) => void;
  onCompare: (a: string, b: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  if (props.runs.length === 0) {
    return <div className="card p-6 text-center text-sm text-ink-3">No runs yet. Finished runs show up here.</div>;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-3">Tick two runs to compare them.</p>
        <button type="button" className="btn btn-primary" disabled={picked.length !== 2} onClick={() => props.onCompare(picked[0]!, picked[1]!)}>
          Compare {picked.length}/2
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="tabular w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left text-ink-2">
              <th className="w-8 px-3 py-2" />
              <th className="px-2 py-2 font-medium">When</th>
              <th className="px-2 py-2 font-medium">Test</th>
              <th className="px-2 py-2 text-right font-medium">Requests</th>
              <th className="px-2 py-2 text-right font-medium">Errors</th>
              <th className="px-2 py-2 text-right font-medium">RPS</th>
              <th className="px-2 py-2 text-right font-medium">p99</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {props.runs.map((r) => (
              <tr key={r.run_id} className="border-b border-line last:border-0 hover:bg-surface-2">
                <td className="px-3 py-2">
                  <input type="checkbox" aria-label={`Select run ${fmtDate(r.started_at)}`} className="accent-[var(--c-accent)]" checked={picked.includes(r.run_id)} onChange={() => toggle(r.run_id)} />
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <button type="button" className="text-left hover:underline" onClick={() => props.onOpen(r.run_id)}>
                    {fmtDate(r.started_at)}
                  </button>
                  {r.end_reason !== "completed" && <span className="ml-1 text-ink-3">({r.end_reason})</span>}
                </td>
                <td className="max-w-64 px-2 py-2">
                  <div className="truncate font-medium">{r.config.name}</div>
                  <div className="truncate font-mono text-ink-3">{r.config.request.method} {r.config.request.url}</div>
                </td>
                <td className="px-2 py-2 text-right">{fmtInt(r.totals.total)}</td>
                <td className={`px-2 py-2 text-right ${r.totals.failed ? "text-critical" : ""}`}>{fmtPct(r.totals.failed, r.totals.total)}</td>
                <td className="px-2 py-2 text-right">{fmtRps(r.achieved_rps)}</td>
                <td className="px-2 py-2 text-right">{fmtLatency(r.capped ? r.latency_corrected.p99 : r.latency_raw.p99)}</td>
                <td className="px-2 py-2 text-right whitespace-nowrap">
                  <button type="button" className="btn px-1.5 py-0.5 text-xs" onClick={() => props.onOpen(r.run_id)}>Open</button>{" "}
                  <button type="button" className="btn px-1.5 py-0.5 text-xs" onClick={() => props.onExport(r.run_id, "csv")}>CSV</button>{" "}
                  <button type="button" className="btn px-1.5 py-0.5 text-xs" onClick={() => props.onExport(r.run_id, "json")}>JSON</button>{" "}
                  <button type="button" className="btn px-1.5 py-0.5 text-xs text-critical" aria-label="Delete run" onClick={() => props.onDelete(r.run_id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
