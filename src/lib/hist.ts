// Window percentiles from the per-second endpoint histograms (toad-core metrics::BUCKETS:
// 64 log buckets ×1.3 apart from 100 µs). Accurate to about ±15%, which the UI says.
import type { StepPoint } from "../bindings";

export const BUCKETS: number[] = (() => {
  const b: number[] = [];
  let v = 100;
  for (let i = 0; i < 64; i++) {
    b.push(Math.floor(v));
    v *= 1.3;
  }
  return b;
})();

export function mergeBuckets(points: StepPoint[]): number[] {
  const counts = new Array<number>(BUCKETS.length).fill(0);
  for (const p of points) for (let i = 0; i + 1 < p.hist.length; i += 2) counts[p.hist[i]!]! += p.hist[i + 1]!;
  return counts;
}

/** Quantile (0..1) in µs from merged bucket counts, interpolated within the bucket. */
export function quantile(counts: number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = q * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (c && seen + c >= target) {
      const lo = i === 0 ? 0 : BUCKETS[i - 1]!;
      const hi = BUCKETS[i]!;
      return lo + ((hi - lo) * (target - seen)) / c;
    }
    seen += c;
  }
  return BUCKETS[BUCKETS.length - 1]!;
}

export type WindowStats = { count: number; ok: number; failed: number; p50: number | null; p95: number | null; p99: number | null };

export function windowStats(series: StepPoint[], from: number, to: number): WindowStats {
  const pts = series.filter((p) => p.t_s >= from && p.t_s <= to);
  const counts = mergeBuckets(pts);
  const ok = pts.reduce((n, p) => n + p.ok, 0);
  const failed = pts.reduce((n, p) => n + p.failed, 0);
  return { count: ok + failed, ok, failed, p50: quantile(counts, 0.5), p95: quantile(counts, 0.95), p99: quantile(counts, 0.99) };
}

/** Bucket counts as [lower µs, upper µs, count] bars for a distribution chart. */
export function bars(counts: number[]): { lo: number; hi: number; count: number }[] {
  const first = counts.findIndex((c) => c > 0);
  if (first < 0) return [];
  let last = counts.length - 1;
  while (last > first && counts[last] === 0) last--;
  const out = [];
  for (let i = first; i <= last; i++) out.push({ lo: i === 0 ? 0 : BUCKETS[i - 1]!, hi: BUCKETS[i]!, count: counts[i]! });
  return out;
}
