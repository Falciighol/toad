// Pre-run estimates for the Load and Review stages: how long a run lasts, how many iterations
// and requests it sends, at what peak rate. Closed-model numbers depend on the target's speed,
// so they assume a response time and say so.
import type { FlowItem, Scenario, TestConfig, ThinkTime } from "../bindings";
import { itemSteps } from "./flow";
import { area, duration, isOpen, maxVus, peakPerSec, points } from "./profile";

/** Response time assumed for estimates that depend on the server's speed. */
export const ASSUMED_LATENCY_MS = 50;

export type ScenarioEstimate = {
  id: string;
  name: string;
  secs: number;
  iterations: number;
  requests: number;
  /** Requests per iteration. */
  perIteration: number;
  peakRps: number;
  peakVus: number;
  /** The numbers depend on ASSUMED_LATENCY_MS. */
  latencyBound: boolean;
  /** Open model: VUs needed to keep up at the assumed latency, when max VUs is lower. */
  vusNeeded: number | null;
};

export type RunEstimate = { scenarios: ScenarioEstimate[]; secs: number; requests: number; peakRps: number; peakVus: number; latencyBound: boolean };

const thinkMs = (t: ThinkTime | null | undefined) =>
  !t ? 0 : t.kind === "fixed" ? t.ms : t.kind === "uniform" ? (t.min_ms + t.max_ms) / 2 : t.mean_ms;

export function requestsPerIteration(sc: Scenario): number {
  if (sc.kind === "mix") return 1;
  return sc.steps.reduce((n, it) => n + itemSteps(it).length, 0);
}

/** Expected time for one iteration at the assumed latency (parallel groups count once). */
export function iterationMs(sc: Scenario): number {
  const think = thinkMs(sc.think);
  if (sc.kind === "mix") return ASSUMED_LATENCY_MS + think;
  return sc.steps.reduce((ms, it: FlowItem) => {
    if (it.kind === "pause") return ms + thinkMs(it.pause.think);
    return ms + ASSUMED_LATENCY_MS + think;
  }, 0) || ASSUMED_LATENCY_MS;
}

export function estimateScenario(sc: Scenario): ScenarioEstimate {
  const e = sc.executor;
  const per = Math.max(1, requestsPerIteration(sc));
  const itMs = iterationMs(sc);
  const base = { id: sc.id, name: sc.name, perIteration: per };
  if (isOpen(e)) {
    const iterations = Math.round(area(e));
    const needed = Math.ceil((peakPerSec(e) * itMs) / 1000 * 1.2);
    return { ...base, secs: duration(e), iterations, requests: iterations * per, peakRps: peakPerSec(e) * per, peakVus: maxVus(e), latencyBound: false, vusNeeded: needed > maxVus(e) ? needed : null };
  }
  if (e.kind === "iterations") {
    const secs = Math.min(e.max_duration_secs, (e.iterations * itMs) / 1000 / Math.max(1, e.vus));
    return { ...base, secs, iterations: e.iterations, requests: e.iterations * per, peakRps: (e.vus * 1000 * per) / itMs, peakVus: e.vus, latencyBound: true, vusNeeded: null };
  }
  // Closed: VU-seconds over seconds per iteration.
  const vuSeconds = points(e).reduce((a, p, i, arr) => (i ? a + ((p.v + arr[i - 1]!.v) / 2) * (p.t - arr[i - 1]!.t) : 0), 0);
  const iterations = Math.round((vuSeconds * 1000) / itMs);
  return { ...base, secs: duration(e), iterations, requests: iterations * per, peakRps: (maxVus(e) * 1000 * per) / itMs, peakVus: maxVus(e), latencyBound: true, vusNeeded: null };
}

export function estimateTest(c: TestConfig): RunEstimate {
  const scenarios = c.scenarios.filter((s) => s.enabled).map(estimateScenario);
  return {
    scenarios,
    secs: Math.max(0, ...c.scenarios.filter((s) => s.enabled).map((s, i) => s.start_offset_secs + (scenarios[i]?.secs ?? 0))),
    requests: scenarios.reduce((n, s) => n + s.requests, 0),
    peakRps: scenarios.reduce((n, s) => n + s.peakRps, 0),
    peakVus: scenarios.reduce((n, s) => n + s.peakVus, 0),
    latencyBound: scenarios.some((s) => s.latencyBound),
  };
}

/** Describes a success range in status classes where it lines up, e.g. "2xx and 3xx". */
export function describeStatusRange(min: number, max: number): string | null {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return null;
  if (min % 100 === 0 && max % 100 === 99) {
    const lo = min / 100;
    const hi = Math.floor(max / 100);
    if (lo === hi) return `${lo}xx responses`;
    if (hi === lo + 1) return `${lo}xx and ${hi}xx responses`;
    return `${lo}xx–${hi}xx responses`;
  }
  return min === max ? `Status ${min}` : `Statuses ${min}–${max}`;
}
