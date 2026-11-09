// Load profiles in the UI: the planned VUs / rate over time, mirroring toad-core's limiter.
//
// Open-model rates are counted in the executor's `rate_unit` (per second, minute or hour), and
// `points`, `peak` and `valueAt` stay in that unit so editors show what was typed. Anything
// that adds rates up or compares them with measurements uses the `…PerSec` helpers.
import type { Executor, RateUnit, Scenario, Stage } from "../bindings";

export type Pt = { t: number; v: number };

export const isOpen = (e: Executor) => e.kind === "rate" || e.kind === "ramping_rate";
export const isStaged = (e: Executor) => e.kind === "ramping_vus" || e.kind === "ramping_rate";

export const RATE_UNITS: { value: RateUnit; label: string; short: string; secs: number }[] = [
  { value: "second", label: "per second", short: "/s", secs: 1 },
  { value: "minute", label: "per minute", short: "/min", secs: 60 },
  { value: "hour", label: "per hour", short: "/h", secs: 3600 },
];

const rateUnitInfo = (u: RateUnit) => RATE_UNITS.find((x) => x.value === u) ?? RATE_UNITS[0]!;

/** The unit an open executor's rate is counted in (tests saved before units: per second). */
export const rateUnit = (e: Executor): RateUnit => ("rate_unit" in e && e.rate_unit) || "second";

/** Seconds in one rate unit: 1, 60 or 3600 (1 for closed models). */
export const rateUnitSecs = (e: Executor) => (isOpen(e) ? rateUnitInfo(rateUnit(e)).secs : 1);

/** "/s", "/min" or "/h". */
export const rateSuffix = (u: RateUnit) => rateUnitInfo(u).short;

/** "iterations / min" for chart axes and summaries; "virtual users" for closed models. */
export const unitLong = (e: Executor) => (isOpen(e) ? `iterations ${rateSuffix(rateUnit(e)).replace("/", "/ ")}` : "virtual users");

/** Corner points of the planned profile: (seconds, VUs or iterations per rate unit). */
export function points(e: Executor): Pt[] {
  switch (e.kind) {
    case "vus":
      return [{ t: 0, v: e.vus }, { t: e.duration_secs, v: e.vus }];
    case "rate":
      return [{ t: 0, v: e.rate }, { t: e.duration_secs, v: e.rate }];
    case "iterations":
      return [{ t: 0, v: e.vus }, { t: e.max_duration_secs, v: e.vus }];
    case "ramping_vus":
    case "ramping_rate": {
      const out: Pt[] = [{ t: 0, v: e.start }];
      let t = 0;
      for (const s of e.stages) {
        t += s.duration_secs;
        out.push({ t, v: s.target });
      }
      return out;
    }
  }
}

export const duration = (e: Executor) => {
  const p = points(e);
  return p[p.length - 1]?.t ?? 0;
};

export function valueAt(e: Executor, t: number): number {
  const p = points(e);
  if (t <= 0) return p[0]?.v ?? 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!;
    const b = p[i]!;
    if (t <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return p[p.length - 1]?.v ?? 0;
}

/** Iterations started over an open profile (area under the rate, rate converted to per second). */
export function area(e: Executor): number {
  const p = points(e);
  let a = 0;
  for (let i = 1; i < p.length; i++) a += ((p[i]!.v + p[i - 1]!.v) / 2) * (p[i]!.t - p[i - 1]!.t);
  return a / rateUnitSecs(e);
}

/** Highest point of the profile, in the executor's own unit (VUs, or iterations per rate unit). */
export const peak = (e: Executor) => Math.max(...points(e).map((p) => p.v));

/** Peak iterations per second (open models). */
export const peakPerSec = (e: Executor) => peak(e) / rateUnitSecs(e);

export function maxVus(e: Executor): number {
  switch (e.kind) {
    case "vus":
    case "iterations":
      return e.vus;
    case "ramping_vus":
      return peak(e);
    case "rate":
    case "ramping_rate":
      return e.max_vus;
  }
}

/** Short unit for values: "VUs", "iter/s", "iter/min" or "iter/h". */
export const unit = (e: Executor) => (isOpen(e) ? `iter${rateSuffix(rateUnit(e))}` : "VUs");

/** "30 iter/min", or "50 VUs": a profile's level with its unit. */
export const fmtLevel = (e: Executor, v: number) => `${Math.round(v).toLocaleString("en-US")} ${unit(e)}`;

/**
 * Turn per-second iteration counts into the executor's rate unit. Below per second a single
 * second holds 0 or 1 iteration, so each point averages the trailing unit (or as much of it as
 * has run) before scaling: 1 iteration every 2 s reads as 30/min, not 0, 60, 0, 60.
 */
export function toRateUnit(e: Executor, perSecond: Pt[]): Pt[] {
  const w = rateUnitSecs(e);
  if (w === 1 || !perSecond.length) return perSecond;
  const t0 = perSecond[0]!.t - 1;
  let sum = 0;
  let j = 0;
  return perSecond.map((p) => {
    sum += p.v;
    while (perSecond[j]!.t <= p.t - w) sum -= perSecond[j++]!.v;
    return { t: p.t, v: (sum / Math.max(1, Math.min(w, p.t - t0))) * w };
  });
}

/** Convert between executor kinds, keeping the numbers that carry over (and the rate unit between open kinds). */
export function convert(e: Executor, kind: Executor["kind"]): Executor {
  const d = Math.max(1, duration(e));
  const level = Math.max(1, Math.round(isOpen(e) ? peak(e) : maxVus(e)));
  const mv = maxVus(e);
  const rate_unit = rateUnit(e);
  const stages: Stage[] = isStaged(e) && "stages" in e ? e.stages : [{ duration_secs: Math.max(1, Math.round(d / 4)), target: level }, { duration_secs: Math.max(1, d - Math.round(d / 4)), target: level }];
  switch (kind) {
    case "vus":
      return { kind, vus: level, duration_secs: d };
    case "ramping_vus":
      return { kind, start: 0, stages };
    case "rate":
      return { kind, rate: level, rate_unit, duration_secs: d, max_vus: Math.max(mv, 10) };
    case "ramping_rate":
      return { kind, start: 0, stages, rate_unit, max_vus: Math.max(mv, 10) };
    case "iterations":
      return { kind, vus: Math.max(1, Math.round(mv)), iterations: 1000, max_duration_secs: Math.max(d, 600) };
  }
}

/** When a scenario starts and ends on the run's clock. */
export function span(sc: Scenario): [number, number] {
  return [sc.start_offset_secs, sc.start_offset_secs + duration(sc.executor)];
}
