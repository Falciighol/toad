// Bounded chart series: at most MAX points. When full, the older half is merged
// pairwise (RPS averaged, latency percentiles take the max so spikes survive), so
// recent data stays at full resolution and old data degrades gracefully.
import type { SecondPoint } from "../bindings";

export const MAX_POINTS = 600;

export type ChartPoint = {
  t: number;
  rps: number;
  target: number | null;
  ok: number;
  failed: number;
  p50: number;
  p95: number;
  p99: number;
  rawP50: number;
  rawP95: number;
  rawP99: number;
};

export function toChartPoint(p: SecondPoint, target: number | null = null): ChartPoint {
  return {
    t: p.t_s,
    rps: p.rps ?? 0,
    target,
    ok: p.ok,
    failed: p.failed,
    p50: p.p50 / 1000,
    p95: p.p95 / 1000,
    p99: p.p99 / 1000,
    rawP50: p.raw_p50 / 1000,
    rawP95: p.raw_p95 / 1000,
    rawP99: p.raw_p99 / 1000,
  };
}

function merge(a: ChartPoint, b: ChartPoint): ChartPoint {
  const avg = (x: number, y: number) => (x + y) / 2;
  return {
    t: b.t,
    rps: avg(a.rps, b.rps),
    target: a.target === null || b.target === null ? (a.target ?? b.target) : avg(a.target, b.target),
    ok: a.ok + b.ok,
    failed: a.failed + b.failed,
    p50: Math.max(a.p50, b.p50),
    p95: Math.max(a.p95, b.p95),
    p99: Math.max(a.p99, b.p99),
    rawP50: Math.max(a.rawP50, b.rawP50),
    rawP95: Math.max(a.rawP95, b.rawP95),
    rawP99: Math.max(a.rawP99, b.rawP99),
  };
}

/** Append a point, compacting when the series exceeds `max`. Returns a new array. */
export function appendPoint(series: ChartPoint[], p: ChartPoint, max = MAX_POINTS): ChartPoint[] {
  const next = [...series, p];
  if (next.length <= max) return next;
  return downsample(next, max);
}

export function downsample(points: ChartPoint[], max = MAX_POINTS): ChartPoint[] {
  let out = points;
  while (out.length > max) {
    const half = Math.floor(out.length / 2);
    const old: ChartPoint[] = [];
    for (let i = 0; i + 1 < half; i += 2) old.push(merge(out[i]!, out[i + 1]!));
    if (half % 2 === 1) old.push(out[half - 1]!);
    out = [...old, ...out.slice(half)];
  }
  return out;
}

export const seriesFromSummary = (points: SecondPoint[]) => downsample(points.map((p) => toChartPoint(p)));
