import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ExportFormat, OutcomeCounts, RunSummary, Sample, Scenario, Snapshot, TestConfig, Threshold, ThresholdResult, Warning } from "../../bindings";
import { api, errorMessage } from "../../lib/api";
import { allSteps, findStep, itemSteps, stepLabel } from "../../lib/flow";
import { fmtBytes, fmtDate, fmtDuration, fmtInt, fmtLatency, fmtPct, fmtRps } from "../../lib/format";
import { fmtLevel, isOpen, points, rateUnitSecs, span, toRateUnit } from "../../lib/profile";
import type { ChartPoint } from "../../lib/series";
import { seriesFromSummary } from "../../lib/series";
import { warningText } from "../Breakdowns";
import { axis, ChartLegend, fmtMs, markerLabel, niceAxis, SERIES, tickFmt, tooltipStyle, useStaggeredMount } from "../Charts";
import { ProfileChart } from "../test/ProfileChart";
import { Icon, type IconName, Kbd, Pill, type Tone } from "../ui";
import { EndpointBoard, EndpointDetail, rowsFromLive, rowsFromSummary } from "./Endpoints";
import { ErrorsView, SamplesView, TimelineView } from "./Sections";

export type Section = "overview" | "endpoints" | "timeline" | "errors" | "samples" | "config";
const SECTIONS: { id: Section; label: string; icon: IconName; live: boolean }[] = [
  { id: "overview", label: "Overview", icon: "grid", live: true },
  { id: "endpoints", label: "Endpoints", icon: "list", live: true },
  { id: "timeline", label: "Timeline", icon: "timeline", live: false },
  { id: "errors", label: "Errors", icon: "alert", live: false },
  { id: "samples", label: "Samples", icon: "layers", live: false },
  { id: "config", label: "Config", icon: "review", live: false },
];

const END: Record<RunSummary["end_reason"], { label: string; tone: Tone; icon: IconName }> = {
  completed: { label: "Completed", tone: "success", icon: "check" },
  stopped: { label: "Stopped", tone: "neutral", icon: "stop" },
  aborted: { label: "Aborted by threshold", tone: "danger", icon: "shield" },
  failed: { label: "Failed", tone: "danger", icon: "x" },
};

const mod = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";

/** One live second of a scenario: busy VUs and iterations started so far (cumulative). */
export type ScenarioTick = { t: number; vus: number; iterations: number };
export type Live = { snapshot: Snapshot | null; series: ChartPoint[]; spark: Map<string, number[]>; scen: Record<string, ScenarioTick[]>; config: TestConfig };

