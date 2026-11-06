import { appendPoint, downsample, MAX_POINTS, type ChartPoint } from "../series";
import { validateLoad } from "../validate";
import { defaultLoad } from "../defaults";
import { fmtDelta, fmtLatency } from "../format";

const pt = (t: number): ChartPoint => ({ t, rps: t, target: null, ok: 1, failed: 0, p50: t, p95: t, p99: t, rawP50: t, rawP95: t, rawP99: t });

describe("series downsampling", () => {
  it("never exceeds the point budget and keeps recent data at full resolution", () => {
    let s: ChartPoint[] = [];
    for (let t = 1; t <= 5000; t++) s = appendPoint(s, pt(t));
    expect(s.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(s.at(-1)!.t).toBe(5000);
    expect(s.at(-2)!.t).toBe(4999);
    // Totals are preserved by merging.
    expect(s.reduce((n, p) => n + p.ok, 0)).toBe(5000);
    // Time stays monotonic.
    for (let i = 1; i < s.length; i++) expect(s[i]!.t).toBeGreaterThan(s[i - 1]!.t);
  });
  it("is a no-op under the budget", () => {
    const s = [pt(1), pt(2)];
    expect(downsample(s)).toEqual(s);
  });
});

describe("load validation", () => {
  const limits = { max_concurrency: 100, max_rps: 1000 };
  it("accepts defaults within limits", () => {
    expect(validateLoad({ ...defaultLoad(), concurrency: 50 }, limits)).toEqual({});
  });
  it("enforces ceilings and ramp < duration", () => {
    const e = validateLoad({ ...defaultLoad(), concurrency: 101, rps_cap: 2000, ramp_up_secs: 30, stop: { kind: "duration", secs: 30 } }, limits);
    expect(Object.keys(e).sort()).toEqual(["load.concurrency", "load.ramp_up_secs", "load.rps_cap"]);
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
