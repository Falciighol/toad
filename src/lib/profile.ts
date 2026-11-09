// Load profiles in the UI: the planned VUs / rate over time, mirroring toad-core's limiter.
import type { Executor, Scenario, Stage } from "../bindings";

export type Pt = { t: number; v: number };

export const isOpen = (e: Executor) => e.kind === "rate" || e.kind === "ramping_rate";
export const isStaged = (e: Executor) => e.kind === "ramping_vus" || e.kind === "ramping_rate";

/** Corner points of the planned profile: (seconds, VUs or iterations/s). */
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

/** Iterations started by time t on an open profile (area under the rate). */
export function area(e: Executor): number {
  const p = points(e);
  let a = 0;
  for (let i = 1; i < p.length; i++) a += ((p[i]!.v + p[i - 1]!.v) / 2) * (p[i]!.t - p[i - 1]!.t);
  return a;
}

export const peak = (e: Executor) => Math.max(...points(e).map((p) => p.v));

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

export const unit = (e: Executor) => (isOpen(e) ? "iter/s" : "VUs");

/** Convert between executor kinds, keeping the numbers that carry over. */
export function convert(e: Executor, kind: Executor["kind"]): Executor {
  const d = Math.max(1, duration(e));
  const level = Math.max(1, Math.round(isOpen(e) ? peak(e) : maxVus(e)));
  const mv = maxVus(e);
  const stages: Stage[] = isStaged(e) && "stages" in e ? e.stages : [{ duration_secs: Math.max(1, Math.round(d / 4)), target: level }, { duration_secs: Math.max(1, d - Math.round(d / 4)), target: level }];
  switch (kind) {
    case "vus":
      return { kind, vus: level, duration_secs: d };
    case "ramping_vus":
      return { kind, start: 0, stages };
    case "rate":
      return { kind, rate: level, duration_secs: d, max_vus: Math.max(mv, 10) };
    case "ramping_rate":
      return { kind, start: 0, stages, max_vus: Math.max(mv, 10) };
    case "iterations":
      return { kind, vus: Math.max(1, Math.round(mv)), iterations: 1000, max_duration_secs: Math.max(d, 600) };
  }
}

/** When a scenario starts and ends on the run's clock. */
export function span(sc: Scenario): [number, number] {
  return [sc.start_offset_secs, sc.start_offset_secs + duration(sc.executor)];
}
