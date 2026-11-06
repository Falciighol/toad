import { useMemo, useState } from "react";
import type { LoadSpec } from "../bindings";
import { validateLoad, type Limits } from "../lib/validate";
import { fmtInt } from "../lib/format";
import { Field, NumberInput, Section, Segmented, Toggle } from "./ui";

type Props = {
  value: LoadSpec;
  onChange: (l: LoadSpec) => void;
  limits: Limits;
  showAllErrors?: boolean;
  disabled?: boolean;
};

// NaN marks a field the user cleared; validation reports it instead of silently defaulting.
const num = (v: number | null) => v ?? Number.NaN;

export function LoadSettings({ value, onChange, limits, showAllErrors = false, disabled = false }: Props) {
  const errors = useMemo(() => validateLoad(value, limits), [value, limits]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const touch = (k: string) => setTouched((t) => (t.has(k) ? t : new Set(t).add(k)));
  const err = (k: string) => (showAllErrors || touched.has(k) ? errors[k] : undefined);
  const set = (patch: Partial<LoadSpec>) => onChange({ ...value, ...patch });
  const nanToNull = (v: number) => (Number.isNaN(v) ? null : v);

  const capped = value.rps_cap !== null;
  // Little's law hint: N workers at latency L can do at most N / L requests per second.
  const at50ms = value.concurrency > 0 ? value.concurrency / 0.05 : 0;

  return (
    <Section title="Load">
      <fieldset disabled={disabled} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Concurrency (workers)" error={err("load.concurrency")} hint={`Max ${fmtInt(limits.max_concurrency)}`}>
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
          <Field label="Timeout" error={err("load.timeout_ms")}>
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

        <Field label="Stop after" error={err("load.stop")} hint={value.stop.kind === "requests" && value.ramp_up_secs ? "Includes requests sent during ramp-up." : undefined}>
          {(id) => (
            <div className="flex gap-1.5">
              <Segmented
                aria-label="Stop condition"
                value={value.stop.kind}
                options={[
                  { value: "duration", label: "Duration" },
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
          <Field
            label="RPS cap"
            error={err("load.rps_cap")}
            hint={capped ? "Latency is measured from each request's scheduled time." : "Off: closed model (send → wait → repeat)."}
          >
            {(id) => (
              <NumberInput
                id={id}
                suffix="rps"
                min={1}
                placeholder="Off"
                value={value.rps_cap === null ? null : nanToNull(value.rps_cap)}
                invalid={!!err("load.rps_cap")}
                onBlur={() => touch("load.rps_cap")}
                onChange={(v) => set({ rps_cap: v })}
              />
            )}
          </Field>
          <Field
            label="Ramp-up"
            error={err("load.ramp_up_secs")}
            hint={capped ? "Rate rises linearly to the cap." : "Workers start linearly, 1 → N."}
          >
            {(id) => (
              <NumberInput
                id={id}
                suffix="s"
                min={0}
                placeholder="None"
                value={value.ramp_up_secs}
                invalid={!!err("load.ramp_up_secs")}
                onBlur={() => touch("load.ramp_up_secs")}
                onChange={(v) => set({ ramp_up_secs: v === 0 ? null : v })}
              />
            )}
          </Field>
        </div>
        {capped && value.concurrency > 0 && (
          <p className="rounded-md bg-surface-2 px-2 py-1.5 text-xs text-ink-2">
            Concurrency limits in-flight requests: {fmtInt(value.concurrency)} workers reach at most ≈{fmtInt(at50ms)} rps if the server answers in 50 ms.
          </p>
        )}

        <Field label="Success status range" error={err("load.success_range")}>
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
              <span className="text-ink-3">–</span>
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
          <Toggle label="Follow redirects (max 5)" checked={value.follow_redirects} onChange={(v) => set({ follow_redirects: v })} />
          <Toggle
            label={<span className={value.allow_invalid_certs ? "font-medium text-critical" : undefined}>Allow invalid TLS certificates</span>}
            hint="Disables certificate verification. Only for self-signed test servers."
            checked={value.allow_invalid_certs}
            onChange={(v) => set({ allow_invalid_certs: v })}
          />
        </div>
      </fieldset>
    </Section>
  );
}
