import { memo, useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartPoint } from "../lib/series";
import { fmtRps } from "../lib/format";

// Validated categorical slots (blue, orange, aqua) + a neutral reference line.
export const SERIES = ["var(--c-series-1)", "var(--c-series-2)", "var(--c-series-3)"] as const;

const axis = { stroke: "var(--c-text-3)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tooltipStyle = {
  contentStyle: { background: "var(--c-surface)", border: "1px solid var(--c-border)", borderRadius: 6, fontSize: 12, color: "var(--c-text)" },
  labelStyle: { color: "var(--c-text-2)" },
  cursor: { stroke: "var(--c-text-3)", strokeWidth: 1 },
};
const legendStyle = { fontSize: 11, color: "var(--c-text-2)" };
const fmtMs = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const tLabel = (t: unknown) => `t = ${String(t)} s`;

/**
 * Mounting a Recharts chart costs tens of ms. Charts mount one per macrotask
 * (staggered by `slot`) so no single main-thread task exceeds ~50 ms when a
 * dashboard or summary with several charts appears.
 */
function useStaggeredMount(slot: number, enabled: boolean): boolean {
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
    <div className="card p-3">
      <h3 className="mb-2 text-xs font-semibold text-ink-2">{props.title}</h3>
      <div className="h-44">
        {props.empty || !ready ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-3">{props.empty ? "Waiting for the first full second…" : ""}</div>
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
        <CartesianGrid stroke="var(--c-grid)" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => `${t}s`} {...axis} />
        <YAxis {...axis} width={52} tickFormatter={(v: number) => fmtRps(v)} />
        <Tooltip {...tooltipStyle} labelFormatter={tLabel} formatter={(v) => fmtRps(Number(v))} />
        {showTarget && <Legend wrapperStyle={legendStyle} iconType="plainline" />}
        <Line name="Achieved" dataKey="rps" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        {showTarget && (
          <Line name="Target" dataKey="target" stroke="var(--c-ref)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
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
        <CartesianGrid stroke="var(--c-grid)" vertical={false} />
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
        <CartesianGrid stroke="var(--c-grid)" vertical={false} />
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
