import type { Cmp, TestConfig, Threshold, ThresholdMetric } from "../../bindings";
import { newThreshold } from "../../lib/defaults";
import { describeStatusRange } from "../../lib/estimate";
import { allSteps, stepLabel } from "../../lib/flow";
import type { Errors } from "../../lib/stages";
import { DurationInput, Empty, Field, Icon, IconButton, NumberInput, Select } from "../ui";
import { Block, StageHeader } from "./DataStage";

export const METRICS: { value: ThresholdMetric; label: string; unit: string }[] = [
  { value: "p50", label: "Latency p50", unit: "ms" },
  { value: "p90", label: "Latency p90", unit: "ms" },
  { value: "p95", label: "Latency p95", unit: "ms" },
  { value: "p99", label: "Latency p99", unit: "ms" },
  { value: "max", label: "Latency max", unit: "ms" },
  { value: "error_rate", label: "Error rate", unit: "%" },
  { value: "check_pass_rate", label: "Check pass rate", unit: "%" },
  { value: "rps", label: "Achieved rps", unit: "rps" },
  { value: "dropped", label: "Dropped iterations", unit: "" },
];

const OPS: { value: Cmp; label: string }[] = [
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
];

export function ChecksStage({ config: c, onChange, errors, onJump }: { config: TestConfig; onChange: (c: TestConfig) => void; errors: Errors; onJump: (stepId: string) => void }) {
  const r = c.defaults.success_range;
  const range = describeStatusRange(r.min, r.max);
  const scopes = [
    { value: "", label: "Whole test" },
    ...c.scenarios.map((s) => ({ value: `scenario:${s.id}`, label: `Scenario · ${s.name}` })),
    ...allSteps(c).map((ref) => ({ value: `step:${ref.step.id}`, label: `Step · ${stepLabel(ref.step)}` })),
  ];
  const set = (id: string, patch: Partial<Threshold>) => onChange({ ...c, thresholds: c.thresholds.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const withChecks = allSteps(c).filter((x) => x.step.checks.some((k) => k.enabled));
  return (
    <div className="mx-auto max-w-5xl px-8 py-7">
      <StageHeader title="Checks">What counts as success, and the pass/fail criteria that make up the run's verdict.</StageHeader>
      <Block title="Success status" hint={range ? `${range} count as success. Other statuses, timeouts and connection errors count as errors.` : "Responses outside this range count as errors."}>
        <div className="flex max-w-sm items-center gap-1.5">
          <NumberInput aria-label="Lowest success status" value={r.min} invalid={!!errors["defaults.success_range"]} onChange={(v) => onChange({ ...c, defaults: { ...c.defaults, success_range: { ...r, min: v ?? Number.NaN } } })} />
          <span className="text-small text-text3">to</span>
          <NumberInput aria-label="Highest success status" value={r.max} invalid={!!errors["defaults.success_range"]} onChange={(v) => onChange({ ...c, defaults: { ...c.defaults, success_range: { ...r, max: v ?? Number.NaN } } })} />
        </div>
        {errors["defaults.success_range"] && <p role="alert" className="mt-1.5 text-small text-danger">{errors["defaults.success_range"]}</p>}
      </Block>

      <Block
        title="Thresholds"
        hint="Each one passes or fails at the end of the run. Turn on Abort to stop the run the moment it's crossed. Headless runs exit 99 when one fails."
        aside={
          <button type="button" className="btn btn-sm" onClick={() => onChange({ ...c, thresholds: [...c.thresholds, newThreshold()] })}>
            <Icon name="plus" className="size-3" /> Threshold
          </button>
        }
      >
        {c.thresholds.length === 0 ? (
          <Empty title="No thresholds" icon="shield" action={<button type="button" className="btn btn-sm" onClick={() => onChange({ ...c, thresholds: [newThreshold(), { ...newThreshold(), metric: "error_rate", value: 1 }] })}>Add p95 &lt; 500 ms and errors &lt; 1%</button>}>
            Without thresholds a run has no verdict; you read the numbers yourself.
          </Empty>
        ) : (
          <div className="space-y-2">
            {c.thresholds.map((t) => {
              const m = METRICS.find((x) => x.value === t.metric)!;
              const err = errors[`threshold:${t.id}`];
              return (
                <div key={t.id} className={`rounded-xl border px-3 py-2.5 ${err ? "border-danger/50" : "border-line"} ${t.enabled ? "" : "opacity-60"}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input type="checkbox" className="size-3.5" aria-label="Use this threshold" checked={t.enabled} onChange={(e) => set(t.id, { enabled: e.target.checked })} />
                    <Select aria-label="Metric" className="w-44! shrink-0" value={t.metric} onChange={(metric) => set(t.id, { metric })} options={METRICS} />
                    <Select aria-label="Comparison" className="w-16! shrink-0 font-mono" value={t.op} onChange={(op) => set(t.id, { op })} options={OPS} />
                    <div className="w-32 shrink-0">
                      <NumberInput aria-label="Value" suffix={m.unit} value={t.value} onChange={(v) => set(t.id, { value: v ?? Number.NaN })} invalid={!!err} />
                    </div>
                    <span className="text-small text-text3">for</span>
                    <Select aria-label="Scope" className="min-w-0 flex-1" value={t.scope} onChange={(scope) => set(t.id, { scope })} options={scopes} />
                    <IconButton icon="x" size="sm" label="Remove threshold" onClick={() => onChange({ ...c, thresholds: c.thresholds.filter((x) => x.id !== t.id) })} />
                  </div>
                  <div className="mt-2 flex items-center gap-3 pl-5 text-small text-text3">
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" className="size-3.5" checked={t.abort} onChange={(e) => set(t.id, { abort: e.target.checked })} />
                      <span className={t.abort ? "font-medium text-text" : ""}>Abort the run when crossed</span>
                    </label>
                    {t.abort && (
                      <label className="flex items-center gap-1.5">
                        after the first
                        <span className="w-32">
                          <DurationInput aria-label="Evaluate after" min={0} value={t.delay_secs} onChange={(v) => set(t.id, { delay_secs: Math.max(0, v ?? 0) })} />
                        </span>
                      </label>
                    )}
                  </div>
                  {err && <p role="alert" className="mt-1 pl-5 text-small text-danger">{err}</p>}
                </div>
              );
            })}
          </div>
        )}
      </Block>

      <Block title="Warm-up" hint="The first seconds of a run (connection setup, JIT, cold caches) can be left out of the verdict. They still appear in every chart, marked as excluded.">
        <div className="w-44">
          <Field label="Exclude the first" error={errors["warmup_secs"]}>
            {(id) => <DurationInput id={id} units={["s", "min"]} min={0} value={c.warmup_secs} onChange={(v) => onChange({ ...c, warmup_secs: Math.max(0, v ?? 0) })} />}
          </Field>
        </div>
      </Block>

      <Block title="Checks on steps" hint="Assertions on each response live with their step (Flow → Checks).">
        {withChecks.length === 0 ? (
          <p className="text-small text-text4">No step has checks yet.</p>
        ) : (
          <ul className="space-y-1">
            {withChecks.map((x) => (
              <li key={x.step.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-body hover:bg-raised" onClick={() => onJump(x.step.id)}>
                  <span className="min-w-0 flex-1 truncate">{stepLabel(x.step)}</span>
                  <span className="tabular font-mono text-small text-text3">{x.step.checks.filter((k) => k.enabled).length} checks</span>
                  <Icon name="chevronRight" className="size-3.5 text-text4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}
