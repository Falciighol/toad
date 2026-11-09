import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EndpointLive, ErrorKind, RunSummary, TestConfig, Threshold, ThresholdResult } from "../../bindings";
import { allSteps, stepLabel } from "../../lib/flow";
import { bars, mergeBuckets } from "../../lib/hist";
import { fmtBytes, fmtDelta, fmtInt, fmtLatency, fmtPct, fmtRps } from "../../lib/format";
import { axis, fmtMs, SERIES, tooltipStyle, useStaggeredMount } from "../Charts";
import { ERROR_LABEL } from "../Breakdowns";
import { Icon, Pill, Segmented } from "../ui";
import { statusTone } from "./SampleView";

export type Row = {
  id: string;
  name: string;
  method: string;
  url: string;
  scenario: string;
  group: string | null;
  phase: string;
  requests: number;
  failed: number;
  rps: number;
  checkFail: number;
  skipped: number;
  notTaken: number;
  blocked: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  ttfb95: number;
  bytes: number;
  spark: number[];
  breached: boolean;
  /** The tightest error-rate bound that applies to this row (%), so values next to it show deciding precision. */
  errBound: number | null;
  why: string | null;
};

type SortKey = "p99" | "p95" | "p50" | "requests" | "rps" | "failed" | "name";

/** Why an endpoint has no requests, in words. */
function neverRan(e: { requests: number; skipped: number; notTaken: number; blocked: number }, upstream: string | null): string | null {
  if (e.requests > 0) return null;
  if (e.blocked) return `0 requests: ${fmtInt(e.blocked)} blocked (host not confirmed)`;
  if (e.skipped) return `0 requests: skipped ×${fmtInt(e.skipped)}${upstream ? ` after ${upstream} failed to extract a value` : " (a value it needs was missing)"}`;
  if (e.notTaken) return `0 requests: its Run if rule was false ×${fmtInt(e.notTaken)}`;
  return "0 requests: never reached";
}

/** A row's own value for a threshold's metric, in the threshold's unit; null when the row can't be judged alone. */
function ownValue(t: Threshold, m: { requests: number; failed: number; p50: number; p95: number; p99: number; max: number }): number | null {
  const ms = (us: number) => (us > 0 ? us / 1000 : null);
  switch (t.metric) {
    case "p50":
      return ms(m.p50);
    case "p95":
      return ms(m.p95);
    case "p99":
      return ms(m.p99);
    case "max":
      return ms(m.max);
    case "error_rate":
      return m.requests ? (m.failed / m.requests) * 100 : null;
    default:
      return null;
  }
}

function holds(v: number, t: Threshold): boolean {
  if (t.value === null) return true;
  return t.op === "lt" ? v < t.value : t.op === "lte" ? v <= t.value : t.op === "gt" ? v > t.value : v >= t.value;
}

/**
 * Whether a failed threshold lights this row. A step threshold lights its step. A scenario or whole-test threshold
 * lights the rows in its scope whose own value breaks the bound, so the board points at the endpoints that did it; a
 * scenario threshold the row can't be judged on alone (check pass rate, RPS, dropped) lights the whole scenario.
 */
function breachedBy(c: TestConfig, verdict: ThresholdResult[], row: { stepId: string; scenarioId: string | null; phase: string; requests: number; failed: number; p50: number; p95: number; p99: number; max: number }): boolean {
  const failed = new Set(verdict.filter((v) => !v.passed && !v.pending).map((v) => v.id));
  return c.thresholds.some((t) => {
    if (!failed.has(t.id)) return false;
    if (t.scope === `step:${row.stepId}`) return true;
    const scenario = row.scenarioId !== null && t.scope === `scenario:${row.scenarioId}`;
    if (!scenario && !(t.scope === "" && row.phase === "main")) return false;
    const own = ownValue(t, row);
    return own === null ? scenario : !holds(own, t);
  });
}

/** The tightest enabled error-rate bound in scope for a row. */
export function errorBound(c: TestConfig, row: { stepId: string; scenarioId: string | null; phase: string }): number | null {
  const vals = c.thresholds
    .filter((t) => t.enabled && t.metric === "error_rate" && t.value !== null)
    .filter((t) => t.scope === `step:${row.stepId}` || (row.scenarioId !== null && t.scope === `scenario:${row.scenarioId}`) || (t.scope === "" && row.phase === "main"))
    .map((t) => t.value!);
  return vals.length ? Math.min(...vals) : null;
}

