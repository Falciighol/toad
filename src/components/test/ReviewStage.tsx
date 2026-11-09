import { useState } from "react";
import type { HostInfo, Sample, TestConfig, TryResult } from "../../bindings";
import { estimateTest } from "../../lib/estimate";
import { findStep, stepLabel } from "../../lib/flow";
import { fmtInt, fmtLatency, fmtPerTime, fmtSecs } from "../../lib/format";
import { STAGE_LABEL, stageOf, type Errors, type Stage } from "../../lib/stages";
import { OUTCOME, SampleView, statusTone } from "../run/SampleView";
import { Empty, Icon, Kbd, Pill, Spinner } from "../ui";
import { Block, StageHeader } from "./DataStage";

const mod = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";

export function ReviewStage(props: {
  config: TestConfig;
  errors: Errors;
  hosts: HostInfo[] | null;
  hostsError: string | null;
  onConfirm: (host: string) => void;
  onJump: (stage: Stage, field: string) => void;
  tryResult: TryResult | null;
  trying: boolean;
  onTry: () => void;
  onStart: () => void;
  canStart: boolean;
}) {
  const c = props.config;
  const est = estimateTest(c);
  const issues = Object.entries(props.errors);
  const grouped = new Map<Stage, [string, string][]>();
  for (const [k, v] of issues) grouped.set(stageOf(k), [...(grouped.get(stageOf(k)) ?? []), [k, v]]);
  const unconfirmed = (props.hosts ?? []).filter((h) => h.check && !h.check.approved);
  const fieldLabel = (k: string) => {
    const m = k.match(/^step:([^.]+)/);
    if (m) {
      const s = findStep(c, m[1]!);
      return s ? stepLabel(s.step) : "A step";
    }
    if (k.startsWith("scenario:")) return c.scenarios.find((s) => k.startsWith(`scenario:${s.id}`))?.name ?? "A scenario";
    if (k.startsWith("data:")) return c.data.find((d) => k === `data:${d.id}`)?.name ?? "A data file";
    if (k.startsWith("threshold:")) return "A threshold";
    return k === "name" ? "Test name" : k.split(".")[0]!;
  };
  return (
    <div className="mx-auto max-w-5xl px-8 py-7">
      <StageHeader title="Review">Everything this test will touch and everything still in the way. Nothing here is required: Start works from any stage.</StageHeader>

      <Block title="Hosts" hint="Every host is resolved and classified before a run; the run is pinned to the addresses checked, so DNS can't redirect it.">
        {props.hostsError && <p role="alert" className="mb-2 text-small text-danger">{props.hostsError}</p>}
        {!props.hosts ? (
          <p className="text-small text-text4">Resolving…</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-body">
              <tbody>
                {props.hosts.map((h, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="py-2 pr-2 pl-3 align-top">
                      <div className="flex items-center gap-2 font-mono text-body">
                        <Icon name="globe" className="size-3.5 text-text4" />
                        {h.source === "runtime" ? <span className="font-sans text-text2">Decided at runtime</span> : h.host}
                        {h.source === "proxy" && <Pill tone="neutral">proxy</Pill>}
                      </div>
                      <div className="mt-0.5 truncate pl-5.5 text-small text-text4">{h.steps.slice(0, 4).join(" · ")}{h.steps.length > 4 ? ` · +${h.steps.length - 4}` : ""}</div>
                    </td>
                    <td className="px-2 py-2 align-top font-mono text-small text-text3">{h.check?.addrs.join(", ")}</td>
                    <td className="py-2 pr-3 pl-2 text-right align-top">
                      {h.source === "runtime" ? (
                        <span className="text-small text-text3">checked per request</span>
                      ) : h.error ? (
                        <Pill tone="danger">{h.error}</Pill>
                      ) : h.check?.approved ? (
                        <Pill tone={h.check.loopback ? "success" : "info"}>
                          <Icon name="check" /> {h.check.loopback ? "loopback" : h.check.private ? "private network" : "confirmed"}
                        </Pill>
                      ) : (
                        <button type="button" className="btn btn-sm" onClick={() => props.onConfirm(h.host)}>
                          Confirm {h.check?.private ? "private host" : "host"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {props.hosts?.some((h) => h.source === "runtime") && (
          <p className="mt-2 text-small text-text3">
            Some URLs build their host from variables or data, so it's only known while running. A request to an unconfirmed host is <span className="text-text">blocked and counted</span>, never prompted mid-run.
          </p>
        )}
        {unconfirmed.length > 0 && <p className="mt-2 text-small text-warning">Only test APIs you own or are explicitly authorized to test. Confirmations last until you quit Toad.</p>}
      </Block>

      <Block title={issues.length ? `${issues.length} ${issues.length === 1 ? "issue" : "issues"} to fix` : "No issues"} hint={issues.length ? "Start stays available; the run refuses until these are fixed." : "The engine accepts this test as it is."}>
        {issues.length === 0 ? (
          <p className="flex items-center gap-1.5 text-small text-success">
            <Icon name="check" className="size-3.5" /> Every stage checks out.
          </p>
        ) : (
          <div className="space-y-3">
            {[...grouped.entries()].map(([stage, list]) => (
              <div key={stage}>
                <div className="mb-1 text-micro font-semibold tracking-wide text-text3 uppercase">{STAGE_LABEL[stage]}</div>
                <ul className="space-y-0.5">
                  {list.map(([k, v]) => (
                    <li key={k}>
                      <button type="button" className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left text-small hover:bg-raised" onClick={() => props.onJump(stage, k)}>
                        <span className="shrink-0 font-medium text-text">{fieldLabel(k)}</span>
                        <span className="min-w-0 flex-1 text-danger">{v}</span>
                        <Icon name="chevronRight" className="size-3 self-center text-text4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Block>

      <TryOnce config={c} result={props.tryResult} trying={props.trying} onTry={props.onTry} />

      <Block title="Start">
        <div className="flex items-center gap-6">
          <dl className="grid flex-1 grid-cols-4 gap-4">
            {[
              ["Length", fmtSecs(est.secs)],
              ["Requests", `≈${fmtInt(est.requests)}`],
              ["Peak rate", `≈${fmtPerTime(est.peakRps)}`],
              ["Peak users", fmtInt(est.peakVus)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-micro text-text4">{k}</dt>
                <dd className="tabular font-mono text-title font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <button type="button" className="btn btn-primary h-9 px-5" onClick={props.onStart} disabled={!props.canStart}>
            <Icon name="play" className="size-3.5" /> Start
          </button>
        </div>
      </Block>
    </div>
  );
}

function TryOnce({ config: c, result, trying, onTry }: { config: TestConfig; result: TryResult | null; trying: boolean; onTry: () => void }) {
  const [open, setOpen] = useState<Sample | null>(null);
  const name = (id: string) => {
    const s = findStep(c, id);
    return s ? stepLabel(s.step) : id;
  };
  const max = Math.max(1, ...(result?.steps ?? []).map((s) => s.latency_us));
  return (
    <Block
      title="Try once"
      hint="One virtual user walks every scenario once (setup, per-user init, one iteration), capturing every request. Nothing counts toward history."
      aside={
        <button type="button" className="btn btn-sm" onClick={onTry} disabled={trying} aria-busy={trying}>
          {trying ? <Spinner /> : <Icon name="bolt" className="size-3.5" />} {trying ? "Trying…" : result ? "Try again" : "Try once"}
        </button>
      }
    >
      {!result ? (
        <Empty title="Not tried yet" icon="bolt">
          Run it once to see real responses, the values each step extracted, and which branches were taken. <Kbd>{mod}⇧Enter</Kbd>
        </Empty>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
          <ol className="space-y-0.5">
            {result.error && (
              <li className="mb-2 flex gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-small text-danger">
                <Icon name="alert" className="mt-px size-3.5" /> {result.error}
              </li>
            )}
            {result.steps.map((s) => {
              const o = OUTCOME[s.outcome];
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(s)}
                    className={`grid w-full grid-cols-[1fr_auto_140px] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-small ${open?.id === s.id ? "bg-accent-soft" : "hover:bg-raised"}`}
                  >
                    <span className="min-w-0 truncate text-text">{name(s.step_id)}</span>
                    {s.response ? <Pill tone={statusTone(s.response.status)}>{s.response.status}</Pill> : <Pill tone={o.tone}>{o.label}</Pill>}
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 rounded-full bg-series1" style={{ width: `${Math.max(2, (s.latency_us / max) * 64)}px` }} />
                      <span className="tabular font-mono text-micro whitespace-nowrap text-text3">{s.latency_us ? fmtLatency(s.latency_us) : "–"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="min-w-0 rounded-xl border border-line p-3">
            {open ? <SampleView sample={open} stepName={name} /> : <p className="text-small text-text3">Pick a step to see its request and response.</p>}
          </div>
        </div>
      )}
    </Block>
  );
}
