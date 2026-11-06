import { useMemo } from "react";
import type { ExportFormat, Percentiles, RunSummary } from "../bindings";
import { seriesFromSummary } from "../lib/series";
import { fmtBytes, fmtDate, fmtDuration, fmtInt, fmtLatency, fmtPct, fmtRps } from "../lib/format";
import { ErrorBreakdown, StatusBreakdown, Warnings } from "./Breakdowns";
import { LatencyChart, RpsChart } from "./Charts";
import { Stat } from "./ui";

const KEYS = ["min", "mean", "p50", "p90", "p95", "p99", "max"] as const;

const END: Record<RunSummary["end_reason"], { label: string; cls: string }> = {
  completed: { label: "✓ Completed", cls: "text-good-text" },
  stopped: { label: "■ Stopped", cls: "text-ink-2" },
  failed: { label: "✕ Failed", cls: "text-critical" },
};

export function LatencyTable({ rows }: { rows: { label: string; p: Percentiles; headline?: boolean }[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tabular w-full text-xs">
        <thead>
          <tr className="border-b border-line text-ink-2">
            <th className="px-3 py-2 text-left font-medium">Latency</th>
            {KEYS.map((k) => (
              <th key={k} className="px-2 py-2 text-right font-medium">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line last:border-0">
              <td className={`px-3 py-2 ${r.headline ? "font-semibold" : "text-ink-2"}`}>{r.label}</td>
              {KEYS.map((k) => (
                <td key={k} className={`px-2 py-2 text-right ${r.headline ? "font-semibold" : ""}`}>
                  {fmtLatency(r.p[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Summary({ summary, onExport, onClose }: { summary: RunSummary; onExport: (f: ExportFormat) => void; onClose?: () => void }) {
  const series = useMemo(() => seriesFromSummary(summary.series), [summary.series]);
  const t = summary.totals;
  const end = END[summary.end_reason];
  const rows = summary.capped
    ? [
        { label: "Corrected (from scheduled send)", p: summary.latency_corrected, headline: true },
        { label: "Service time (raw)", p: summary.latency_raw },
        { label: "Time to first byte", p: summary.ttfb },
      ]
    : [
        { label: "Latency", p: summary.latency_raw, headline: true },
        { label: "Time to first byte", p: summary.ttfb },
      ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">
            {summary.config.name} <span className={`ml-1 text-sm font-medium ${end.cls}`}>{end.label}</span>
          </h2>
          <p className="font-mono text-xs text-ink-2">
            {summary.config.request.method} {summary.config.request.url}
          </p>
          <p className="text-xs text-ink-3">
            {fmtDate(summary.started_at)} · {fmtInt(summary.config.load.concurrency)} workers
            {summary.config.load.rps_cap !== null && ` · capped at ${fmtInt(summary.config.load.rps_cap)} rps`}
          </p>
          {summary.error && <p className="mt-1 text-xs text-critical">{summary.error}</p>}
        </div>
        <div className="flex gap-1.5">
          <button type="button" className="btn" onClick={() => onExport("json")}>Export JSON</button>
          <button type="button" className="btn" onClick={() => onExport("csv")}>Export CSV</button>
          {onClose && <button type="button" className="btn" onClick={onClose}>Close</button>}
        </div>
      </div>
      <Warnings warnings={summary.warnings} />
      <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
        <Stat label="Total" value={fmtInt(t.total)} sub={t.cancelled ? `${fmtInt(t.cancelled)} cancelled` : undefined} />
        <Stat label="Success" value={fmtInt(t.ok)} tone="good" sub={fmtPct(t.ok, t.total)} />
        <Stat label="Failure" value={fmtInt(t.failed)} tone={t.failed ? "critical" : undefined} sub={fmtPct(t.failed, t.total)} />
        <Stat label="Achieved RPS" value={fmtRps(summary.achieved_rps)} />
        <Stat label="Duration" value={fmtDuration(summary.duration_ms)} />
        <Stat label="Received" value={fmtBytes(summary.bytes)} />
      </div>
      <LatencyTable rows={rows} />
      <RpsChart data={series} showTarget={false} />
      <LatencyChart data={series} raw={!summary.capped} title={summary.capped ? "Latency from scheduled send (corrected), ms" : "Latency, ms"} />
      <div className="grid grid-cols-2 gap-2">
        <StatusBreakdown counts={t.status_counts} />
        <ErrorBreakdown counts={t.error_counts} total={t.total} />
      </div>
    </div>
  );
}
