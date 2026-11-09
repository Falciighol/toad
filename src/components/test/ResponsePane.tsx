import type { ReactNode } from "react";
import type { Sample } from "../../bindings";
import { fmtLatency } from "../../lib/format";
import { OUTCOME, SampleView, statusTone } from "../run/SampleView";
import { Icon, Kbd, Spinner, type Tone } from "../ui";

/** The latest real response for a step, from Send once or from Try once. */
export type LastResponse = { sample: Sample; at: number; source: "send" | "try" };

export type BottomTab = "request" | "response";

const TONE_TEXT: Record<Tone, string> = { neutral: "text-text3", accent: "text-accent-ink", success: "text-success", info: "text-info", warning: "text-warning", danger: "text-danger" };
const mod = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";

/** "Resolved request | Response" switch for the pane under the step editor. */
export function BottomTabs({ value, onChange, last, busy }: { value: BottomTab; onChange: (t: BottomTab) => void; last: LastResponse | null; busy: boolean }) {
  const s = last?.sample;
  const badge = busy ? (
    <Spinner className="size-3 text-text3" />
  ) : s ? (
    <span className={`tabular font-mono text-micro ${TONE_TEXT[s.response ? statusTone(s.response.status) : OUTCOME[s.outcome].tone]}`}>{s.response ? s.response.status : OUTCOME[s.outcome].label}</span>
  ) : null;
  const tab = (t: BottomTab, label: string, extra?: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={value === t}
      onClick={() => onChange(t)}
      className={`-mb-px flex h-9 items-center gap-1.5 border-b-2 text-small font-medium whitespace-nowrap transition-colors ${value === t ? "border-accent text-text" : "border-transparent text-text3 hover:text-text"}`}
    >
      {label}
      {extra}
    </button>
  );
  return (
    <div role="tablist" aria-label="Request and response" className="flex items-center gap-4">
      {tab("request", "Resolved request")}
      {tab("response", "Response", badge)}
    </div>
  );
}

function when(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** The real request/response from the last Send once or Try once of this step. */
export function ResponsePane({ last, busy, busyLabel, title, stepName }: { last: LastResponse | null; busy: boolean; busyLabel: string; title: ReactNode; stepName: (id: string) => string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-20 pl-4">
        {title}
        <span className="flex-1" />
        {busy ? (
          <span className="flex items-center gap-1.5 text-micro text-text3" role="status">
            <Spinner className="size-3" /> {busyLabel}
          </span>
        ) : last ? (
          <span className="text-micro text-text4" role="status">
            {last.source === "send" ? "Send once" : "Try once"} · {when(last.at)} · {fmtLatency(last.sample.latency_us)}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {last ? (
          <div key={last.at} className={`animate-arrive transition-opacity ${busy ? "opacity-50" : ""}`}>
            <SampleView sample={last.sample} stepName={stepName} />
          </div>
        ) : busy ? (
          <div className="flex h-full items-center justify-center gap-2 text-small text-text3">
            <Spinner /> {busyLabel}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-small text-text3">
            <Icon name="bolt" className="size-5 text-text4" />
            <p>No response yet.</p>
            <p className="text-micro text-text4">
              Send once (<Kbd>{mod}⇧S</Kbd>) sends just this request. Try once (<Kbd>{mod}⇧Enter</Kbd>) runs the whole flow.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