/** An error rate: one decimal, or two when one decimal would hide which side of `bound` (%) it's on. */
export function errRate(failed: number, total: number, bound: number | null): string {
  if (!total) return "–";
  const p = (failed / total) * 100;
  if (bound !== null && p > 0 && Math.abs(p - bound) < 0.1) return `${p.toFixed(2)}%`;
  return fmtPct(failed, total);
}

const errText = (r: Row) => errRate(r.failed, r.requests, r.errBound);

export function rowsFromSummary(r: RunSummary, verdict: ThresholdResult[], durationS: number): Row[] {
  const steps = allSteps(r.config);
  const scen = (id: string | null | undefined) => r.config.scenarios.find((s) => s.id === id)?.name ?? (id ? id : "");
  return (r.endpoints ?? []).map((e, i, all) => {
    const breach = breachedBy(r.config, verdict, { stepId: e.step_id, scenarioId: e.scenario_id ?? null, phase: e.phase, requests: e.totals.total, failed: e.totals.failed, p50: e.latency.p50, p95: e.latency.p95, p99: e.latency.p99, max: e.latency.max });
    const upstream = all.slice(0, i).reverse().find((x) => x.scenario_id === e.scenario_id && x.outcomes.extract_failures > 0);
    const ref = steps.find((s) => s.step.id === e.step_id);
    const base = { requests: e.totals.total, skipped: e.outcomes.skipped, notTaken: e.outcomes.not_taken, blocked: e.outcomes.blocked };
    return {
      id: e.step_id,
      name: ref ? stepLabel(ref.step) : e.name,
      method: e.method,
      url: e.url,
      scenario: e.phase === "setup" ? "Setup" : e.phase === "teardown" ? "Teardown" : scen(e.scenario_id),
      group: e.group_id ?? null,
      phase: e.phase,
      ...base,
      failed: e.totals.failed,
      rps: durationS > 0 ? e.totals.total / durationS : 0,
      checkFail: e.outcomes.check_failures,
      p50: e.latency.p50,
      p95: e.latency.p95,
      p99: e.latency.p99,
      max: e.latency.max,
      ttfb95: e.ttfb.p95,
      bytes: e.bytes,
      spark: e.series.map((p) => p.p95),
      breached: !!breach,
      errBound: errorBound(r.config, { stepId: e.step_id, scenarioId: e.scenario_id ?? null, phase: e.phase }),
      why: neverRan(base, upstream?.name ?? null),
    };
  });
}

