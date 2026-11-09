import { memo, useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "../lib/series";
import { fmtRps } from "../lib/format";
import { CardTitle } from "./ui";

// Series are the one place hue carries data, and never in the accent (src/lib/theme.ts): mint marks actions, selection
// and the planned load. The target is a neutral reference line.
export const SERIES = ["var(--series1)", "var(--series2)", "var(--series3)"] as const;

export const axis = { stroke: "var(--text4)", fontSize: 11, fontFamily: "var(--mono)", tickLine: false, axisLine: false } as const;
export const tooltipStyle = {
  contentStyle: { background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 12, boxShadow: "var(--shadow)", fontSize: 12, fontFamily: "var(--mono)", color: "var(--text)" },
  labelStyle: { color: "var(--text3)" },
  cursor: { stroke: "var(--line3)", strokeWidth: 1 },
};
export const legendStyle = { fontSize: 12, color: "var(--text3)" };
export const fmtMs = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/** Axis ticks with one precision for the whole axis, picked from its largest value (no "36.0 / 9.00" mixes). */
export function tickFmt(max: number): (v: number) => string {
  const digits = max >= 20 ? 0 : max >= 2 ? 1 : 2;
  return (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A 0-based axis on round 1/2/2.5/5×10ⁿ steps, with a little headroom above `max`. */
export function niceAxis(max: number, n = 4): { domain: [number, number]; ticks: number[] } {
  const top = Math.max(max, 1e-6) * 1.08;
  const raw = top / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5].find((m) => m * p >= raw) ?? 10) * p;
  const end = Math.ceil(top / step) * step;
  return { domain: [0, end], ticks: Array.from({ length: Math.round(end / step) + 1 }, (_, i) => Number((i * step).toPrecision(12))) };
}

export type LegendItem = { label: string; color: string; dashed?: boolean; thin?: boolean };

/** What each line is. Charts with more than one line always carry one. */
export function ChartLegend({ items, className = "" }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-text3 ${className}`}>
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <svg width="16" height="4" aria-hidden>
            <line x1="0" x2="16" y1="2" y2="2" stroke={it.color} strokeWidth={it.thin ? 1.5 : 2} strokeDasharray={it.dashed ? "4 3" : undefined} />
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * A vertical marker's label. Labels step down in three rows so neighbours (a stage boundary next to a threshold
 * crossing) don't print over each other or over the top tick.
 */
export function markerLabel(text: string, row: number) {
  return function MarkerLabel(props: { viewBox?: { x?: number; y?: number } }) {
    const x = props.viewBox?.x ?? 0;
    const y = (props.viewBox?.y ?? 0) + 10 + (row % 3) * 12;
    return (
      <text x={x + 4} y={y} fontSize={10} fill="var(--text4)" fontFamily="var(--sans)">
        {text}
      </text>
    );
  };
}
const tLabel = (t: unknown) => `t = ${String(t)} s`;

/**
 * Mounting a Recharts chart costs tens of ms. Charts mount one per macrotask
 * (staggered by `slot`) so no single main-thread task exceeds ~50 ms when a
 * dashboard or summary with several charts appears.
 */
export function useStaggeredMount(slot: number, enabled: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!enabled || ready) return;
    const id = setTimeout(() => setReady(true), slot * 32);
    return () => clearTimeout(id);
  }, [enabled, ready, slot]);
  return ready;
}

function Frame(props: { title: string; children: React.ReactElement; empty: boolean; slot: number }) {
  const ready = useStaggeredMount(props.slot, !props.empty);
  return (
    <div className="card p-4">
      <CardTitle className="mb-3">{props.title}</CardTitle>
      <div className="h-44">
        {props.empty || !ready ? (
          <div className="flex h-full items-center justify-center text-small text-text4">{props.empty ? "Waiting for the first full second…" : ""}</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {props.children}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

export const RpsChart = memo(function RpsChart({ data, showTarget, slot = 0 }: { data: ChartPoint[]; showTarget: boolean; slot?: number }) {
  return (
    <Frame title="Throughput (requests / s)" empty={data.length === 0} slot={slot}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => `${t}s`} {...axis} />
        <YAxis {...axis} width={52} tickFormatter={(v: number) => fmtRps(v)} />
        <Tooltip {...tooltipStyle} labelFormatter={tLabel} formatter={(v) => fmtRps(Number(v))} />
        {showTarget && <Legend wrapperStyle={legendStyle} iconType="plainline" />}
        <Line name="Achieved" dataKey="rps" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        {showTarget && (
          <Line name="Target" dataKey="target" stroke="var(--text4)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        )}
      </LineChart>
    </Frame>
  );
});

export const LatencyChart = memo(function LatencyChart({ data, raw, title, slot = 1 }: { data: ChartPoint[]; raw: boolean; title: string; slot?: number }) {
  const keys = raw ? (["rawP50", "rawP95", "rawP99"] as const) : (["p50", "p95", "p99"] as const);
  return (
    <Frame title={title} empty={data.length === 0} slot={slot}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => `${t}s`} {...axis} />
        <YAxis {...axis} width={44} tickFormatter={(v: number) => fmtMs(v)} />
        <Tooltip {...tooltipStyle} labelFormatter={tLabel} formatter={(v) => `${fmtMs(Number(v))} ms`} />
        <Legend wrapperStyle={legendStyle} iconType="plainline" />
        {keys.map((k, i) => (
          <Line key={k} name={["p50", "p95", "p99"][i]} dataKey={k} stroke={SERIES[i]} strokeWidth={2} dot={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </Frame>
  );
});

export type ComparePoint = { t: number; a: number | null; b: number | null };

export const CompareChart = memo(function CompareChart(props: { title: string; data: ComparePoint[]; labelA: string; labelB: string; unit: "rps" | "ms"; slot?: number }) {
  const fmt = (v: number) => (props.unit === "rps" ? fmtRps(v) : `${fmtMs(v)} ms`);
  return (
    <Frame title={props.title} empty={props.data.length === 0} slot={props.slot ?? 0}>
      <LineChart data={props.data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => `${t}s`} {...axis} />
        <YAxis {...axis} width={56} tickFormatter={(v: number) => (props.unit === "rps" ? fmtRps(v) : fmtMs(v))} />
        <Tooltip {...tooltipStyle} labelFormatter={tLabel} formatter={(v) => fmt(Number(v))} />
        <Legend wrapperStyle={legendStyle} iconType="plainline" />
        <Line name={props.labelA} dataKey="a" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        <Line name={props.labelB} dataKey="b" stroke={SERIES[1]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
      </LineChart>
    </Frame>
  );
});
