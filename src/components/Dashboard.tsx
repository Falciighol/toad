import type { Snapshot } from "../bindings";
import type { ChartPoint } from "../lib/series";
import { fmtInt, fmtLatency, fmtPct, fmtRps } from "../lib/format";
import { ErrorBreakdown, StatusBreakdown, Warnings } from "./Breakdowns";
import { LatencyChart, RpsChart } from "./Charts";
import { Stat } from "./ui";

export function Dashboard({ snapshot, series, capped }: { snapshot: Snapshot | null; series: ChartPoint[]; capped: boolean }) {
  const s = snapshot;
  const total = s?.total ?? 0;
  return (
    <div className="space-y-3">
      <Warnings warnings={s?.warnings ?? []} />
      <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
        <Stat label="Total" value={fmtInt(total)} sub={s && s.cancelled > 0 ? `${fmtInt(s.cancelled)} cancelled` : undefined} />
        <Stat label="Success" value={fmtInt(s?.ok ?? 0)} tone="good" sub={fmtPct(s?.ok ?? 0, total)} />
        <Stat label="Failure" value={fmtInt(s?.failed ?? 0)} tone={(s?.failed ?? 0) > 0 ? "critical" : undefined} />
        <Stat label="Current RPS" value={fmtRps(s?.rps_interval ?? 0)} sub={s?.target_rps != null ? `target ${fmtRps(s.target_rps)}` : undefined} />
        <Stat label="Error rate" value={fmtPct(s?.failed ?? 0, total)} tone={(s?.failed ?? 0) > 0 ? "critical" : undefined} />
        <Stat label="In flight" value={fmtInt(s?.in_flight ?? 0)} sub={s ? `${fmtInt(s.active_workers)} workers` : undefined} />
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        {(["p50", "p95", "p99", "max"] as const).map((k) => (
          <div key={k} className="card px-3 py-2">
            <span className="text-ink-2">Latency {k} · interval</span>
            <div className="tabular text-sm font-semibold">{fmtLatency(s?.lat_interval[k])}</div>
            {capped && <div className="tabular text-ink-3">service {fmtLatency(s?.lat_interval_raw[k])}</div>}
          </div>
        ))}
      </div>
      <RpsChart data={series} showTarget={capped} />
      <LatencyChart data={series} raw={false} title={capped ? "Latency from scheduled send (corrected), ms" : "Latency, ms"} />
      {capped && <LatencyChart data={series} raw title="Service time (raw), ms" slot={2} />}
      <div className="grid grid-cols-2 gap-2">
        <StatusBreakdown counts={s?.status_counts ?? []} />
        <ErrorBreakdown counts={s?.error_counts ?? []} total={total} />
      </div>
    </div>
  );
}
