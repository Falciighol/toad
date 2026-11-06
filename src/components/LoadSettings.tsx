import { useMemo, useState, type ReactNode } from "react";
import type { LoadSpec } from "../bindings";
import { validateLoad, type Limits } from "../lib/validate";
import { ASSUMED_LATENCY_MS, describeStatusRange, estimateRun, type RunEstimate } from "../lib/estimate";
import { fmtInt, fmtSecs } from "../lib/format";
import { Field, Icon, NumberInput, Section, Segmented, Toggle } from "./ui";

type Props = {
  value: LoadSpec;
  onChange: (l: LoadSpec) => void;
  limits: Limits;
  showAllErrors?: boolean;
  disabled?: boolean;
};

// NaN marks a field the user cleared; validation reports it instead of silently defaulting.
const num = (v: number | null) => v ?? Number.NaN;
const valid = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

export function LoadSettings({ value, onChange, limits, showAllErrors = false, disabled = false }: Props) {
  const errors = useMemo(() => validateLoad(value, limits), [value, limits]);
  const estimate = useMemo(() => (Object.keys(errors).length ? null : estimateRun(value)), [errors, value]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const touch = (k: string) => setTouched((t) => (t.has(k) ? t : new Set(t).add(k)));
  const err = (k: string) => (showAllErrors || touched.has(k) ? errors[k] : undefined);
  const set = (patch: Partial<LoadSpec>) => onChange({ ...value, ...patch });
  const nanToNull = (v: number) => (Number.isNaN(v) ? null : v);

  const capped = value.rps_cap !== null;
  const workers = valid(value.concurrency) ? value.concurrency : null;
  const cap = valid(value.rps_cap) ? value.rps_cap : null;
  const ramp = valid(value.ramp_up_secs) ? value.ramp_up_secs : 0;

  const rampHint = capped
    ? ramp
      ? `Rate climbs from 1 rps to ${cap ? `${fmtInt(cap)} rps` : "the cap"} over ${fmtSecs(ramp)}.`
      : `Full ${cap ? `${fmtInt(cap)} rps` : "rate"} from the first second.`
    : workers === 1
      ? "Only 1 worker, so there's nothing to ramp."
      : ramp
        ? `Starts 1 worker, adds the rest evenly until all ${workers ? fmtInt(workers) : ""} run at ${fmtSecs(ramp)}.`
        : `All ${workers ? `${fmtInt(workers)} ` : ""}workers start at once.`;

  const stopHint =
    value.stop.kind === "requests"
      ? `Ends once this many requests are sent${ramp ? ", counting ramp-up" : ""}, however long that takes.`
      : `Wall-clock time${valid(value.stop.secs) && value.stop.secs >= 60 ? ` (${fmtSecs(value.stop.secs)})` : ""}${ramp ? `, including the ${fmtSecs(ramp)} ramp-up` : ""}.`;

  const range = describeStatusRange(value.success_range.min, value.success_range.max);

  return (
    <Section title="Load">
      <fieldset disabled={disabled} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Workers"
            error={err("load.concurrency")}
            hint={`Requests in flight at once, up to ${fmtInt(limits.max_concurrency)}.`}
          >
            {(id) => (
              <NumberInput
                id={id}
                min={1}
                max={limits.max_concurrency}
                value={nanToNull(value.concurrency)}
                invalid={!!err("load.concurrency")}
                onBlur={() => touch("load.concurrency")}
                onChange={(v) => set({ concurrency: num(v) })}
              />
            )}
          </Field>
          <Field
            label="Rate limit"
            optional
            error={err("load.rps_cap")}
            hint={capped ? "Requests per second, shared by all workers." : "Empty: no limit. Workers go as fast as the server answers."}
          >
            {(id) => (
              <NumberInput
                id={id}
                suffix="rps"
                min={1}
                max={limits.max_rps}
                placeholder="No limit"
                value={value.rps_cap === null ? null : nanToNull(value.rps_cap)}
                invalid={!!err("load.rps_cap")}
                onBlur={() => touch("load.rps_cap")}
                onChange={(v) => set({ rps_cap: v })}
              />
            )}
          </Field>
        </div>

        <Field label="Stop after" error={err("load.stop")} hint={stopHint}>
          {(id) => (
            <div className="flex gap-1.5">
              <Segmented
                aria-label="Stop condition"
                value={value.stop.kind}
                options={[
                  { value: "duration", label: "Time" },
                  { value: "requests", label: "Requests" },
                ]}
                onChange={(k) => set({ stop: k === "duration" ? { kind: "duration", secs: 30 } : { kind: "requests", count: 1000 } })}
              />
              <div className="flex-1">
                {value.stop.kind === "duration" ? (
                  <NumberInput
                    id={id}
                    suffix="s"
                    min={1}
                    value={nanToNull(value.stop.secs)}
                    invalid={!!err("load.stop")}
                    onBlur={() => touch("load.stop")}
                    onChange={(v) => set({ stop: { kind: "duration", secs: num(v) } })}
                  />
                ) : (
                  <NumberInput
                    id={id}
                    suffix="req"
                    min={1}
                    value={nanToNull(value.stop.count)}
                    invalid={!!err("load.stop")}
                    onBlur={() => touch("load.stop")}
                    onChange={(v) => set({ stop: { kind: "requests", count: num(v) } })}
                  />
                )}
              </div>
            </div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Ramp-up" optional error={err("load.ramp_up_secs")} hint={rampHint}>
            {(id) => (
              <NumberInput
                id={id}
                suffix="s"
                min={0}
                placeholder="0"
                value={value.ramp_up_secs}
                invalid={!!err("load.ramp_up_secs")}
                onBlur={() => touch("load.ramp_up_secs")}
                onChange={(v) => set({ ramp_up_secs: v === 0 ? null : v })}
              />
            )}
          </Field>
          <Field
            label="Request timeout"
            error={err("load.timeout_ms")}
            hint={valid(value.timeout_ms) ? `No full response within ${fmtSecs(value.timeout_ms / 1000)} counts as an error.` : "Per request."}
          >
            {(id) => (
              <NumberInput
                id={id}
                suffix="ms"
                min={1}
                value={nanToNull(value.timeout_ms)}
                invalid={!!err("load.timeout_ms")}
                onBlur={() => touch("load.timeout_ms")}
                onChange={(v) => set({ timeout_ms: num(v) })}
              />
            )}
          </Field>
        </div>

        <RunPlan estimate={estimate} workers={workers} stop={value.stop.kind} />

        <Field
          label="Success status range"
          error={err("load.success_range")}
          hint={range ? `${range} count as success. Other statuses, timeouts and connection errors count as errors.` : "Responses outside this range count as errors."}
        >
          {(id) => (
            <div className="flex items-center gap-1.5">
              <NumberInput
                id={id}
                aria-label="Minimum success status"
                value={nanToNull(value.success_range.min)}
                invalid={!!err("load.success_range")}
                onBlur={() => touch("load.success_range")}
                onChange={(v) => set({ success_range: { ...value.success_range, min: num(v) } })}
              />
              <span className="shrink-0 text-small text-text3">to</span>
              <NumberInput
                aria-label="Maximum success status"
                value={nanToNull(value.success_range.max)}
                invalid={!!err("load.success_range")}
                onBlur={() => touch("load.success_range")}
                onChange={(v) => set({ success_range: { ...value.success_range, max: num(v) } })}
              />
            </div>
          )}
        </Field>

        <div className="space-y-2">
          <Toggle
            label="Follow redirects"
            hint={value.follow_redirects ? "Up to 5 hops; the final response is what gets measured." : "Off: a 3xx response is measured as-is and not followed."}
            checked={value.follow_redirects}
            onChange={(v) => set({ follow_redirects: v })}
          />
          <Toggle
            label={<span className={value.allow_invalid_certs ? "font-medium text-danger" : undefined}>Allow invalid TLS certificates</span>}
            hint="Skips certificate checks. Use only with self-signed test servers."
            checked={value.allow_invalid_certs}
            onChange={(v) => set({ allow_invalid_certs: v })}
          />
        </div>
      </fieldset>
    </Section>
  );
}

/** What the settings above add up to: run length, request count and rate, estimated where needed. */
function RunPlan({ estimate: e, workers, stop }: { estimate: RunEstimate | null; workers: number | null; stop: LoadSpec["stop"]["kind"] }) {
  if (!e || workers === null) {
    return (
      <div className="rounded-lg bg-raised px-3 py-2.5 text-small text-text3">Some settings are invalid. Fix them to see how long this run takes and how many requests it sends.</div>
    );
  }
  const byTime = stop === "duration";
  const approx = (s: string, exact: boolean) => (exact ? s : `≈${s}`);
  const assumption = "estimate";

  const summary = e.capped
    ? `${plural(workers, "worker")} send ${fmtInt(e.rate)} requests per second between them, ${byTime ? `for ${fmtSecs(e.secs)}` : `until ${plural(e.requests, "request")} are sent`}.`
    : `${plural(workers, "worker")} send requests back-to-back, ${byTime ? `for ${fmtSecs(e.secs)}` : `until ${plural(e.requests, "request")} are sent`}.`;

  return (
    <div className="rounded-lg bg-raised px-3 py-2.5" aria-live="polite">
      <div className="text-small font-medium text-text2">This run</div>
      <p className="mt-0.5 text-small text-text3">{summary}</p>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <PlanStat label="Length" value={approx(fmtSecs(e.secs), byTime)} sub={byTime ? "fixed" : e.capped ? "set by rate" : assumption} />
        <PlanStat
          label="Requests"
          value={approx(fmtInt(e.requests), !byTime)}
          sub={!byTime ? "fixed" : e.capped ? (e.workersNeeded ? "if workers keep up" : "set by rate") : assumption}
        />
        <PlanStat
          label="Rate"
          value={e.capped ? `${fmtInt(e.rate)} rps` : `≈${fmtInt(e.rate)} rps`}
          sub={e.capped ? "limit" : "no limit"}
        />
      </dl>
      {e.workersNeeded !== null && (
        <p className="mt-2 flex gap-1.5 text-small text-warning">
          <Icon name="alert" className="mt-px size-3.5" />
          <span>
            {plural(workers, "worker")} reach only ≈{fmtInt(workers * (1000 / ASSUMED_LATENCY_MS))} rps if the server answers in {ASSUMED_LATENCY_MS} ms. Use at least {fmtInt(e.workersNeeded)} to
            hit {fmtInt(e.rate)} rps.
          </span>
        </p>
      )}
      <p className="mt-2 text-micro text-text4">
        {e.latencyBound ? `Estimates assume the server answers in ~${ASSUMED_LATENCY_MS} ms; real numbers depend on its speed. ` : "Latency counts from each request's scheduled send time, so queueing shows up. "}After the run stops, requests still in flight get up to 2 s to finish.
      </p>
    </div>
  );
}

function PlanStat({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-text4">{label}</dt>
      <dd className="tabular truncate font-mono text-body font-medium text-text">{value}</dd>
      <dd className="text-micro text-text4">{sub}</dd>
    </div>
  );
}
