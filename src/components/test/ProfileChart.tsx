import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Executor } from "../../bindings";
import { fmtInt, fmtSecs } from "../../lib/format";
import { duration, points, unit, unitLong, type Pt } from "../../lib/profile";

const PAD = { l: 44, r: 14, t: 14, b: 26 };

/** The smallest 1/2/2.5/5 × 10ⁿ step that covers `raw`. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** Axis labels fit the gutter: per-hour rates reach six digits, so 10,000+ reads "10k". */
const fmtTick = (v: number) => (v >= 10_000 ? `${Number((v / 1000).toFixed(1))}k` : fmtInt(v));

/** Value axis: about four round steps above the data (plus headroom), starting at 0. */
function valueAxis(v: number): { max: number; ticks: number[] } {
  const top = Math.max(v, 1) * 1.08;
  const step = Math.max(1, niceStep(top / 4));
  const max = Math.ceil(top / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}

/** Time axis: whole-second steps a person would pick (1, 2, 5, 10, 15, 30 s, 1, 2, 5, 10 min…). */
function timeTicks(tMax: number, n: number): number[] {
  const raw = tMax / Math.max(1, n);
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => s >= raw) ?? Math.ceil(raw / 3600) * 3600;
  return Array.from({ length: Math.floor(tMax / step) + 1 }, (_, i) => i * step);
}

/** Apply a dragged point back onto the executor. `i` indexes `points(e)`. */
function movePoint(e: Executor, i: number, t: number, v: number): Executor {
  const val = Math.max(0, Math.round(v));
  switch (e.kind) {
    case "vus":
      return i === 0 ? { ...e, vus: Math.max(1, val) } : { ...e, vus: Math.max(1, val), duration_secs: Math.max(1, Math.round(t)) };
    case "rate":
      return i === 0 ? { ...e, rate: Math.max(1, val) } : { ...e, rate: Math.max(1, val), duration_secs: Math.max(1, Math.round(t)) };
    case "iterations":
      return i === 0 ? { ...e, vus: Math.max(1, val) } : { ...e, vus: Math.max(1, val), max_duration_secs: Math.max(1, Math.round(t)) };
    case "ramping_vus":
    case "ramping_rate": {
      if (i === 0) return { ...e, start: val };
      const pts = points(e);
      const prevT = pts[i - 1]!.t;
      const stages = e.stages.map((s, j) => {
        if (j === i - 1) return { duration_secs: Math.max(1, Math.round(t - prevT)), target: val };
        // Moving a corner in time shifts only its own stage; the next stage keeps its end.
        if (j === i) {
          const end = pts[i + 1]!.t;
          return { ...s, duration_secs: Math.max(1, Math.round(end - Math.max(prevT + 1, Math.round(t)))) };
        }
        return s;
      });
      return { ...e, stages };
    }
  }
}

export type Series = { label: string; points: Pt[]; className: string; dashed?: boolean };

/**
 * The load profile on a time axis. Editable: drag the corners (or focus one and use the
 * arrow keys; Shift moves 10×). Read-only with `achieved`: the plan dashed, the run solid.
 */
