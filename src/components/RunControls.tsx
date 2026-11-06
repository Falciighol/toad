import type { Phase } from "../bindings";
import { fmtDuration } from "../lib/format";
import { Icon, Kbd, Pill, type Tone } from "./ui";

export type UiPhase = "idle" | "starting" | Phase;

// Status is a tinted pill. A live run is `info`; only a run in progress animates its dot.
const PHASE: Record<UiPhase, { label: string; tone: Tone; live?: boolean }> = {
  idle: { label: "Idle", tone: "neutral" },
  starting: { label: "Starting", tone: "info", live: true },
  ramping: { label: "Ramping", tone: "info", live: true },
  running: { label: "Running", tone: "info", live: true },
  stopping: { label: "Stopping", tone: "warning", live: true },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export const isActive = (p: UiPhase) => p === "starting" || p === "ramping" || p === "running" || p === "stopping";

const mod = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

export function RunControls(props: { phase: UiPhase; elapsedMs: number; progress: number | null; onStart: () => void; onStop: () => void }) {
  const active = isActive(props.phase);
  const p = PHASE[props.phase];
  return (
    <div className="card flex items-center gap-4 p-4">
      {active ? (
        <button type="button" className="btn btn-danger w-28" onClick={props.onStop} disabled={props.phase === "stopping" || props.phase === "starting"} title={`Stop (${mod}+.)`}>
          <Icon name="stop" className="size-3.5" /> {props.phase === "stopping" ? "Stopping…" : "Stop"}
        </button>
      ) : (
        <button type="button" className="btn btn-primary w-28" onClick={props.onStart} title={`Start (${mod}+Enter)`}>
          <Icon name="play" className="size-3.5" /> Start
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between text-small">
          <span role="status" aria-live="polite">
            <Pill tone={p.tone}>
              <span className={`inline-block size-1.5 rounded-full bg-current ${p.live ? "animate-pulse" : ""}`} aria-hidden />
              {p.label}
            </Pill>
          </span>
          <span className="tabular text-text4">
            {props.phase === "idle" ? (
              <>
                <Kbd>{mod}+Enter</Kbd> to start · <Kbd>{mod}+.</Kbd> to stop
              </>
            ) : (
              <span className="font-mono text-text2">{fmtDuration(props.elapsedMs)}</span>
            )}
          </span>
        </div>
        <div
          className="mt-2 h-1 overflow-hidden rounded-full bg-raised2"
          role="progressbar"
          aria-label="Run progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={props.progress === null ? undefined : Math.round(Math.min(1, props.progress) * 100)}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-200 ease-out ${props.phase === "failed" ? "bg-danger-fill" : "bg-accent"}`}
            style={{ width: `${Math.round(Math.min(1, props.progress ?? 0) * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