export function RunView(props: {
  live: Live | null;
  summary: RunSummary | null;
  previous: RunSummary | null;
  onStop: () => void;
  onExport: (f: ExportFormat) => void;
  onOpenTest: (c: TestConfig) => void;
  onBack: () => void;
  backLabel: string;
}) {
  const [section, setSection] = useState<Section>("overview");
  const [detail, setDetail] = useState<string | null>(null);
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [sampleFilter, setSampleFilter] = useState<{ step?: string; from?: number; to?: number }>({});
  const [groupByUrl, setGroupByUrl] = useState(false);
  const s = props.summary;
  const liveMode = !s;
  const config = s?.config ?? props.live!.config;
  const snap = props.live?.snapshot ?? null;

  useEffect(() => {
    setSamples(null);
    setDetail(null);
    if (!s) return;
    api.getSamples(s.run_id).then(setSamples).catch((e) => setSamplesError(errorMessage(e)));
  }, [s?.run_id, s]);

  // Leave sections that need a finished run while it's live.
  useEffect(() => {
    if (liveMode && !SECTIONS.find((x) => x.id === section)!.live) setSection("overview");
  }, [liveMode, section]);

  const durationS = s ? s.duration_ms / 1000 : (snap?.t_ms ?? 0) / 1000;
  const verdict = s?.verdict ?? snap?.thresholds ?? [];
  const rows = useMemo(() => (s ? rowsFromSummary(s, s.verdict ?? [], durationS) : rowsFromLive(config, snap?.endpoints ?? [], props.live?.spark ?? new Map(), snap?.thresholds ?? [])), [s, durationS, config, snap, props.live?.spark]);
  const name = (id: string) => {
    const r = findStep(config, id);
    return r ? stepLabel(r.step) : id;
  };
  const legacy = s && (!s.endpoints || s.endpoints.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-chrome px-3">
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onBack}>
          <Icon name="back" className="size-3.5" /> {props.backLabel}
        </button>
        <span className="h-5 w-px bg-line2" aria-hidden />
        <h1 className="min-w-0 truncate text-title font-semibold">{config.name}</h1>
        {s ? (
          <Pill tone={END[s.end_reason].tone}>
            <Icon name={END[s.end_reason].icon} /> {END[s.end_reason].label}
          </Pill>
        ) : (
          <Pill tone={snap?.phase === "stopping" ? "warning" : "info"}>
            <span className="size-1.5 animate-pulse rounded-full bg-current" /> {snap ? snap.phase.charAt(0).toUpperCase() + snap.phase.slice(1) : "Starting"}
          </Pill>
        )}
        <span className="tabular font-mono text-small text-text3">{s ? `${fmtDate(s.started_at)} · ${fmtDuration(s.duration_ms)}` : fmtDuration(snap?.t_ms ?? 0)}</span>
        <span className="flex-1" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => props.onOpenTest(config)}>
          Open test
        </button>
        {liveMode ? (
          <button type="button" className="btn btn-danger btn-sm w-24" onClick={props.onStop} disabled={snap?.phase === "stopping"} title={`Stop (${mod}.)`}>
            <Icon name="stop" className="size-3" /> {snap?.phase === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm" onClick={() => props.onExport("csv")}>
              <Icon name="download" className="size-3.5" /> CSV
            </button>
            <button type="button" className="btn btn-sm" onClick={() => props.onExport("json")}>
              <Icon name="download" className="size-3.5" /> JSON
            </button>
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Run sections" className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-line bg-chrome p-2 max-[1200px]:w-14">
          {SECTIONS.map((x) => {
            const disabled = liveMode && !x.live;
            const on = section === x.id;
            const count = x.id === "samples" ? (s?.samples?.count ?? 0) : x.id === "errors" ? (s?.totals.failed ?? 0) + (s?.outcomes?.blocked ?? 0) + (s?.outcomes?.skipped ?? 0) : x.id === "endpoints" ? rows.filter((r) => r.phase === "main").length : 0;
            return (
              <button
                key={x.id}
                type="button"
                disabled={disabled}
                aria-current={on ? "page" : undefined}
                title={disabled ? `${x.label}: available when the run ends` : x.label}
                onClick={() => {
                  setSection(x.id);
                  setDetail(null);
                }}
                className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-body font-medium transition-colors disabled:opacity-40 max-[1200px]:justify-center ${on ? "bg-accent-soft text-text" : "text-text2 enabled:hover:bg-raised"}`}
              >
                <Icon name={x.icon} className={`size-4 ${on ? "text-accent-ink" : "text-text3"}`} />
                <span className="flex-1 max-[1200px]:hidden">{x.label}</span>
                {count > 0 && <span className={`tabular font-mono text-micro max-[1200px]:hidden ${x.id === "errors" ? "text-danger" : "text-text4"}`}>{fmtInt(count)}</span>}
              </button>
            );
          })}
          {liveMode && <p className="mt-auto px-2.5 pb-1 text-micro text-text4 max-[1200px]:hidden">Timeline, errors and samples open when the run ends.</p>}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl space-y-3 px-6 py-5">
            {legacy && (
              <p className="rounded-lg bg-raised px-3 py-2 text-small text-text3">This run was recorded before per-endpoint analysis, so only whole-run numbers exist.</p>
            )}
            {section === "overview" && <Overview summary={s} live={props.live} verdict={verdict} onEndpoint={(id) => { setSection("endpoints"); setDetail(id); }} />}
            {section === "endpoints" &&
              (detail && s ? (
                <EndpointDetail
                  run={s}
                  stepId={detail}
                  previous={props.previous}
                  warmup={config.warmup_secs}
                  onBack={() => setDetail(null)}
                  onSamples={(id) => {
                    setSampleFilter({ step: id });
                    setSection("samples");
                  }}
                />
              ) : (
                <EndpointBoard rows={rows.filter((r) => r.phase === "main" || r.requests > 0)} live={liveMode} onOpen={(id) => s && setDetail(id)} groupByUrl={groupByUrl} onGroupByUrl={setGroupByUrl} />
              ))}
            {section === "timeline" && s && (
              <TimelineView
                run={s}
                name={name}
                onSamples={(from, to) => {
                  setSampleFilter({ from, to });
                  setSection("samples");
                }}
              />
            )}
            {section === "errors" && s && <ErrorsView run={s} samples={samples} name={name} onSamples={(step) => { setSampleFilter({ step }); setSection("samples"); }} />}
            {section === "samples" && s && <SamplesView run={s} samples={samples} error={samplesError} name={name} filter={sampleFilter} onFilter={setSampleFilter} />}
            {section === "config" && s && <ConfigView run={s} />}
          </div>
        </main>
      </div>
    </div>
  );
}

/** A threshold's observed value in its own unit: latency in ms, rates in %, throughput in rps. */
function observedText(v: number, t: Threshold | undefined): string {
  const n = v.toFixed(v >= 100 ? 0 : 2);
  switch (t?.metric) {
    case "error_rate":
    case "check_pass_rate":
      return `${n}%`;
    case "rps":
      return `${n} rps`;
    case "dropped":
      return fmtInt(v);
    case undefined:
      return n;
    default:
      return `${n} ms`;
  }
}

function Verdict({ verdict, thresholds, aborted }: { verdict: ThresholdResult[]; thresholds: Threshold[]; aborted?: string | null }) {
  if (!verdict.length) return null;
  const failed = verdict.filter((v) => !v.passed && !v.pending);
  const pass = failed.length === 0;
  return (
    <div className={`rounded-xl px-4 py-3 ${pass ? "bg-success-soft" : "bg-danger-soft"}`}>
      <div className={`flex items-center gap-2 text-body font-semibold ${pass ? "text-success" : "text-danger"}`}>
        <Icon name={pass ? "check" : "x"} className="size-4" />
        {pass ? `All ${verdict.length} thresholds pass` : `${failed.length} of ${verdict.length} thresholds fail`}
        {aborted && <span className="font-normal text-text2">· aborted when {aborted} was crossed</span>}
      </div>
      <ul className="mt-1.5 grid grid-cols-2 gap-x-6 gap-y-0.5">
        {verdict.map((v) => (
          <li key={v.id} className="flex items-center gap-2 text-small">
            <Icon name={v.pending ? "pause" : v.passed ? "check" : "x"} className={`size-3.5 ${v.pending ? "text-text4" : v.passed ? "text-success" : "text-danger"}`} />
            <span className="min-w-0 flex-1 truncate text-text">{v.label}</span>
            <span className="tabular font-mono text-text3">{v.pending ? "pending" : observedText(v.observed ?? 0, thresholds.find((t) => t.id === v.id))}</span>
            {v.crossed_at_ms !== null && !v.passed && <span className="tabular font-mono text-micro text-danger">at {(v.crossed_at_ms / 1000).toFixed(0)} s</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Outcomes({ total, ok, failed, cancelled, o }: { total: number; ok: number; failed: number; cancelled: number; o: OutcomeCounts | null }) {
  const sent: { label: string; value: number; tone?: string; hint: string }[] = [
    { label: "OK", value: ok, tone: "text-success", hint: "Completed, in the success range, checks passed" },
    { label: "Failed", value: failed, tone: failed ? "text-danger" : undefined, hint: "Status, failing check, or transport error" },
  ];
  const other: { label: string; value: number; tone?: string; hint: string }[] = [
    { label: "Skipped", value: o?.skipped ?? 0, tone: o?.skipped ? "text-warning" : undefined, hint: "Not sent: a value it needs was missing" },
    { label: "Not taken", value: o?.not_taken ?? 0, hint: "Run if was false (normal path)" },
    { label: "Blocked", value: o?.blocked ?? 0, tone: o?.blocked ? "text-warning" : undefined, hint: "Host not confirmed" },
    { label: "Dropped", value: o?.dropped ?? 0, tone: o?.dropped ? "text-warning" : undefined, hint: "Iterations that never got a virtual user" },
    { label: "Cancelled", value: cancelled, hint: "Cut off by Stop or graceful stop" },
  ];
  return (
    <div className="card">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-2.5">
        <span className="text-small font-medium text-text3">Requests</span>
        <span className="tabular font-mono text-display font-medium">{fmtInt(total)}</span>
      </div>
      <dl className="grid grid-cols-2 divide-x divide-line border-b border-line">
        {sent.map((c) => (
          <div key={c.label} className="min-w-0 px-4 py-2.5" title={c.hint}>
            <dt className="text-micro text-text3">{c.label}</dt>
            <dd className={`tabular mt-0.5 truncate font-mono text-title font-medium ${c.tone ?? (c.value ? "text-text" : "text-text4")}`}>{fmtInt(c.value)}</dd>
          </div>
        ))}
      </dl>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5 text-small">
        {other.map((c) => (
          <div key={c.label} className="flex items-baseline gap-1.5" title={c.hint}>
            <dt className="text-text3">{c.label}</dt>
            <dd className={`tabular font-mono ${c.tone ?? (c.value ? "text-text" : "text-text4")}`}>{fmtInt(c.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SeriesChart({ title, data, lines, markers, warmup, slot = 0, unit }: { title: string; data: ChartPoint[]; lines: { key: keyof ChartPoint; name: string; color: string; dashed?: boolean }[]; markers: { t: number; label: string }[]; warmup: number; slot?: number; unit: "ms" | "rps" | "n" }) {
  const ready = useStaggeredMount(slot, data.length > 0);
  const fmt = (v: number) => (unit === "ms" ? `${fmtMs(v)} ms` : unit === "rps" ? fmtRps(v) : fmtInt(v));
  const yAxis = useMemo(() => niceAxis(Math.max(0, ...data.flatMap((p) => lines.map((l) => Number(p[l.key] ?? 0))))), [data, lines]);
  const tick = useMemo(() => tickFmt(yAxis.domain[1]), [yAxis]);
  const first = data[0]?.t ?? 0;
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-small font-medium text-text3">{title}</h3>
        {lines.length > 1 && <ChartLegend items={lines.map((l) => ({ label: l.name, color: l.color, dashed: l.dashed }))} />}
      </div>
      <div className="h-44">
        {data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-small text-text4">Waiting for the first full second…</div>
        ) : (
          ready && (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                {warmup > first && <ReferenceArea x1={first} x2={warmup} fill="var(--raised2)" ifOverflow="hidden" label={markerLabel("warm-up", 0)} />}
                {markers.map((m, i) => (
                  <ReferenceLine key={i} x={m.t} stroke="var(--line3)" strokeDasharray="3 3" label={markerLabel(m.label, i + (warmup > first ? 1 : 0))} />
                ))}
                <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => `${t}s`} {...axis} />
                <YAxis {...axis} width={48} tickFormatter={tick} domain={yAxis.domain} ticks={yAxis.ticks} />
                <Tooltip {...tooltipStyle} labelFormatter={(t) => `t = ${String(t)} s`} formatter={(v) => fmt(Number(v))} />
                {lines.map((l) => (
                  <Line key={String(l.key)} name={l.name} dataKey={l.key as string} stroke={l.color} strokeWidth={l.dashed ? 1.5 : 2} strokeDasharray={l.dashed ? "4 4" : undefined} dot={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )
        )}
      </div>
    </div>
  );
}

function WarningGroups({ warnings }: { warnings: Warning[] }) {
  if (!warnings.length) return null;
  const mine = warnings.filter((w) => warningText(w).toadIssue);
  const theirs = warnings.filter((w) => !warningText(w).toadIssue);
  const block = (list: Warning[], title: string) =>
    list.length > 0 && (
      <div className="space-y-1.5">
        <div className="text-micro font-semibold tracking-wide text-text3 uppercase">{title}</div>
        {list.map((w, i) => {
          const t = warningText(w);
          return (
            <div key={i} className="flex gap-2.5 rounded-xl bg-warning-soft px-4 py-3">
              <Icon name="alert" className="mt-px size-4 text-warning" />
              <div>
                <div className="text-body font-semibold text-warning">{t.title}</div>
                <div className="mt-0.5 text-small text-text2">{t.body}</div>
              </div>
            </div>
          );
        })}
      </div>
    );
  return (
    <div className="space-y-3" role="alert">
      {block(mine, "On Toad's side (the numbers may understate the target)")}
      {block(theirs, "About the load and the target")}
    </div>
  );
}

function Overview({ summary: s, live, verdict, onEndpoint }: { summary: RunSummary | null; live: Live | null; verdict: ThresholdResult[]; onEndpoint: (id: string) => void }) {
  const snap = live?.snapshot ?? null;
  const config = s?.config ?? live!.config;
  const series = useMemo(() => (s ? seriesFromSummary(s.series) : (live?.series ?? [])), [s, live?.series]);
  const enabled = config.scenarios.filter((x) => x.enabled);
  const capped = s ? s.capped : enabled.some((x) => isOpen(x.executor));
  const lat = s ? (capped ? s.latency_corrected : s.latency_raw) : (snap?.lat_cumulative ?? null);
  const markers = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    for (const sc of enabled) {
      const pts = points(sc.executor);
      pts.slice(1, -1).forEach((p, i) => out.push({ t: Math.round(p.t + sc.start_offset_secs), label: enabled.length > 1 ? `${sc.name} ${i + 2}` : `stage ${i + 2}` }));
      if (sc.start_offset_secs) out.push({ t: sc.start_offset_secs, label: `${sc.name} starts` });
    }
    for (const v of verdict) if (v.crossed_at_ms !== null && !v.passed) out.push({ t: Math.round(v.crossed_at_ms / 1000), label: "threshold" });
    return out.slice(0, 12);
  }, [enabled, verdict]);
  const one = enabled.length === 1 ? enabled[0]! : null;
  /** What a scenario's profile achieved: busy VUs (closed model) or iterations started (open model, in the plan's rate unit). */
  const achievedFor = (sc: Scenario): { t: number; v: number }[] | undefined => {
    const perSec = achievedPerSecond(sc);
    return perSec && isOpen(sc.executor) ? toRateUnit(sc.executor, perSec) : perSec;
  };
  const achievedPerSecond = (sc: Scenario): { t: number; v: number }[] | undefined => {
    const open = isOpen(sc.executor);
    const recorded = s?.scenarios?.find((x) => x.id === sc.id)?.series;
    if (recorded?.length) return recorded.map((p) => ({ t: p.t_s, v: open ? p.iterations : p.vus }));
    const ticks = live?.scen[sc.id];
    if (!s && ticks?.length) return ticks.map((p, i) => ({ t: p.t, v: open ? p.iterations - (ticks[i - 1]?.iterations ?? 0) : p.vus }));
    // Runs recorded before per-scenario series: a single scenario's load is the whole run's.
    if (sc === one && s) return series.map((p) => ({ t: p.t, v: open ? (s.series.find((x) => x.t_s === p.t)?.iterations ?? 0) : p.vus }));
    return undefined;
  };
  const now = !s && series.length ? series[series.length - 1]!.t : undefined;
  // Requests/s and iterations/s are the same number only when every iteration is one request.
  const oneRequestPerIteration = enabled.every((sc) => sc.kind === "mix" || (sc.init.length === 0 && sc.steps.flatMap(itemSteps).length === 1));
  const warnings = s?.warnings ?? snap?.warnings ?? [];
  const total = s?.totals.total ?? snap?.total ?? 0;
  const failed = s?.totals.failed ?? snap?.failed ?? 0;
  const top = useMemo(() => {
    const eps = s?.endpoints?.filter((e) => e.phase === "main" && e.totals.total > 0) ?? [];
    return [...eps].sort((a, b) => b.latency.p99 - a.latency.p99)[0] ?? null;
  }, [s]);
  return (
    <div className="space-y-3">
      {s?.error && (
        <p className="flex gap-2 rounded-xl bg-danger-soft px-4 py-3 text-body text-danger">
          <Icon name="alert" className="mt-px size-4" /> {s.error}
        </p>
      )}
      <Verdict verdict={verdict} thresholds={config.thresholds} aborted={s?.aborted_by} />
      <WarningGroups warnings={warnings} />
      <div className="grid grid-cols-[2fr_3fr] gap-3">
        <Outcomes total={total} ok={s?.totals.ok ?? snap?.ok ?? 0} failed={failed} cancelled={s?.totals.cancelled ?? snap?.cancelled ?? 0} o={s?.outcomes ?? snap?.outcomes ?? null} />
        <div className="card grid grid-cols-4 divide-x divide-line">
          {[
            [s ? "Achieved RPS" : "Current RPS", fmtRps(s ? s.achieved_rps : (snap?.rps_interval ?? 0)), s ? null : snap?.target_rps != null && oneRequestPerIteration ? `target ${fmtRps(snap.target_rps)}` : null],
            ["Error rate", total ? fmtPct(failed, total) : "–", null],
            ["p95", fmtLatency(lat?.p95), capped ? "from scheduled start" : null],
            ["p99", fmtLatency(lat?.p99), lat ? `${fmtInt(lat.count)} samples` : null],
          ].map(([k, v, sub]) => (
            <div key={k} className="px-4 py-3">
              <div className="text-small text-text3">{k}</div>
              <div className={`tabular mt-1 font-mono text-display font-medium ${k === "Error rate" && failed ? "text-danger" : ""}`}>{v}</div>
              {sub && <div className="tabular mt-0.5 font-mono text-micro text-text4">{sub}</div>}
            </div>
          ))}
        </div>
      </div>
      {top && (
        <button type="button" onClick={() => onEndpoint(top.step_id)} className="card flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised">
          <Icon name="alert" className="size-4 text-text3" />
          <span className="text-body text-text2">
            Slowest endpoint: <span className="font-medium text-text">{top.name}</span>, p99 <span className="font-mono">{fmtLatency(top.latency.p99)}</span>
            {top.totals.failed > 0 && <>, {fmtPct(top.totals.failed, top.totals.total)} errors</>}
          </span>
          <Icon name="chevronRight" className="ml-auto size-4 text-text4" />
        </button>
      )}
      <div className="card p-4">
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="text-small font-medium text-text3">Load: planned and achieved</h3>
          {snap && !s && <span className="tabular font-mono text-micro text-text4">{fmtInt(snap.active_workers)} VUs · {fmtInt(snap.in_flight)} in flight</span>}
        </div>
        {one ? (
          <ProfileChart executor={one.executor} offset={one.start_offset_secs} achieved={achievedFor(one)} now={now} label={`${one.name}: planned vs achieved`} height={200} />
        ) : (
          <div className="space-y-3 pt-2">
            {enabled.map((sc, i) => {
              const live1 = snap?.scenarios.find((x) => x.id === sc.id);
              const sum = s?.scenarios?.find((x) => x.id === sc.id);
              return (
                <div key={sc.id}>
                  <div className="flex items-center gap-2 text-small">
                    <span className={`size-2 rounded-full ${["bg-series1", "bg-series2", "bg-series3"][i % 3]}`} />
                    <span className="font-medium">{sc.name}</span>
                    <span className="tabular font-mono text-text3">
                      {sum ? `${fmtInt(sum.iterations)} iterations · peak ${fmtInt(sum.peak_vus)} VUs${sum.dropped ? ` · ${fmtInt(sum.dropped)} dropped` : ""}` : live1 ? `${fmtInt(live1.vus)} busy · ${fmtInt(live1.iterations)} iterations · target ${live1.target === null ? "–" : fmtLevel(sc.executor, live1.target * rateUnitSecs(sc.executor))}` : ""}
                    </span>
                  </div>
                  <ProfileChart executor={sc.executor} offset={sc.start_offset_secs} timeMax={Math.max(...enabled.map((x) => span(x)[1]))} achieved={achievedFor(sc)} now={now} height={130} label={`${sc.name}: planned vs achieved`} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <SeriesChart
        title="Throughput (requests / s)"
        data={series}
        lines={[{ key: "rps", name: "Achieved", color: SERIES[0] }, ...(series.some((p) => p.target !== null) ? [{ key: "target" as const, name: "Target iter/s", color: "var(--text4)", dashed: true }] : [])]}
        markers={markers}
        warmup={config.warmup_secs}
        unit="rps"
      />
      <SeriesChart
        title={capped ? "Latency from scheduled start (corrected), ms" : "Latency, ms"}
        data={series}
        lines={[
          { key: "p50", name: "p50", color: SERIES[0] },
          { key: "p95", name: "p95", color: SERIES[1] },
          { key: "p99", name: "p99", color: SERIES[2] },
        ]}
        markers={markers}
        warmup={config.warmup_secs}
        unit="ms"
        slot={1}
      />
      {capped && <SeriesChart title="Service time (raw), ms" data={series} lines={[{ key: "rawP50", name: "p50", color: SERIES[0] }, { key: "rawP99", name: "p99", color: SERIES[2] }]} markers={[]} warmup={0} unit="ms" slot={2} />}
      {s && (
        <p className="text-small text-text4">
          {fmtBytes(s.bytes)} received · {s.outcomes ? `${fmtInt(s.outcomes.iterations)} iterations` : ""} · {s.samples ? `${fmtInt(s.samples.count)} requests kept as samples${s.samples.truncated ? " (a cap was reached)" : ""}` : ""}
        </p>
      )}
    </div>
  );
}

function ConfigView({ run: s }: { run: RunSummary }) {
  const env = s.env;
  const steps = allSteps(s.config);
  return (
    <div className="space-y-3">
      <div className="card grid grid-cols-4 divide-x divide-line">
        {[
          ["Environment", env?.environment || "none"],
          ["Toad", env ? `${env.toad_version} · ${env.os} · ${env.cores} cores` : "–"],
          ["Proxy", env?.proxied ? "yes (latency includes the hop)" : "no"],
          ["Steps", `${steps.length} in ${s.config.scenarios.filter((x) => x.enabled).length} scenario(s)`],
        ].map(([k, v]) => (
          <div key={k} className="px-4 py-3">
            <div className="text-small text-text3">{k}</div>
            <div className="mt-0.5 text-body text-text">{v}</div>
          </div>
        ))}
      </div>
      {env?.data_files && env.data_files.length > 0 && (
        <div className="card p-4">
          <h3 className="mb-2 text-small font-medium text-text3">Data files</h3>
          <ul className="space-y-1 font-mono text-small">
            {env.data_files.map((d) => (
              <li key={d.name}>
                {d.name} · {fmtInt(d.rows)} rows · <span className="text-text4">fnv {d.hash}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="card p-4">
        <h3 className="mb-2 flex items-center justify-between text-small font-medium text-text3">
          The test as it ran
          <span className="text-micro text-text4">secrets redacted unless Settings keep them</span>
        </h3>
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-raised p-3 font-mono text-small leading-[18px] text-text2 select-text">{JSON.stringify(s.config, null, 2)}</pre>
      </div>
      <p className="text-small text-text4">
        <Kbd>{mod}.</Kbd> stops a run; exports omit secrets unless Settings say otherwise.
      </p>
    </div>
  );
}