export function ProfileChart(props: {
  executor: Executor;
  onChange?: (e: Executor) => void;
  offset?: number;
  timeMax?: number;
  achieved?: Pt[];
  /** Live runs: where the run is now, in the same time base as the plan. */
  now?: number;
  height?: number;
  label: string;
  colorClass?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [drag, setDrag] = useState<number | null>(null);
  const h = props.height ?? 220;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const e = props.executor;
  const offset = props.offset ?? 0;
  const pts = points(e).map((p) => ({ t: p.t + offset, v: p.v }));
  const tMax = Math.max(props.timeMax ?? 0, duration(e) + offset, ...(props.achieved ?? []).map((p) => p.t), 1);
  const vAxis = valueAxis(Math.max(...pts.map((p) => p.v), ...(props.achieved ?? []).map((p) => p.v), 1));
  const vMax = vAxis.max;
  const x = (t: number) => PAD.l + (t / tMax) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / vMax) * (h - PAD.t - PAD.b);
  const inv = (px: number, py: number) => ({ t: ((px - PAD.l) / (w - PAD.l - PAD.r)) * tMax - offset, v: (1 - (py - PAD.t) / (h - PAD.t - PAD.b)) * vMax });
  const path = (ps: Pt[]) => ps.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${path(pts)} L${x(pts[pts.length - 1]!.t)},${y(0)} L${x(pts[0]!.t)},${y(0)} Z`;
  const u = unit(e);
  const editable = !!props.onChange;
  const color = props.colorClass ?? "text-accent";

  const onDown = (i: number) => (ev: PointerEvent<SVGCircleElement>) => {
    if (!editable) return;
    (ev.target as Element).setPointerCapture(ev.pointerId);
    setDrag(i);
  };
  const onMove = (ev: PointerEvent<SVGSVGElement>) => {
    if (drag === null || !props.onChange) return;
    const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    const p = inv(ev.clientX - r.left, ev.clientY - r.top);
    props.onChange(movePoint(e, drag, p.t, p.v));
  };
  const onKey = (i: number) => (ev: KeyboardEvent<SVGCircleElement>) => {
    if (!props.onChange) return;
    const step = ev.shiftKey ? 10 : 1;
    const raw = points(e)[i]!;
    let { t, v } = raw;
    if (ev.key === "ArrowUp") v += step;
    else if (ev.key === "ArrowDown") v -= step;
    else if (ev.key === "ArrowRight" && i > 0) t += step;
    else if (ev.key === "ArrowLeft" && i > 0) t -= step;
    else return;
    ev.preventDefault();
    props.onChange(movePoint(e, i, t, v));
  };

  const xt = useMemo(() => timeTicks(tMax, Math.min(8, Math.max(2, Math.floor(w / 90)))), [tMax, w]);
  return (
    <div ref={box} className="relative w-full select-none">
      <svg width={w} height={h} role="img" aria-label={props.label} onPointerMove={onMove} onPointerUp={() => setDrag(null)} className={color}>
        {vAxis.ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="fill-text4 font-mono text-[11px]">
              {fmtTick(v)}
            </text>
          </g>
        ))}
        {xt.map((t) => (
          <text key={t} x={x(t)} y={h - 8} textAnchor="middle" className="fill-text4 font-mono text-[11px]">
            {fmtSecs(t)}
          </text>
        ))}
        <text x={PAD.l} y={10} className="fill-text3 text-[11px]">
          {unitLong(e)}
        </text>
        <path d={area} fill="currentColor" opacity={props.achieved ? 0.06 : 0.12} />
        <path d={path(pts)} fill="none" stroke="currentColor" strokeWidth={props.achieved ? 1.5 : 2} strokeDasharray={props.achieved ? "5 4" : undefined} strokeLinejoin="round" />
        {props.achieved && props.achieved.length > 1 && <path d={path(props.achieved)} fill="none" stroke="var(--text)" strokeWidth={1.75} strokeLinejoin="round" />}
        {props.now !== undefined && props.now > 0 && props.now < tMax && (
          <g pointerEvents="none">
            <line x1={x(props.now)} x2={x(props.now)} y1={PAD.t} y2={y(0)} stroke="var(--text3)" strokeDasharray="2 3" />
            <text x={x(props.now) + 4} y={PAD.t + 9} className="fill-text3 font-mono text-[10px]">
              now
            </text>
          </g>
        )}
        {editable &&
          pts.map((p, i) => (
            <g key={i}>
              <circle cx={x(p.t)} cy={y(p.v)} r={14} fill="transparent" onPointerDown={onDown(i)} className="cursor-grab" />
              <circle
                cx={x(p.t)}
                cy={y(p.v)}
                r={drag === i ? 6.5 : 5}
                tabIndex={0}
                role="slider"
                aria-label={`${i === 0 ? "Start" : `Stage ${i} end`}: ${fmtInt(p.v)} ${u} at ${fmtSecs(Math.round(p.t - offset))}`}
                aria-valuenow={Math.round(p.v)}
                aria-valuetext={`${fmtInt(p.v)} ${u} at ${fmtSecs(Math.round(p.t - offset))}`}
                onPointerDown={onDown(i)}
                onKeyDown={onKey(i)}
                className="cursor-grab fill-panel stroke-current outline-none focus-visible:stroke-[3px]"
                strokeWidth={2}
              />
            </g>
          ))}
        {drag !== null && pts[drag] && (
          <g pointerEvents="none">
            <rect x={Math.min(x(pts[drag]!.t) + 10, w - 130)} y={Math.max(4, y(pts[drag]!.v) - 34)} width={120} height={24} rx={6} fill="var(--panel)" stroke="var(--line2)" />
            <text x={Math.min(x(pts[drag]!.t) + 18, w - 122)} y={Math.max(4, y(pts[drag]!.v) - 34) + 16} className="fill-text font-mono text-[11px]">
              {fmtInt(pts[drag]!.v)} {u} · {fmtSecs(Math.round(pts[drag]!.t - offset))}
            </text>
          </g>
        )}
      </svg>
      {props.achieved && (
        <div className="absolute top-1 right-3 flex items-center gap-3 text-micro text-text3">
          <span className="flex items-center gap-1.5">
            <svg width="16" height="2" className={color} aria-hidden>
              <line x1="0" x2="16" y1="1" y2="1" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
            </svg>
            planned
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-text" /> achieved
          </span>
        </div>
      )}
      {editable && <p className="sr-only">Focus a point and use the arrow keys to change it; Shift moves 10 at a time.</p>}
    </div>
  );
}
