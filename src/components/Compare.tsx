import { useMemo } from "react";
import type { RunSummary } from "../bindings";
import { fmtBytes, fmtDate, fmtDelta, fmtDuration, fmtInt, fmtLatency, fmtRps } from "../lib/format";
import { CompareChart, SERIES, type ComparePoint } from "./Charts";
import { Icon } from "./ui";

type Metric = { label: string; a: number; b: number; fmt: (n: number) => string; better: "lower" | "higher" | "none" };

const headline = (r: RunSummary) => (r.capped ? r.latency_corrected : r.latency_raw);
const errRate = (r: RunSummary) => (r.totals.total ? (r.totals.failed / r.totals.total) * 100 : 0);

function merge(a: RunSummary, b: RunSummary, pick: (p: RunSummary["series"][number]) => number): ComparePoint[] {
  const byT = new Map<number, ComparePoint>();
  for (const p of a.series) byT.set(p.t_s, { t: p.t_s, a: pick(p), b: null });
  for (const p of b.series) byT.set(p.t_s, { ...(byT.get(p.t_s) ?? { t: p.t_s, a: null }), b: pick(p) });
  const all = [...byT.values()].sort((x, y) => x.t - y.t);
  // Keep at most ~600 points.
  const step = Math.ceil(all.length / 600);
  return step > 1 ? all.filter((_, i) => i % step === 0) : all;
}

export function Compare({ a, b, onClose }: { a: RunSummary; b: RunSummary; onClose: () => void }) {
  const metrics: Metric[] = [
    { label: "Requests", a: a.totals.total, b: b.totals.total, fmt: fmtInt, better: "none" },
    { label: "Achieved RPS", a: a.achieved_rps ?? 0, b: b.achieved_rps ?? 0, fmt: fmtRps, better: "higher" },
    { label: "Error rate", a: errRate(a), b: errRate(b), fmt: (n) => `${n.toFixed(2)}%`, better: "lower" },
    { label: "Latency p50", a: headline(a).p50, b: headline(b).p50, fmt: fmtLatency, better: "lower" },
    { label: "Latency p90", a: headline(a).p90, b: headline(b).p90, fmt: fmtLatency, better: "lower" },
    { label: "Latency p95", a: headline(a).p95, b: headline(b).p95, fmt: fmtLatency, better: "lower" },
    { label: "Latency p99", a: headline(a).p99, b: headline(b).p99, fmt: fmtLatency, better: "lower" },
    { label: "Latency max", a: headline(a).max, b: headline(b).max, fmt: fmtLatency, better: "lower" },
    { label: "Service time p99 (raw)", a: a.latency_raw.p99, b: b.latency_raw.p99, fmt: fmtLatency, better: "lower" },
    { label: "TTFB p50", a: a.ttfb.p50, b: b.ttfb.p50, fmt: fmtLatency, better: "lower" },
    { label: "Duration", a: a.duration_ms, b: b.duration_ms, fmt: fmtDuration, better: "none" },
    { label: "Received", a: a.bytes, b: b.bytes, fmt: fmtBytes, better: "none" },
  ];
  const rps = useMemo(() => merge(a, b, (p) => p.rps ?? 0), [a, b]);
  const p99 = useMemo(() => merge(a, b, (p) => (a.capped || b.capped ? p.p99 : p.raw_p99) / 1000), [a, b]);
  const label = (r: RunSummary, tag: string) => `${tag}: ${r.config.name} · ${fmtDate(r.started_at)}`;

  const tone = (m: Metric) => {
    if (m.better === "none" || m.a === m.b) return "text-text3";
    const improved = m.better === "lower" ? m.b < m.a : m.b > m.a;
    return improved ? "text-success" : "text-danger";
  };
  const verdict = (m: Metric) => {
    if (m.better === "none" || m.a === m.b) return null;
    const improved = m.better === "lower" ? m.b < m.a : m.b > m.a;
    const up = m.b > m.a;
    return (
      <span className="mr-1.5 inline-flex items-center gap-0.5 align-[-2px]">
        <Icon name={up ? "arrowUp" : "arrowDown"} className="size-3" />
        <span className="font-sans font-medium">{improved ? "better" : "worse"}</span>
      </span>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5 text-body text-text2">
          <div className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 shrink-0 rounded-full" style={{ background: SERIES[0] }} /><span className="truncate">{label(a, "A")}</span></div>
          <div className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 shrink-0 rounded-full" style={{ background: SERIES[1] }} /><span className="truncate">{label(b, "B")}</span></div>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          <Icon name="back" /> Back to history
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="tabular w-full text-body">
          <thead>
            <tr className="border-b border-line text-small text-text3">
              <th className="px-4 py-2 text-left font-medium">Metric</th>
              <th className="px-2 py-2 text-right font-medium">A</th>
              <th className="px-2 py-2 text-right font-medium">B</th>
              <th className="px-4 py-2 text-right font-medium">Δ (B − A)</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.label} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-text2">{m.label}</td>
                <td className="px-2 py-2 text-right font-mono text-small whitespace-nowrap">{m.fmt(m.a)}</td>
                <td className="px-2 py-2 text-right font-mono text-small whitespace-nowrap">{m.fmt(m.b)}</td>
                <td className={`px-4 py-2 text-right font-mono text-small whitespace-nowrap ${tone(m)}`}>{verdict(m)}{fmtDelta(m.a, m.b, m.fmt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CompareChart title="Throughput (requests / s)" data={rps} labelA="A" labelB="B" unit="rps" />
      <CompareChart title="Latency p99, ms" data={p99} labelA="A" labelB="B" unit="ms" slot={1} />
    </div>
  );
}
