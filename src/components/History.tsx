import { useState } from "react";
import type { ExportFormat, RunSummary } from "../bindings";
import { fmtDate, fmtInt, fmtLatency, fmtPct, fmtRps } from "../lib/format";
import { Icon, Pill } from "./ui";

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
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <Icon name="file" className="size-8 text-text4" />
        <p className="mt-3 text-title font-semibold text-text">No runs yet</p>
        <p className="mt-1 max-w-sm text-body text-text3">Every finished or stopped run is saved here so you can reopen, export or compare it.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-small text-text3">{picked.length === 2 ? "Ready to compare." : `Select ${2 - picked.length === 2 ? "two runs" : "one more run"} to compare.`}</p>
        <button type="button" className="btn btn-primary btn-sm" disabled={picked.length !== 2} onClick={() => props.onCompare(picked[0]!, picked[1]!)}>
          Compare <span className="tabular font-mono opacity-75">{picked.length}/2</span>
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="tabular w-full text-body">
          <thead>
            <tr className="border-b border-line text-left text-small whitespace-nowrap text-text3">
              <th className="w-8 py-2 pr-2 pl-4" />
              <th className="px-2 py-2 font-medium">Run</th>
              <th className="px-2 py-2 text-right font-medium">Requests</th>
              <th className="px-2 py-2 text-right font-medium">Errors</th>
              <th className="px-2 py-2 text-right font-medium">RPS</th>
              <th className="px-2 py-2 text-right font-medium">p99</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {props.runs.map((r) => (
              <tr key={r.run_id} className={`border-b border-line transition-colors last:border-0 ${picked.includes(r.run_id) ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "hover:bg-raised"}`}>
                <td className="py-2 pr-2 pl-4">
                  <input type="checkbox" aria-label={`Select run ${fmtDate(r.started_at)}`} className="block size-3.5" checked={picked.includes(r.run_id)} onChange={() => toggle(r.run_id)} />
                </td>
                <td className="w-full max-w-0 min-w-28 px-2 py-2">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <button type="button" className="min-w-0 truncate rounded-sm text-left font-medium text-text underline-offset-2 hover:text-accent-ink hover:underline" title="Open run" onClick={() => props.onOpen(r.run_id)}>
                      {r.config.name}
                    </button>
                    {r.end_reason !== "completed" && <Pill tone={r.end_reason === "failed" ? "danger" : "neutral"}>{r.end_reason === "failed" ? "Failed" : "Stopped"}</Pill>}
                  </div>
                  <div className="truncate text-small text-text3">
                    {fmtDate(r.started_at)} · <span className="font-mono text-text4">{r.config.request.method} {r.config.request.url}</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-right font-mono text-small whitespace-nowrap">{fmtInt(r.totals.total)}</td>
                <td className={`px-2 py-2 text-right font-mono text-small whitespace-nowrap ${r.totals.failed ? "text-danger" : "text-text2"}`}>{fmtPct(r.totals.failed, r.totals.total)}</td>
                <td className="px-2 py-2 text-right font-mono text-small whitespace-nowrap">{fmtRps(r.achieved_rps)}</td>
                <td className="px-2 py-2 text-right font-mono text-small whitespace-nowrap">{fmtLatency(r.capped ? r.latency_corrected.p99 : r.latency_raw.p99)}</td>
                <td className="py-1.5 pr-3 pl-1">
                  <div className="flex justify-end gap-0.5">
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Export run ${fmtDate(r.started_at)} as CSV`} onClick={() => props.onExport(r.run_id, "csv")}>
                      CSV
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Export run ${fmtDate(r.started_at)} as JSON`} onClick={() => props.onExport(r.run_id, "json")}>
                      JSON
                    </button>
                    <button type="button" className="btn btn-ghost btn-danger-text btn-sm px-1.5" aria-label={`Delete run ${fmtDate(r.started_at)}`} title="Delete run" onClick={() => props.onDelete(r.run_id)}>
                      <Icon name="trash" className="size-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
