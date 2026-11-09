import { useMemo, useState } from "react";
import { Brush, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ErrorKind, RunSummary, Sample, SampleReason, StepOutcome } from "../../bindings";
import { api, errorMessage } from "../../lib/api";
import { fmtInt, fmtLatency } from "../../lib/format";
import { windowStats } from "../../lib/hist";
import { ERROR_LABEL } from "../Breakdowns";
import { axis, ChartLegend, fmtMs, niceAxis, SERIES, tickFmt, tooltipStyle } from "../Charts";
import { Empty, Icon, Pill, Select } from "../ui";
import { errorBound, errRate } from "./Endpoints";
import { asCurl, OUTCOME, SampleView, statusTone } from "./SampleView";

// ---------- Timeline ----------

export function TimelineView({ run, name, onSamples }: { run: RunSummary; name: (id: string) => string; onSamples: (from: number, to: number) => void }) {
  const data = useMemo(() => run.series.map((p) => ({ t: p.t_s, rps: p.rps ?? 0, p95: p.p95 / 1000, p99: p.p99 / 1000 })), [run.series]);
  const [range, setRange] = useState<[number, number]>([0, Math.max(0, data.length - 1)]);
  const from = data[range[0]]?.t ?? 0;
  const to = data[range[1]]?.t ?? 0;
  const whole = range[0] === 0 && range[1] === data.length - 1;
  const msAxis = useMemo(() => niceAxis(Math.max(0, ...data.map((p) => p.p99))), [data]);
  const rpsAxis = useMemo(() => niceAxis(Math.max(0, ...data.map((p) => p.rps))), [data]);
  const msTick = useMemo(() => tickFmt(msAxis.domain[1]), [msAxis]);
  const rpsTick = useMemo(() => tickFmt(rpsAxis.domain[1]), [rpsAxis]);
  const rows = useMemo(
    () =>
      (run.endpoints ?? [])
        .filter((e) => e.phase === "main")
        .map((e) => ({ e, w: windowStats(e.series, from, to) }))
        .sort((a, b) => (b.w.p99 ?? 0) - (a.w.p99 ?? 0)),
    [run.endpoints, from, to],
  );
  if (data.length < 2) return <Empty title="Too short for a timeline" icon="timeline">This run lasted under two seconds.</Empty>;
  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-small font-medium text-text3">Drag the handles under the chart to pick a window</h3>
          <span className="tabular font-mono text-small text-text2">
            {whole ? "Whole run" : `${from} s → ${to} s`} · {to - from + 1} s
          </span>
        </div>
        <div className="mb-1 flex items-center justify-between gap-3 text-micro text-text4">
          <span>ms</span>
          <ChartLegend
            items={[
              { label: "p99 latency", color: SERIES[0] },
              { label: "p95 latency", color: SERIES[0], dashed: true },
              { label: "requests / s (right axis)", color: "var(--text4)", thin: true },
            ]}
          />
          <span>req / s</span>
        </div>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: -8 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="t" tickFormatter={(t: number) => `${t}s`} {...axis} />
              <YAxis yAxisId="ms" {...axis} width={48} tickFormatter={msTick} domain={msAxis.domain} ticks={msAxis.ticks} />
              <YAxis yAxisId="rps" orientation="right" {...axis} width={48} tickFormatter={rpsTick} domain={rpsAxis.domain} ticks={rpsAxis.ticks} />
              <Tooltip {...tooltipStyle} labelFormatter={(t) => `t = ${String(t)} s`} formatter={(v, n) => (n === "requests / s" ? `${Number(v).toFixed(0)} req/s` : `${fmtMs(Number(v))} ms`)} />
              <Line yAxisId="rps" dataKey="rps" name="requests / s" stroke="var(--text4)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line yAxisId="ms" dataKey="p95" name="p95" stroke={SERIES[0]} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              <Line yAxisId="ms" dataKey="p99" name="p99" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Brush dataKey="t" height={22} stroke="var(--line3)" fill="var(--raised)" travellerWidth={8} startIndex={range[0]} endIndex={range[1]} onChange={(r) => setRange([r.startIndex ?? 0, r.endIndex ?? data.length - 1])} tickFormatter={(t: number) => `${t}s`} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-small text-text3">Endpoints in this window. Percentiles are merged from per-second histograms, accurate to about ±15%.</p>
        <button type="button" className="btn btn-sm" onClick={() => onSamples(from * 1000 - 1000, to * 1000)}>
          <Icon name="layers" className="size-3.5" /> Samples in this window
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="tabular w-full text-body">
          <thead>
            <tr className="border-b border-line text-small text-text3">
              <th className="py-2 pr-2 pl-4 text-left font-medium">Endpoint</th>
              <th className="px-2 py-2 text-right font-medium">Requests</th>
              <th className="px-2 py-2 text-right font-medium">Errors</th>
              <th className="px-2 py-2 text-right font-medium">p50</th>
              <th className="px-2 py-2 text-right font-medium">p95</th>
              <th className="py-2 pr-4 pl-2 text-right font-medium">p99</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, w }) => (
              <tr key={e.step_id} className="border-b border-line last:border-0">
                <td className="py-2 pr-2 pl-4 text-text">{name(e.step_id)}</td>
                <td className="px-2 py-2 text-right font-mono text-small">{fmtInt(w.count)}</td>
                <td className={`px-2 py-2 text-right font-mono text-small ${w.failed ? "text-danger" : "text-text3"}`}>{errRate(w.failed, w.count, errorBound(run.config, { stepId: e.step_id, scenarioId: e.scenario_id ?? null, phase: e.phase }))}</td>
                <td className="px-2 py-2 text-right font-mono text-small">{w.p50 ? `≈${fmtLatency(w.p50)}` : "–"}</td>
                <td className="px-2 py-2 text-right font-mono text-small">{w.p95 ? `≈${fmtLatency(w.p95)}` : "–"}</td>
                <td className="py-2 pr-4 pl-2 text-right font-mono text-small font-medium">{w.p99 ? `≈${fmtLatency(w.p99)}` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Errors ----------

/** Replace digits and hex runs so similar messages group together. */
const normalize = (m: string) => m.replace(/\b[0-9a-f]{12,}\b/gi, "…").replace(/\d{5,}/g, "#").slice(0, 160);

export function ErrorsView({ run, samples, name, onSamples }: { run: RunSummary; samples: Sample[] | null; name: (id: string) => string; onSamples: (step: string) => void }) {
  const groups = useMemo(() => {
    const out: { step: string; key: string; label: string; tone: "danger" | "warning"; count: number; examples: Map<string, { n: number; first: number; last: number }> }[] = [];
    const range = run.config.defaults.success_range;
    for (const e of run.endpoints ?? []) {
      for (const s of e.totals.status_counts.filter((x) => x.code < range.min || x.code > range.max)) out.push({ step: e.step_id, key: `status:${s.code}`, label: `Status ${s.code}`, tone: "danger", count: s.count, examples: new Map() });
      for (const k of e.totals.error_counts.filter((x) => x.kind !== "status")) out.push({ step: e.step_id, key: k.kind, label: ERROR_LABEL[k.kind as ErrorKind], tone: "danger", count: k.count, examples: new Map() });
      if (e.outcomes.skipped) out.push({ step: e.step_id, key: "skipped", label: "Skipped (a value it needs was missing)", tone: "warning", count: e.outcomes.skipped, examples: new Map() });
      if (e.outcomes.blocked) out.push({ step: e.step_id, key: "blocked", label: "Blocked (host not confirmed)", tone: "warning", count: e.outcomes.blocked, examples: new Map() });
      if (e.outcomes.build_errors) out.push({ step: e.step_id, key: "build", label: "Couldn't build the request", tone: "danger", count: e.outcomes.build_errors, examples: new Map() });
    }
    for (const s of samples ?? []) {
      if (s.outcome === "ok" || s.outcome === "not_taken") continue;
      const key = s.outcome === "skipped" ? "skipped" : s.outcome === "blocked" ? "blocked" : s.outcome === "build_error" ? "build" : s.error_kind === "status" && s.response ? `status:${s.response.status}` : (s.error_kind ?? "other");
      const g = out.find((x) => x.step === s.step_id && x.key === key);
      if (!g) continue;
      const msg = normalize(s.error ?? "");
      const ex = g.examples.get(msg) ?? { n: 0, first: s.t_ms, last: s.t_ms };
      g.examples.set(msg, { n: ex.n + 1, first: Math.min(ex.first, s.t_ms), last: Math.max(ex.last, s.t_ms) });
    }
    return out.sort((a, b) => b.count - a.count);
  }, [run, samples]);
  if (!groups.length) return <Empty title="No errors" icon="check">Every request completed inside the success range and every check held.</Empty>;
  return (
    <div className="space-y-2">
      <div className="card divide-y divide-line">
        <div className="grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_5rem_6.5rem] gap-3 px-4 py-2 text-small text-text3">
          <span>Kind</span>
          <span>Endpoint, and what the kept samples say</span>
          <span className="text-right">Count</span>
          <span />
        </div>
        {groups.map((g) => {
          const examples = [...g.examples.entries()].slice(0, 3);
          return (
            <div key={`${g.step}-${g.key}`} className="grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_5rem_6.5rem] items-start gap-3 px-4 py-2.5">
              <span className="min-w-0 pt-0.5">
                <Pill tone={g.tone}>{g.label}</Pill>
              </span>
              <div className="min-w-0">
                <div className="truncate text-body text-text">{name(g.step)}</div>
                {examples.length > 0 ? (
                  <ul className="mt-0.5 space-y-0.5">
                    {examples.map(([m, ex]) => (
                      <li key={m} className="flex items-baseline gap-2 text-small">
                        <span className="min-w-0 flex-1 truncate font-mono text-text2" title={m}>
                          {m || "(no message)"}
                        </span>
                        <span className="tabular shrink-0 font-mono text-micro text-text4">
                          {fmtInt(ex.n)} kept · {(ex.first / 1000).toFixed(0)}–{(ex.last / 1000).toFixed(0)} s
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-0.5 text-small text-text4">{g.key === "skipped" || g.key === "blocked" ? "Never sent, so there's no response to show." : "No samples of this kind were kept."}</p>
                )}
              </div>
              <span className="tabular pt-0.5 text-right font-mono text-body font-medium text-text">{fmtInt(g.count)}</span>
              <span className="text-right">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSamples(g.step)}>
                  Samples <Icon name="chevronRight" className="size-3" />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-small text-text4">Counts are exact. Messages and first/last seen come from the kept samples.</p>
    </div>
  );
}

// ---------- Samples ----------

const REASON_LABEL: Record<SampleReason, string> = { failure: "Failure", slow: "Slowest", random: "Random", try: "Try once" };

export function SamplesView(props: { run: RunSummary; samples: Sample[] | null; error: string | null; name: (id: string) => string; filter: { step?: string; from?: number; to?: number }; onFilter: (f: { step?: string; from?: number; to?: number }) => void }) {
  const [reason, setReason] = useState<SampleReason | "all">("all");
  const [outcome, setOutcome] = useState<StepOutcome | "all">("all");
  const [vu, setVu] = useState("");
  const [open, setOpen] = useState<Sample | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [again, setAgain] = useState<Sample | null>(null);
  const f = props.filter;
  const list = useMemo(
    () =>
      (props.samples ?? []).filter(
        (s) =>
          (!f.step || s.step_id === f.step) &&
          (reason === "all" || s.reason === reason) &&
          (outcome === "all" || s.outcome === outcome) &&
          (f.from === undefined || s.t_ms >= f.from) &&
          (f.to === undefined || s.t_ms <= f.to) &&
          (!vu.trim() || String(s.vu) === vu.trim()),
      ),
    [props.samples, f, reason, outcome, vu],
  );
  if (props.error) return <p role="alert" className="text-body text-danger">{props.error}</p>;
  if (!props.samples) return <p className="text-body text-text3">Loading samples…</p>;
  if (props.samples.length === 0)
    return (
      <Empty title="No samples kept" icon="layers">
        Samples are kept per endpoint: every failure up to a cap, the slowest, and a random slice. Caps and body storage are in Settings.
      </Empty>
    );
  const steps = [...new Set(props.samples.map((s) => s.step_id))];
  const copy = async (s: Sample) => {
    try {
      await navigator.clipboard.writeText(asCurl(s));
      setNote("Copied as cURL.");
    } catch {
      setNote("Couldn't reach the clipboard.");
    }
  };
  const sendAgain = async (s: Sample) => {
    setNote(null);
    try {
      const r = await api.sendStep(props.run.config, s.step_id, s.vars.filter((v) => v.value !== "[redacted]"));
      if (r.steps[0]) setAgain(r.steps[0]);
    } catch (e) {
      setNote(errorMessage(e));
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Endpoint" className="w-64!" value={f.step ?? ""} onChange={(v) => props.onFilter({ ...f, step: v || undefined })} options={[{ value: "", label: "Every endpoint" }, ...steps.map((id) => ({ value: id, label: props.name(id) }))]} />
        <Select<SampleReason | "all">
          aria-label="Why it was kept"
          className="w-36!"
          value={reason}
          onChange={setReason}
          options={[
            { value: "all", label: "Any reason" },
            { value: "failure", label: "Failures" },
            { value: "slow", label: "Slowest" },
            { value: "random", label: "Random" },
          ]}
        />
        <Select<StepOutcome | "all">
          aria-label="Outcome"
          className="w-36!"
          value={outcome}
          onChange={setOutcome}
          options={[{ value: "all", label: "Any outcome" }, ...(Object.keys(OUTCOME) as StepOutcome[]).map((o) => ({ value: o, label: OUTCOME[o].label }))]}
        />
        <input className="input w-24! font-mono" placeholder="VU #" aria-label="Virtual user" value={vu} onChange={(e) => setVu(e.target.value)} />
        {(f.from !== undefined || f.to !== undefined) && (
          <button type="button" className="btn btn-sm" onClick={() => props.onFilter({ step: f.step })}>
            {((f.from ?? 0) / 1000).toFixed(0)}–{((f.to ?? 0) / 1000).toFixed(0)} s <Icon name="x" className="size-3" />
          </button>
        )}
        <span className="ml-auto tabular text-small text-text3">
          {fmtInt(list.length)} of {fmtInt(props.samples.length)}
          {props.run.samples?.truncated && " · caps reached during the run"}
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-3">
        <ul className="card max-h-[70vh] divide-y divide-line overflow-y-auto">
          {list.slice(0, 500).map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(s);
                  setAgain(null);
                  setNote(null);
                }}
                className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 px-3 py-2 text-left ${open?.id === s.id ? "bg-accent-soft" : "hover:bg-raised"}`}
              >
                {s.response ? <Pill tone={statusTone(s.response.status)}>{s.response.status}</Pill> : <Pill tone={OUTCOME[s.outcome].tone}>{OUTCOME[s.outcome].label}</Pill>}
                <span className="min-w-0">
                  <span className="block truncate text-body text-text">{props.name(s.step_id)}</span>
                  <span className="block truncate text-micro text-text4">
                    {REASON_LABEL[s.reason]} · VU {s.vu} · iteration {s.iteration} · {(s.t_ms / 1000).toFixed(1)} s
                  </span>
                </span>
                <span className="tabular font-mono text-small text-text2">{s.latency_us ? fmtLatency(s.latency_us) : "–"}</span>
              </button>
            </li>
          ))}
          {list.length > 500 && <li className="px-3 py-2 text-small text-text4">Showing the first 500; narrow the filters to see the rest.</li>}
          {list.length === 0 && <li className="px-3 py-4 text-small text-text3">Nothing matches these filters.</li>}
        </ul>
        <div className="card min-w-0 p-4">
          {open ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 flex-1 truncate text-title font-semibold">{props.name(open.step_id)}</h3>
                <button type="button" className="btn btn-sm" onClick={() => void copy(open)} disabled={!open.request}>
                  <Icon name="copy" className="size-3.5" /> Copy as cURL
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void sendAgain(open)} title="Sends the step again with this sample's variables; host checks apply">
                  <Icon name="bolt" className="size-3.5" /> Send again
                </button>
              </div>
              {note && <p className="text-small text-text3">{note}</p>}
              {open.trace.length > 0 && (
                <p className="text-small text-text3">
                  <Icon name="flow" className="mr-1 inline size-3.5 align-[-2px]" />
                  Step {open.trace.length + 1} of this iteration. The steps before it are under Checks & variables.
                </p>
              )}
              <SampleView sample={open} stepName={props.name} />
              {again && (
                <div className="border-t border-line pt-3">
                  <h4 className="mb-2 text-small font-medium text-text3">Sent again just now</h4>
                  <SampleView sample={again} stepName={props.name} />
                </div>
              )}
            </div>
          ) : (
            <p className="text-small text-text3">Pick a request to see what was sent, what came back, and the iteration that led to it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
