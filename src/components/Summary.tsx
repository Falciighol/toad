import { useMemo } from "react";
import type { ExportFormat, Percentiles, RunSummary } from "../bindings";
import { seriesFromSummary } from "../lib/series";
import { fmtBytes, fmtDate, fmtDuration, fmtInt, fmtLatency, fmtPct, fmtRps } from "../lib/format";
import { ErrorBreakdown, StatusBreakdown, Warnings } from "./Breakdowns";
import { LatencyChart, RpsChart } from "./Charts";
import { Icon, type IconName, Pill, Stat, type Tone } from "./ui";

const KEYS = ["min", "mean", "p50", "p90", "p95", "p99", "max"] as const;

const END: Record<RunSummary["end_reason"], { label: string; icon: IconName; tone: Tone }> = {
  completed: { label: "Completed", icon: "check", tone: "success" },
  stopped: { label: "Stopped", icon: "stop", tone: "neutral" },
  failed: { label: "Failed", icon: "x", tone: "danger" },
};

export function LatencyTable({ rows }: { rows: { label: string; p: Percentiles; headline?: boolean }[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tabular w-full text-body">
        <thead>
          <tr className="border-b border-line text-small text-text3">
            <th className="py-2 pr-2 pl-4 text-left font-medium">Measure</th>
            {KEYS.map((k) => (
              <th key={k} className="px-2 py-2 text-right font-medium whitespace-nowrap last:pr-4">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line last:border-0">
              <td className={`py-2.5 pr-2 pl-4 ${r.headline ? "font-medium text-text" : "text-text2"}`}>{r.label}</td>
              {KEYS.map((k) => (
                <td key={k} className={`px-2 py-2.5 text-right font-mono text-small whitespace-nowrap last:pr-4 ${r.headline ? "font-medium text-text" : "text-text2"}`}>
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
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-title font-semibold">
            <span className="min-w-0 break-words">{summary.config.name}</span>
            <Pill tone={end.tone}>
              <Icon name={end.icon} className="size-3" /> {end.label}
            </Pill>
          </h2>
          <p className="mt-1 truncate font-mono text-small text-text2 select-text">
            {summary.config.request.method} {summary.config.request.url}
          </p>
          <p className="tabular mt-0.5 text-small text-text3">
            {fmtDate(summary.started_at)} · {fmtInt(summary.config.load.concurrency)} workers
            {summary.config.load.rps_cap !== null && ` · capped at ${fmtInt(summary.config.load.rps_cap)} rps`}
          </p>
          {summary.error && <p className="mt-1 text-small text-danger">{summary.error}</p>}
        </div>
        <div className="flex gap-1.5">
          {onClose && (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              <Icon name="back" /> Back to history
            </button>
          )}
          <button type="button" className="btn" onClick={() => onExport("json")}>
            <Icon name="download" /> Export JSON
          </button>
          <button type="button" className="btn" onClick={() => onExport("csv")}>
            <Icon name="download" /> Export CSV
          </button>
        </div>
      </div>
      <Warnings warnings={summary.warnings} />
      <div className="grid grid-cols-3 gap-3 xl:grid-cols-6">
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
      <div className="grid grid-cols-2 gap-3">
        <StatusBreakdown counts={t.status_counts} />
        <ErrorBreakdown counts={t.error_counts} total={t.total} />
      </div>
    </div>
  );
}