export function rowsFromLive(c: TestConfig, live: EndpointLive[], spark: Map<string, number[]>, thresholds: ThresholdResult[]): Row[] {
  const steps = allSteps(c, true);
  return live.map((e) => {
    const ref = steps.find((s) => s.step.id === e.step_id);
    const breach = breachedBy(c, thresholds, { stepId: e.step_id, scenarioId: ref?.scenario?.id ?? null, phase: ref?.phase ?? "main", requests: e.total, failed: e.failed, p50: 0, p95: e.p95, p99: e.p99_run, max: 0 });
    const base = { requests: e.total, skipped: e.skipped, notTaken: e.not_taken, blocked: 0 };
    return {
      id: e.step_id,
      name: ref ? stepLabel(ref.step) : e.step_id,
      method: ref?.step.method ?? "",
      url: ref?.step.url ?? "",
      scenario: ref?.phase === "setup" ? "Setup" : ref?.phase === "teardown" ? "Teardown" : (ref?.scenario?.name ?? ""),
      group: ref?.groupId ?? null,
      phase: ref?.phase ?? "main",
      ...base,
      failed: e.failed,
      rps: e.rps ?? 0,
      checkFail: 0,
      p50: 0,
      p95: e.p95,
      p99: e.p99_run,
      max: 0,
      ttfb95: 0,
      bytes: 0,
      spark: spark.get(e.step_id) ?? [],
      breached: !!breach,
      errBound: errorBound(c, { stepId: e.step_id, scenarioId: ref?.scenario?.id ?? null, phase: ref?.phase ?? "main" }),
      why: e.total === 0 ? neverRan(base, null) : null,
    };
  });
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-micro text-text4">–</span>;
  const v = values.slice(-60);
  const max = Math.max(...v, 1);
  const pts = v.map((x, i) => `${(i / (v.length - 1)) * 64},${16 - (x / max) * 14}`).join(" ");
  return (
    <svg width="64" height="18" aria-hidden className="text-series1">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Endpoints ranked by p99 (or any column). Rows keep their identity while re-ranking, and a
 * row whose threshold is breached stays lit until it's opened.
 */
export function EndpointBoard({ rows, onOpen, live, groupByUrl, onGroupByUrl }: { rows: Row[]; onOpen: (id: string) => void; live: boolean; groupByUrl: boolean; onGroupByUrl: (v: boolean) => void }) {
  const [sort, setSort] = useState<SortKey>("p99");
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const body = useRef<HTMLTableSectionElement>(null);
  const prev = useRef(new Map<string, number>());
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const data = useMemo(() => {
    let list = rows;
    if (groupByUrl) {
      const by = new Map<string, Row>();
      for (const r of rows) {
        const k = `${r.method} ${r.url}`;
        const x = by.get(k);
        if (!x) by.set(k, { ...r, id: `url:${k}`, name: k });
        else by.set(k, { ...x, requests: x.requests + r.requests, failed: x.failed + r.failed, rps: x.rps + r.rps, p95: Math.max(x.p95, r.p95), p99: Math.max(x.p99, r.p99), p50: Math.max(x.p50, r.p50), max: Math.max(x.max, r.max), breached: x.breached || r.breached, why: null });
      }
      list = [...by.values()];
    }
    const val = (r: Row) => (sort === "name" ? 0 : sort === "failed" ? (r.requests ? r.failed / r.requests : 0) : r[sort]);
    return [...list].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : val(b) - val(a) || a.name.localeCompare(b.name)));
  }, [rows, sort, groupByUrl]);

  // FLIP: rows slide to their new rank instead of jumping.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const next = new Map<string, number>();
    for (const tr of el.querySelectorAll<HTMLTableRowElement>("tr[data-row]")) {
      const id = tr.dataset.row!;
      const top = tr.offsetTop;
      next.set(id, top);
      const before = prev.current.get(id);
      if (before !== undefined && before !== top && !reduce) {
        tr.animate([{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }], { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      }
    }
    prev.current = next;
  }, [data, reduce]);

  const head = (k: SortKey, label: string, right = true) => (
    <th className={`px-2 py-2 font-medium whitespace-nowrap ${right ? "text-right" : "text-left"}`} aria-sort={sort === k ? "descending" : undefined}>
      <button type="button" className={`inline-flex items-center gap-1 ${sort === k ? "text-text" : "hover:text-text2"}`} onClick={() => setSort(k)}>
        {label}
        {sort === k && <Icon name="arrowDown" className="size-3" />}
      </button>
    </th>
  );

  let lastScenario = "";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-small text-text3">{live ? "Live: p95 over the last interval, p99 over the run so far." : "Whole run. Latency is from the scheduled start on open-model scenarios."}</p>
        <Segmented
          size="sm"
          aria-label="Rows"
          value={groupByUrl ? "url" : "step"}
          onChange={(v) => onGroupByUrl(v === "url")}
          options={[
            { value: "step", label: "By step" },
            { value: "url", label: "By URL template" },
          ]}
        />
      </div>
      <div className="card overflow-x-auto">
        <table className="tabular w-full text-body">
          <thead>
            <tr className="border-b border-line text-small text-text3">
              {head("name", "Endpoint", false)}
              {head("requests", "Requests")}
              {head("rps", "RPS")}
              {head("failed", "Errors")}
              {head("p50", "p50")}
              {head("p95", "p95")}
              {head("p99", "p99")}
              <th className="px-2 py-2 text-right font-medium">p95 trend</th>
            </tr>
          </thead>
          <tbody ref={body}>
            {data.map((r) => {
              const lit = r.breached && !seen.has(r.id);
              const showScenario = !groupByUrl && sort === "name" && r.scenario !== lastScenario;
              lastScenario = r.scenario;
              return [
                showScenario ? (
                  <tr key={`h-${r.scenario}`}>
                    <td colSpan={8} className="px-3 pt-3 pb-1 text-micro font-semibold tracking-wide text-text3 uppercase">{r.scenario}</td>
                  </tr>
                ) : null,
                <tr
                  key={r.id}
                  data-row={r.id}
                  onClick={() => {
                    setSeen((s) => new Set(s).add(r.id));
                    if (!groupByUrl) onOpen(r.id);
                  }}
                  className={`relative cursor-default border-b border-line transition-colors last:border-0 ${lit ? "bg-danger-soft" : "hover:bg-raised"}`}
                >
                  <td className={`relative max-w-0 min-w-56 py-2 pr-2 ${r.group && !groupByUrl ? "pl-7" : "pl-3"}`}>
                    {lit && <span className="absolute top-[15px] left-1 size-1.5 rounded-full bg-danger-fill" role="img" aria-label="threshold breached" />}
                    <div className="flex items-center gap-2">
                      <span className="w-12 shrink-0 font-mono text-micro font-semibold text-text3">{r.method}</span>
                      <span className="truncate font-medium text-text">{r.name.replace(new RegExp(`^${r.method} `), "")}</span>
                      {r.phase !== "main" && <Pill tone="neutral">{r.phase}</Pill>}
                    </div>
                    {r.why ? <div className="truncate pl-14 text-small text-warning">{r.why}</div> : sort !== "name" && !groupByUrl && r.scenario && <div className="truncate pl-14 text-micro text-text4">{r.scenario}</div>}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-small">{fmtInt(r.requests)}</td>
                  <td className="px-2 py-2 text-right font-mono text-small">{fmtRps(r.rps)}</td>
                  <td className={`px-2 py-2 text-right font-mono text-small ${r.failed ? "text-danger" : "text-text3"}`}>{errText(r)}</td>
                  <td className="px-2 py-2 text-right font-mono text-small text-text2">{r.p50 ? fmtLatency(r.p50) : "–"}</td>
                  <td className="px-2 py-2 text-right font-mono text-small text-text2">{r.p95 ? fmtLatency(r.p95) : "–"}</td>
                  <td className="px-2 py-2 text-right font-mono text-small font-medium text-text">{r.p99 ? fmtLatency(r.p99) : "–"}</td>
                  <td className="py-2 pr-3 pl-2 text-right">
                    <Spark values={r.spark} />
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Panel({ title, children, note, slot = 0 }: { title: string; children: React.ReactElement; note?: string; slot?: number }) {
  const ready = useStaggeredMount(slot, true);
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-small font-medium text-text3">{title}</h3>
        {note && <span className="text-micro text-text4">{note}</span>}
      </div>
      <div className="h-44">{ready && <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>}</div>
    </div>
  );
}

/** Everything measured for one endpoint. */
export function EndpointDetail({ run, stepId, previous, onBack, onSamples, warmup }: { run: RunSummary; stepId: string; previous: RunSummary | null; onBack: () => void; onSamples: (stepId: string) => void; warmup: number }) {
  const e = run.endpoints?.find((x) => x.step_id === stepId);
  const ref = allSteps(run.config).find((s) => s.step.id === stepId);
  const series = useMemo(() => (e?.series ?? []).map((p) => ({ t: p.t_s, p50: p.p50 / 1000, p95: p.p95 / 1000, p99: p.p99 / 1000, ok: p.ok, failed: p.failed })), [e]);
  const dist = useMemo(() => bars(mergeBuckets(e?.series ?? [])).map((b) => ({ label: fmtLatency(b.hi), hi: b.hi / 1000, count: b.count })), [e]);
  const spectrum = useMemo(() => (e?.spectrum ?? []).map((s) => ({ q: s.q ?? 0, label: `p${Number(((s.q ?? 0) * 100).toFixed(3))}`, ms: s.us / 1000 })), [e]);
  if (!e) return <p className="text-body text-text3">This endpoint has no data in this run.</p>;
  const prev = previous?.endpoints?.find((x) => x.step_id === stepId) ?? null;
  const t = e.totals;
  const rule = (id: string) => ref?.step.checks.find((c) => c.id === id) ?? null;
  const ex = (id: string) => ref?.step.extract.find((c) => c.id === id) ?? null;
  const download = { p50: Math.max(0, e.latency_raw.p50 - e.ttfb.p50), p95: Math.max(0, e.latency_raw.p95 - e.ttfb.p95) };
  const delta = (a: number, b: number, fmt: (n: number) => string, lowerBetter = true) => {
    if (!prev) return null;
    const better = lowerBetter ? b < a : b > a;
    return <span className={`font-mono text-micro ${a === b ? "text-text4" : better ? "text-success" : "text-danger"}`}>{fmtDelta(a, b, fmt)}</span>;
  };
  const prevErr = prev && prev.totals.total ? (prev.totals.failed / prev.totals.total) * 100 : 0;
  const err = t.total ? (t.failed / t.total) * 100 : 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" className="mb-1 flex items-center gap-1 text-small text-text3 hover:text-text" onClick={onBack}>
            <Icon name="back" className="size-3" /> All endpoints
          </button>
          <h2 className="text-title font-semibold">{ref ? stepLabel(ref.step) : e.name}</h2>
          <p className="mt-0.5 truncate font-mono text-small text-text2 select-text">
            {e.method} {e.url}
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => onSamples(stepId)}>
          <Icon name="list" className="size-3.5" /> Samples for this endpoint
        </button>
      </div>
      <div className="card grid grid-cols-6 divide-x divide-line">
        {[
          ["Requests", fmtInt(t.total), delta(prev?.totals.total ?? 0, t.total, fmtInt, false)],
          ["Errors", fmtPct(t.failed, t.total), prev ? delta(prevErr, err, (n) => `${n.toFixed(2)}%`) : null],
          ["p50", fmtLatency(e.latency.p50), delta(prev?.latency.p50 ?? 0, e.latency.p50, fmtLatency)],
          ["p95", fmtLatency(e.latency.p95), delta(prev?.latency.p95 ?? 0, e.latency.p95, fmtLatency)],
          ["p99", fmtLatency(e.latency.p99), delta(prev?.latency.p99 ?? 0, e.latency.p99, fmtLatency)],
          ["Received", fmtBytes(e.bytes), null],
        ].map(([k, v, d], i) => (
          <div key={i} className="px-4 py-3">
            <div className="text-small text-text3">{k}</div>
            <div className="tabular mt-0.5 font-mono text-title font-medium">{v}</div>
            {d && <div className="mt-0.5">{d}</div>}
          </div>
        ))}
      </div>
      {prev && <p className="text-micro text-text4">Deltas against the previous run of this test ({new Date(previous!.started_at).toLocaleString()}).</p>}
      <div className="grid grid-cols-2 gap-3">
        <Panel title="Latency over time, ms" note={run.capped ? "from scheduled start" : undefined}>
          <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {warmup > 0 && <ReferenceArea x1={0} x2={warmup} fill="var(--raised2)" ifOverflow="hidden" />}
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => `${v}s`} {...axis} />
            <YAxis {...axis} width={44} tickFormatter={fmtMs} />
            <Tooltip {...tooltipStyle} labelFormatter={(v) => `t = ${String(v)} s`} formatter={(v) => `${fmtMs(Number(v))} ms`} />
            {(["p50", "p95", "p99"] as const).map((k, i) => (
              <Line key={k} dataKey={k} name={k} stroke={SERIES[i]} strokeWidth={2} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </Panel>
        <Panel title="OK and failed per second" slot={1}>
          <BarChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => `${v}s`} {...axis} />
            <YAxis {...axis} width={44} tickFormatter={(v: number) => fmtInt(v)} />
            <Tooltip {...tooltipStyle} labelFormatter={(v) => `t = ${String(v)} s`} />
            <Bar dataKey="ok" name="OK" stackId="a" fill="var(--success)" isAnimationActive={false} />
            <Bar dataKey="failed" name="Failed" stackId="a" fill="var(--danger-fill)" isAnimationActive={false} />
          </BarChart>
        </Panel>
        <Panel title="Distribution" note="log buckets, ±15%" slot={2}>
          <BarChart data={dist} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={24} />
            <YAxis {...axis} width={44} tickFormatter={(v: number) => fmtInt(v)} />
            <Tooltip {...tooltipStyle} formatter={(v) => [fmtInt(Number(v)), "requests"]} labelFormatter={(l) => `up to ${String(l)}`} />
            <Bar dataKey="count" fill="var(--series1)" isAnimationActive={false} />
          </BarChart>
        </Panel>
        <Panel title="Percentile spectrum, ms" note={`${fmtInt(e.latency.count)} samples`} slot={3}>
          <LineChart data={spectrum} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={18} />
            <YAxis {...axis} width={44} tickFormatter={fmtMs} scale="log" domain={["auto", "auto"]} allowDataOverflow />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmtMs(Number(v))} ms`} />
            <Line dataKey="ms" stroke="var(--series1)" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
          </LineChart>
        </Panel>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="card p-4">
          <h3 className="mb-2 text-small font-medium text-text3">Where the time goes</h3>
          <dl className="space-y-1.5 text-small">
            <div className="flex justify-between"><dt className="text-text2">Waiting for the first byte</dt><dd className="font-mono">p50 {fmtLatency(e.ttfb.p50)} · p95 {fmtLatency(e.ttfb.p95)}</dd></div>
            <div className="flex justify-between"><dt className="text-text2">Downloading the body</dt><dd className="font-mono">p50 {fmtLatency(download.p50)} · p95 {fmtLatency(download.p95)}</dd></div>
            {run.capped && e.latency.p95 > e.latency_raw.p95 && <div className="flex justify-between"><dt className="text-text2">Waiting to start (queue)</dt><dd className="font-mono">p95 {fmtLatency(Math.max(0, e.latency.p95 - e.latency_raw.p95))}</dd></div>}
          </dl>
          <p className="mt-2 text-micro text-text4">DNS, connect and TLS time aren't measured separately; they're inside the first byte.</p>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-small font-medium text-text3">Status codes</h3>
          {t.status_counts.length === 0 ? (
            <p className="text-small text-text4">No responses.</p>
          ) : (
            <ul className="space-y-1">
              {[...t.status_counts].sort((a, b) => b.count - a.count).map((s) => (
                <li key={s.code} className="flex items-center justify-between text-small">
                  <Pill tone={statusTone(s.code)}>{s.code}</Pill>
                  <span className="font-mono text-text2">{fmtInt(s.count)} · {fmtPct(s.count, t.total)}</span>
                </li>
              ))}
            </ul>
          )}
          {t.error_counts.filter((x) => x.kind !== "status").map((x) => (
            <div key={x.kind} className="mt-1 flex justify-between text-small">
              <span className="text-danger">{ERROR_LABEL[x.kind as ErrorKind]}</span>
              <span className="font-mono text-text2">{fmtInt(x.count)}</span>
            </div>
          ))}
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-small font-medium text-text3">Checks and extraction</h3>
          {e.check_failures.length === 0 && e.extract_failures.length === 0 ? (
            <p className="text-small text-text4">{ref?.step.checks.length || ref?.step.extract.length ? "Every rule held." : "No rules on this step."}</p>
          ) : (
            <ul className="space-y-1 text-small">
              {e.check_failures.map((r) => (
                <li key={r.id} className="flex justify-between gap-2">
                  <span className="truncate font-mono text-text2">{rule(r.id) ? `${rule(r.id)!.kind} ${rule(r.id)!.expr} ${rule(r.id)!.op} ${rule(r.id)!.value}` : r.id}</span>
                  <span className="flex items-center gap-1 font-mono text-danger">
                    <Icon name="x" className="size-3" />
                    {fmtInt(r.count)}
                  </span>
                </li>
              ))}
              {e.extract_failures.map((r) => (
                <li key={r.id} className="flex justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1 truncate font-mono text-text2">
                    <Icon name="arrowRight" className="size-3 shrink-0 text-text4" />
                    {ex(r.id)?.var ?? r.id} not found
                  </span>
                  <span className="flex items-center gap-1 font-mono text-danger">
                    <Icon name="x" className="size-3" />
                    {fmtInt(r.count)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(e.outcomes.skipped > 0 || e.outcomes.not_taken > 0 || e.outcomes.blocked > 0) && (
            <p className="mt-2 text-small text-text3">
              {e.outcomes.skipped > 0 && <>Skipped {fmtInt(e.outcomes.skipped)} · </>}
              {e.outcomes.not_taken > 0 && <>Not taken {fmtInt(e.outcomes.not_taken)} · </>}
              {e.outcomes.blocked > 0 && <>Blocked {fmtInt(e.outcomes.blocked)}</>}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

