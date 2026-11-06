// Pre-run estimates for the Load panel: how long a run lasts, how many requests it
// sends, and at what rate. Mirrors toad-core's limiter (linear ramp, then flat).
import type { LoadSpec } from "../bindings";

/** Response time assumed for estimates that depend on the server's speed. */
export const ASSUMED_LATENCY_MS = 50;

export type RunEstimate = {
  /** Run length in seconds (excluding the drain after stop). Exact for a duration stop. */
  secs: number;
  /** Total requests sent. Exact for a request-count stop. */
  requests: number;
  /** Steady-state rate: the cap, or what the workers reach at the assumed latency. */
  rate: number;
  capped: boolean;
  /** Whether an estimate depends on the assumed latency (uncapped runs). */
  latencyBound: boolean;
  /** Workers needed to reach the cap at the assumed latency, when there are too few. */
  workersNeeded: number | null;
};

const pos = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Requests sent by time t when the rate climbs linearly from r0 to r over `ramp` seconds. */
export function sentBy(t: number, r0: number, r: number, ramp: number): number {
  if (ramp <= 0) return r * t;
  if (t < ramp) return r0 * t + ((r - r0) * t * t) / (2 * ramp);
  return (ramp * (r0 + r)) / 2 + (t - ramp) * r;
}

/** Time at which the k-th request is sent (inverse of `sentBy`). */
export function timeFor(k: number, r0: number, r: number, ramp: number): number {
  if (ramp <= 0) return k / r;
  const rampSlots = (ramp * (r0 + r)) / 2;
  if (k >= rampSlots) return ramp + (k - rampSlots) / r;
  const a = (r - r0) / (2 * ramp);
  if (a <= 0) return k / r0;
  return (-r0 + Math.sqrt(r0 * r0 + 4 * a * k)) / (2 * a);
}

/** Returns null while a field the estimate needs is empty or invalid. */
export function estimateRun(l: LoadSpec): RunEstimate | null {
  if (!pos(l.concurrency)) return null;
  const capped = l.rps_cap !== null;
  if (capped && !pos(l.rps_cap)) return null;
  const ramp = pos(l.ramp_up_secs) ? l.ramp_up_secs : 0;

  // Closed loop: each worker completes one request per assumed latency.
  const perWorker = 1000 / ASSUMED_LATENCY_MS;
  const ceiling = l.concurrency * perWorker;
  const rate = capped ? l.rps_cap! : ceiling;
  // Capped: the schedule starts at 1 rps. Uncapped: workers start one by one from a single worker.
  const r0 = capped ? Math.min(rate, 1) : l.concurrency > 1 ? perWorker : ceiling;
  const workersNeeded = capped && rate > ceiling ? Math.ceil(rate / perWorker) : null;

  let secs: number;
  let requests: number;
  if (l.stop.kind === "duration") {
    if (!pos(l.stop.secs)) return null;
    secs = l.stop.secs;
    requests = Math.round(sentBy(secs, r0, rate, Math.min(ramp, secs)));
  } else {
    if (!pos(l.stop.count)) return null;
    requests = l.stop.count;
    secs = timeFor(requests, r0, rate, ramp);
  }
  return { secs, requests, rate, capped, latencyBound: !capped, workersNeeded };
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
