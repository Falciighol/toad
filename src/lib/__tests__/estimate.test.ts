import { describeStatusRange, estimateRun, sentBy, timeFor } from "../estimate";
import { defaultLoad } from "../defaults";
import { fmtSecs } from "../format";

describe("run estimates", () => {
  it("uncapped duration runs scale with workers at the assumed latency", () => {
    const e = estimateRun({ ...defaultLoad(), concurrency: 50, stop: { kind: "duration", secs: 30 } })!;
    expect(e.secs).toBe(30);
    expect(e.rate).toBe(1000);
    expect(e.requests).toBe(30_000);
    expect(e.latencyBound).toBe(true);
  });
  it("capped runs follow the rate schedule, including the ramp from 1 rps", () => {
    const e = estimateRun({ ...defaultLoad(), concurrency: 50, rps_cap: 100, ramp_up_secs: 10, stop: { kind: "duration", secs: 30 } })!;
    // 10 s ramp from 1 to 100 rps (505 requests) then 20 s at 100 rps.
    expect(e.requests).toBe(2505);
    expect(e.workersNeeded).toBeNull();
  });
  it("request-count runs estimate their length", () => {
    const e = estimateRun({ ...defaultLoad(), concurrency: 10, rps_cap: 50, stop: { kind: "requests", count: 1000 } })!;
    expect(e.secs).toBe(20);
    expect(e.requests).toBe(1000);
  });
  it("flags a cap the workers can't reach", () => {
    const e = estimateRun({ ...defaultLoad(), concurrency: 10, rps_cap: 2000 })!;
    expect(e.workersNeeded).toBe(100);
  });
  it("is null while a needed field is empty", () => {
    expect(estimateRun({ ...defaultLoad(), concurrency: Number.NaN })).toBeNull();
    expect(estimateRun({ ...defaultLoad(), stop: { kind: "duration", secs: Number.NaN } })).toBeNull();
  });
  it("timeFor inverts sentBy inside and after the ramp", () => {
    for (const t of [0.5, 3, 9.9, 12, 40]) expect(timeFor(sentBy(t, 1, 200, 10), 1, 200, 10)).toBeCloseTo(t, 6);
  });
});

describe("status range and durations", () => {
  it("describes ranges by class where possible", () => {
    expect(describeStatusRange(200, 399)).toBe("2xx and 3xx responses");
    expect(describeStatusRange(200, 299)).toBe("2xx responses");
    expect(describeStatusRange(200, 204)).toBe("Statuses 200–204");
  });
  it("formats spans for humans", () => {
    expect(fmtSecs(30)).toBe("30 s");
    expect(fmtSecs(300)).toBe("5 min");
    expect(fmtSecs(125)).toBe("2 min 5 s");
    expect(fmtSecs(5400)).toBe("1 h 30 min");
    expect(fmtSecs(1.25)).toBe("1.3 s");
  });
});
