import type { Phase } from "../bindings";
import { fmtDuration } from "../lib/format";

export type UiPhase = "idle" | "starting" | Phase;

const PHASE: Record<UiPhase, { label: string; dot: string }> = {
  idle: { label: "Idle", dot: "bg-ink-3" },
  starting: { label: "Starting", dot: "bg-warning animate-pulse" },
  ramping: { label: "Ramping", dot: "bg-warning animate-pulse" },
  running: { label: "Running", dot: "bg-good animate-pulse" },
  stopping: { label: "Stopping", dot: "bg-warning animate-pulse" },
  done: { label: "Done", dot: "bg-good" },
  failed: { label: "Failed", dot: "bg-critical" },
};

export const isActive = (p: UiPhase) => p === "starting" || p === "ramping" || p === "running" || p === "stopping";

const mod = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

export function RunControls(props: { phase: UiPhase; elapsedMs: number; progress: number | null; onStart: () => void; onStop: () => void }) {
  const active = isActive(props.phase);
  const p = PHASE[props.phase];
  return (
    <div className="card flex items-center gap-3 p-3">
      {active ? (
        <button type="button" className="btn btn-danger w-28" onClick={props.onStop} disabled={props.phase === "stopping" || props.phase === "starting"} title={`Stop (${mod}+.)`}>
          ■ Stop
        </button>
      ) : (
        <button type="button" className="btn btn-primary w-28" onClick={props.onStart} title={`Start (${mod}+Enter)`}>
          ▶ Start
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 font-medium" role="status" aria-live="polite">
            <span className={`inline-block size-2 rounded-full ${p.dot}`} aria-hidden />
            {p.label}
          </span>
          <span className="tabular text-ink-3">
            {props.phase === "idle" ? `${mod}+Enter to start · ${mod}+. to stop` : fmtDuration(props.elapsedMs)}
          </span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${Math.round(Math.min(1, props.progress ?? 0) * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
