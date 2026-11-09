import { appendPoint, downsample, MAX_POINTS, type ChartPoint } from "../series";
import { fmtDelta, fmtLatency } from "../format";
import { jsonError } from "../validate";
import { BUCKETS, quantile, windowStats } from "../hist";
import { stageOf, toErrors, errorsByStage } from "../stages";

const pt = (t: number): ChartPoint => ({ t, rps: t, target: null, ok: 1, failed: 0, p50: t, p95: t, p99: t, rawP50: t, rawP95: t, rawP99: t, vus: 1 });

describe("series downsampling", () => {
  it("never exceeds the point budget and keeps recent data at full resolution", () => {
    let s: ChartPoint[] = [];
    for (let t = 1; t <= 5000; t++) s = appendPoint(s, pt(t));
    expect(s.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(s.at(-1)!.t).toBe(5000);
    expect(s.at(-2)!.t).toBe(4999);
    expect(s.reduce((n, p) => n + p.ok, 0)).toBe(5000);
    for (let i = 1; i < s.length; i++) expect(s[i]!.t).toBeGreaterThan(s[i - 1]!.t);
  });
  it("is a no-op under the budget", () => {
    const s = [pt(1), pt(2)];
    expect(downsample(s)).toEqual(s);
  });
});

describe("formatting", () => {
  it("formats latency in sensible units", () => {
    expect(fmtLatency(850)).toBe("850 µs");
    expect(fmtLatency(12_345)).toBe("12.3 ms");
    expect(fmtLatency(2_500_000)).toBe("2.50 s");
  });
  it("formats deltas with sign and percent", () => {
    expect(fmtDelta(100, 150, String)).toBe("+50 (+50.0%)");
    expect(fmtDelta(100, 80, String)).toBe("−20 (−20.0%)");
  });
});

describe("templated JSON bodies", () => {
  it("checks syntax with placeholders filled in", () => {
    expect(jsonError('{"id": {{$seq}}, "u": "{{user}}"}')).toBeNull();
    expect(jsonError('{"id": }')).not.toBeNull();
    expect(jsonError("")).toBeNull();
  });
});

describe("window percentiles", () => {
  it("matches the engine's buckets and interpolates within them", () => {
    expect(BUCKETS[0]).toBe(100);
    expect(BUCKETS[63]).toBeGreaterThan(600_000_000);
    const counts = new Array(64).fill(0);
    counts[10] = 100;
    const q = quantile(counts, 0.5)!;
    expect(q).toBeGreaterThan(BUCKETS[9]!);
    expect(q).toBeLessThanOrEqual(BUCKETS[10]!);
    expect(quantile(new Array(64).fill(0), 0.5)).toBeNull();
  });
  it("merges only the seconds in the window", () => {
    const series = [
      { t_s: 1, ok: 10, failed: 0, p50: 0, p95: 0, p99: 0, hist: [5, 10] },
      { t_s: 2, ok: 5, failed: 5, p50: 0, p95: 0, p99: 0, hist: [30, 10] },
    ];
    const w1 = windowStats(series, 1, 1);
    expect(w1.count).toBe(10);
    expect(w1.p99!).toBeLessThanOrEqual(BUCKETS[5]!);
    const w2 = windowStats(series, 1, 2);
    expect(w2.failed).toBe(5);
    expect(w2.p99!).toBeGreaterThan(BUCKETS[29]!);
  });
});

describe("stages", () => {
  it("routes engine field errors to their stage", () => {
    expect(stageOf("step:r1.url")).toBe("flow");
    expect(stageOf("scenario:s1.load")).toBe("load");
    expect(stageOf("data:d1")).toBe("data");
    expect(stageOf("defaults.success_range")).toBe("checks");
    expect(stageOf("connection.proxy")).toBe("load");
    expect(stageOf("threshold:t1")).toBe("checks");
    const e = toErrors([{ field: "step:a.url", message: "x" }, { field: "step:a.url", message: "y" }, { field: "data:d", message: "z" }]);
    expect(e["step:a.url"]).toBe("x");
    expect(errorsByStage(e)).toEqual({ flow: 1, data: 1, load: 0, checks: 0, review: 0 });
  });
});
