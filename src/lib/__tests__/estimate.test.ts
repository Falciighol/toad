import { newScenario, newTest, pauseItem } from "../defaults";
import { estimateScenario, estimateTest, requestsPerIteration, ASSUMED_LATENCY_MS } from "../estimate";
import { area, convert, duration, peak, points, valueAt } from "../profile";

describe("profiles", () => {
  it("draws staged executors as corner points", () => {
    const e = { kind: "ramping_vus" as const, start: 0, stages: [{ duration_secs: 10, target: 100 }, { duration_secs: 20, target: 100 }, { duration_secs: 5, target: 0 }] };
    expect(points(e)).toEqual([{ t: 0, v: 0 }, { t: 10, v: 100 }, { t: 30, v: 100 }, { t: 35, v: 0 }]);
    expect(duration(e)).toBe(35);
    expect(valueAt(e, 5)).toBe(50);
    expect(valueAt(e, 32.5)).toBe(50);
    expect(peak(e)).toBe(100);
  });
  it("integrates arrival rates", () => {
    expect(area({ kind: "rate", rate: 50, duration_secs: 10, max_vus: 5 })).toBe(500);
    expect(area({ kind: "ramping_rate", start: 0, stages: [{ duration_secs: 10, target: 100 }], max_vus: 10 })).toBe(500);
  });
  it("converts between models keeping the level", () => {
    const r = convert({ kind: "vus", vus: 40, duration_secs: 60 }, "rate");
    expect(r).toMatchObject({ kind: "rate", rate: 40, duration_secs: 60 });
    const s = convert({ kind: "vus", vus: 40, duration_secs: 60 }, "ramping_vus");
    expect(s.kind).toBe("ramping_vus");
    expect(duration(s)).toBe(60);
  });
});

describe("estimates", () => {
  it("counts requests per iteration, groups included", () => {
    const sc = newScenario("A", "http://x/");
    sc.steps.push({ kind: "group", group: { id: "g", name: "", steps: [sc.steps[0]!.kind === "request" ? sc.steps[0]!.step : (null as never), sc.steps[0]!.kind === "request" ? sc.steps[0]!.step : (null as never)], run_if: null } });
    sc.steps.push(pauseItem());
    expect(requestsPerIteration(sc)).toBe(3);
    sc.kind = "mix";
    expect(requestsPerIteration(sc)).toBe(1);
  });
  it("estimates open models exactly and closed ones by assumed latency", () => {
    const sc = newScenario("A", "http://x/");
    sc.executor = { kind: "rate", rate: 100, duration_secs: 30, max_vus: 2 };
    const e = estimateScenario(sc);
    expect(e.iterations).toBe(3000);
    expect(e.latencyBound).toBe(false);
    expect(e.vusNeeded).toBe(Math.ceil((100 * ASSUMED_LATENCY_MS) / 1000 * 1.2));
    sc.executor = { kind: "vus", vus: 10, duration_secs: 10 };
    const c = estimateScenario(sc);
    expect(c.iterations).toBe(Math.round((100 * 1000) / ASSUMED_LATENCY_MS));
    expect(c.latencyBound).toBe(true);
  });
  it("sums scenarios and honours start offsets", () => {
    const t = newTest();
    const b = newScenario("B", "http://x/");
    b.start_offset_secs = 20;
    b.executor = { kind: "vus", vus: 5, duration_secs: 30 };
    t.scenarios.push(b);
    const e = estimateTest(t);
    expect(e.secs).toBe(50);
    expect(e.peakVus).toBe(55);
  });
});
