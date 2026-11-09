import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { HostInfo, Sample, Settings, TestConfig, TryResult } from "../../bindings";
import { api, ApiError, errorMessage } from "../../lib/api";
import { findStep } from "../../lib/flow";
import { fmtInt, fmtSecs } from "../../lib/format";
import { duration, isOpen, maxVus, peak } from "../../lib/profile";
import { errorsByStage, STAGE_LABEL, STAGES, stageOf, summary, toErrors, type Errors, type Stage } from "../../lib/stages";
import { Icon, type IconName, Kbd, NumberInput, Popover } from "../ui";
import { ChecksStage } from "./ChecksStage";
import { DataStage } from "./DataStage";
import { FlowStage } from "./FlowStage";
import { LoadStage } from "./LoadStage";
import { ReviewStage } from "./ReviewStage";

const STAGE_ICON: Record<Stage, IconName> = { flow: "flow", data: "data", load: "load", checks: "shield", review: "review" };
const mod = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";

type SaveState = "saved" | "saving" | "unsaved" | "error";

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

export function TestPage(props: {
  initial: TestConfig;
  settings: Settings;
  runActive: boolean;
  runElapsedMs: number;
  onBack: () => void;
  onOpenRun: () => void;
  onStop: () => void;
  onStarted: (runId: string, config: TestConfig) => void;
  onSaved: (c: TestConfig) => void;
  notify: (kind: "error" | "info", text: string) => void;
}) {
  const [config, setConfigRaw] = useState<TestConfig>(props.initial);
  const [stage, setStage] = useState<Stage>("flow");
  const [selected, setSelected] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState(props.initial.scenarios[0]?.id ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [save, setSave] = useState<SaveState>("saved");
  const [hosts, setHosts] = useState<HostInfo[] | null>(null);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [tryResult, setTryResult] = useState<TryResult | null>(null);
  const [trying, setTrying] = useState(false);
  const [sent, setSent] = useState<Record<string, Sample>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const latest = useRef(config);
  latest.current = config;
  const past = useRef<TestConfig[]>([]);
  const future = useRef<TestConfig[]>([]);
  const lastPush = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<TestConfig> | null>(null);

  // ---- saving: every edit autosaves; a brand-new test is written on its first edit ----
  const persist = useCallback(async (): Promise<TestConfig> => {
    window.clearTimeout(saveTimer.current);
    if (saving.current) await saving.current.catch(() => null);
    const c = latest.current;
    setSave("saving");
    const p = api.saveTest(c);
    saving.current = p;
    try {
      const stored = await p;
      setConfigRaw((cur) => (cur.id ? cur : { ...cur, id: stored.id, created_at: stored.created_at }));
      latest.current = { ...latest.current, id: stored.id, created_at: stored.created_at };
      setSave((s) => (s === "saving" ? "saved" : s));
      props.onSaved(stored);
      return { ...latest.current };
    } catch (e) {
      setSave("error");
      throw e;
    } finally {
      saving.current = null;
    }
  }, [props]);

  const setConfig = useCallback(
    (next: TestConfig | ((c: TestConfig) => TestConfig)) => {
      setConfigRaw((cur) => {
        const v = typeof next === "function" ? next(cur) : next;
        if (v === cur) return cur;
        const now = Date.now();
        if (now - lastPush.current > 600) {
          past.current = [...past.current.slice(-99), cur];
          future.current = [];
        }
        lastPush.current = now;
        return v;
      });
      setSave("unsaved");
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void persist().catch((e) => props.notify("error", `Couldn't save: ${errorMessage(e)}`)), 700);
    },
    [persist, props],
  );

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);
  // Flush a pending save when leaving the page.
  const dirty = useRef(false);
  useEffect(() => {
    dirty.current = save === "unsaved";
  }, [save]);
  useEffect(() => () => void (dirty.current && api.saveTest(latest.current).catch(() => null)), []);

  // ---- validation by the engine ----
  useEffect(() => {
    const t = window.setTimeout(() => {
      api.validateTest(config).then((f) => setErrors(toErrors(f))).catch(() => null);
    }, 250);
    return () => window.clearTimeout(t);
  }, [config]);

  // ---- hosts, refreshed on the Review stage and when the environment or URLs change ----
  const hostKey = useMemo(() => JSON.stringify([config.active_env, config.defaults.base_url, config.variables, config.connection.proxy, config.connection.host_overrides, config.scenarios.map((s) => [s.enabled, s.steps, s.init]), config.setup.map((s) => s.url), config.teardown.map((s) => s.url)]), [config]);
  const refreshHosts = useCallback(async () => {
    try {
      setHostsError(null);
      const h = await api.testHosts(latest.current);
      setHosts(h);
      return h;
    } catch (e) {
      setHostsError(errorMessage(e));
      return null;
    }
  }, []);
  useEffect(() => {
    if (stage !== "review") return;
    const t = window.setTimeout(() => void refreshHosts(), 300);
    return () => window.clearTimeout(t);
  }, [stage, hostKey, refreshHosts]);

  /** Ask once for every unconfirmed host; true when all are confirmed. */
  const confirmHosts = useCallback(async (): Promise<boolean> => {
    const h = (await refreshHosts()) ?? [];
    const pending = h.filter((x) => x.check && !x.check.approved);
    if (!pending.length) return true;
    const list = pending.map((x) => `• ${x.host} → ${x.check!.addrs.join(", ")}`).join("\n");
    const ok = await confirm(
      `This test reaches ${pending.length === 1 ? "a host that isn't" : "hosts that aren't"} on this machine:\n\n${list}\n\nOnly load-test APIs you own or are authorized to test. Toad remembers this until you quit.`,
      { title: "Run against non-local hosts?", kind: "warning", okLabel: "Confirm and continue", cancelLabel: "Cancel" },
    );
    if (!ok) return false;
    for (const x of pending) await api.approveHost(x.host);
    await refreshHosts();
    return true;
  }, [refreshHosts]);

  const ensureSaved = useCallback(async () => (latest.current.id && save === "saved" ? latest.current : persist()), [persist, save]);

  const pickFile = useCallback(
    async (filters?: { name: string; extensions: string[] }[]) => {
      const path = await open({ multiple: false, directory: false, filters });
      if (!path || Array.isArray(path)) return null;
      try {
        const c = await ensureSaved();
        const a = await api.importAsset(c.id, path);
        return { file: a.file, name: a.name };
      } catch (e) {
        props.notify("error", errorMessage(e));
        return null;
      }
    },
    [ensureSaved, props],
  );

  const tryOnce = useCallback(async () => {
    if (trying) return;
    setTrying(true);
    try {
      if (!(await confirmHosts())) return;
      const c = await ensureSaved();
      setTryResult(await api.tryFlow(c, null));
    } catch (e) {
      if (e instanceof ApiError && e.fields.length) setErrors(toErrors(e.fields));
      props.notify("error", errorMessage(e));
    } finally {
      setTrying(false);
    }
  }, [trying, confirmHosts, ensureSaved, props]);

  const sendOnce = useCallback(
    async (stepId: string) => {
      setSending(stepId);
      try {
        if (!(await confirmHosts())) return;
        const c = await ensureSaved();
        const r = await api.sendStep(c, stepId, tryResult?.vars ?? []);
        if (r.steps[0]) setSent((m) => ({ ...m, [stepId]: r.steps[0]! }));
        if (r.steps[0]?.outcome === "skipped") props.notify("info", `${r.steps[0].error}. Try once fills values from earlier steps.`);
      } catch (e) {
        props.notify("error", errorMessage(e));
      } finally {
        setSending(null);
      }
    },
    [confirmHosts, ensureSaved, tryResult, props],
  );

  const start = useCallback(async () => {
    if (props.runActive || starting) return;
    if (Object.keys(errors).length) {
      const first = Object.keys(errors)[0]!;
      props.notify("error", `Fix ${Object.keys(errors).length === 1 ? "the issue" : `the ${Object.keys(errors).length} issues`} before starting (see Review).`);
      setStage(stageOf(first) === "flow" && !first.startsWith("step:") ? "review" : stageOf(first));
      return;
    }
    setStarting(true);
    try {
      if (!(await confirmHosts())) return;
      const c = await ensureSaved();
      const id = await api.startRun(c);
      props.onStarted(id, c);
    } catch (e) {
      if (e instanceof ApiError && e.fields.length) setErrors(toErrors(e.fields));
      props.notify("error", errorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [props, starting, errors, confirmHosts, ensureSaved]);

  const jump = (st: Stage, field: string) => {
    setStage(st);
    const m = field.match(/^step:([^.]+)/);
    if (m) {
      const ref = findStep(config, m[1]!);
      if (ref?.scenario) setScenarioId(ref.scenario.id);
      setSelected(m[1]!);
    }
  };

  // ---- keyboard ----
  const keys = useRef({ start, tryOnce, sendOnce, selected });
  keys.current = { start, tryOnce, sendOnce, selected };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = e.metaKey || e.ctrlKey;
      if (m && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        void keys.current.tryOnce();
      } else if (m && e.key === "Enter") {
        e.preventDefault();
        void keys.current.start();
      } else if (m && e.shiftKey && e.key.toLowerCase() === "s" && keys.current.selected) {
        e.preventDefault();
        void keys.current.sendOnce(keys.current.selected);
      } else if (m && !e.shiftKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        setStage(STAGES[Number(e.key) - 1]!);
      } else if (m && e.key.toLowerCase() === "z" && !isEditable(document.activeElement)) {
        e.preventDefault();
        const from = e.shiftKey ? future : past;
        const to = e.shiftKey ? past : future;
        const prev = from.current.pop();
        if (prev) {
          to.current.push(latest.current);
          lastPush.current = 0;
          setConfigRaw(prev);
          setSave("unsaved");
          window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => void persist(), 700);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [persist]);

  const counts = errorsByStage(errors);
  const unconfirmed = (hosts ?? []).filter((h) => h.check && !h.check.approved).length;
  const readOnly = props.runActive;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TestHeader
        config={config}
        onChange={setConfig}
        save={save}
        onBack={props.onBack}
        onTry={() => void tryOnce()}
        trying={trying}
        onStart={() => void start()}
        starting={starting}
        runActive={props.runActive}
        runElapsedMs={props.runElapsedMs}
        onOpenRun={props.onOpenRun}
        onStop={props.onStop}
        onLoad={() => setStage("load")}
        errorCount={Object.keys(errors).length}
      />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Stages" className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-line bg-chrome p-2 max-[1200px]:w-14">
          {STAGES.map((st, i) => {
            const on = st === stage;
            const n = counts[st] + (st === "review" ? 0 : 0);
            return (
              <button
                key={st}
                type="button"
                aria-current={on ? "page" : undefined}
                title={`${STAGE_LABEL[st]} (${mod}${i + 1})`}
                onClick={() => setStage(st)}
                className={`group relative flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors max-[1200px]:justify-center max-[1200px]:px-0 ${on ? "bg-accent-soft" : "hover:bg-raised"}`}
              >
                <Icon name={STAGE_ICON[st]} className={`mt-0.5 size-4 ${on ? "text-accent-ink" : "text-text3 group-hover:text-text2"}`} />
                <span className="min-w-0 flex-1 max-[1200px]:hidden">
                  <span className={`flex items-center gap-1.5 text-body font-medium ${on ? "text-text" : "text-text2"}`}>
                    {STAGE_LABEL[st]}
                    {n > 0 && <span className="tabular rounded-full bg-danger-soft px-1.5 font-mono text-micro font-semibold text-danger">{n}</span>}
                  </span>
                  <span className="line-clamp-2 text-small text-text3">{summary(config, st, unconfirmed)}</span>
                </span>
                {n > 0 && <span className="absolute top-1.5 right-1.5 hidden size-1.5 rounded-full bg-danger-fill max-[1200px]:block" aria-label={`${n} issues`} />}
              </button>
            );
          })}
          <div className="mt-auto px-2.5 pb-1 text-micro text-text4 max-[1200px]:hidden">
            <Kbd>{mod}1</Kbd>–<Kbd>{mod}5</Kbd> switch stages
          </div>
        </nav>
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {readOnly && (
            <div className="flex items-center gap-2 border-b border-line bg-info-soft px-5 py-2 text-small text-info">
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
              A run is in progress, so this test is read-only.
              <button type="button" className="btn btn-sm ml-auto" onClick={props.onOpenRun}>
                Watch the run
              </button>
            </div>
          )}
          <fieldset disabled={readOnly} className={`h-full min-h-0 ${stage === "flow" ? "" : "overflow-y-auto"}`}>
            {stage === "flow" && (
              <FlowStage
                config={config}
                onChange={setConfig}
                errors={errors}
                selected={selected}
                onSelect={setSelected}
                scenarioId={scenarioId}
                onScenario={(id) => {
                  setScenarioId(id);
                  setSelected(null);
                }}
                tryResult={tryResult}
                sent={sent}
                onSend={(id) => void sendOnce(id)}
                sending={sending}
                onPickFile={() => pickFile()}
              />
            )}
            {stage === "data" && <DataStage config={config} onChange={setConfig} errors={errors} pickFile={pickFile} testId={config.id} />}
            {stage === "load" && <LoadStage config={config} onChange={setConfig} errors={errors} settings={props.settings} pickFile={pickFile} />}
            {stage === "checks" && <ChecksStage config={config} onChange={setConfig} errors={errors} onJump={(id) => jump("flow", `step:${id}`)} />}
            {stage === "review" && (
              <ReviewStage
                config={config}
                errors={errors}
                hosts={hosts}
                hostsError={hostsError}
                onConfirm={async (h) => {
                  await api.approveHost(h);
                  await refreshHosts();
                }}
                onJump={jump}
                tryResult={tryResult}
                trying={trying}
                onTry={() => void tryOnce()}
                onStart={() => void start()}
                canStart={!props.runActive && !starting}
              />
            )}
          </fieldset>
        </main>
      </div>
    </div>
  );
}

const SAVE_TEXT: Record<SaveState, string> = { saved: "Saved", saving: "Saving…", unsaved: "Edited", error: "Not saved" };

function TestHeader(p: {
  config: TestConfig;
  onChange: (c: TestConfig) => void;
  save: SaveState;
  onBack: () => void;
  onTry: () => void;
  trying: boolean;
  onStart: () => void;
  starting: boolean;
  runActive: boolean;
  runElapsedMs: number;
  onOpenRun: () => void;
  onStop: () => void;
  onLoad: () => void;
  errorCount: number;
}) {
  const c = p.config;
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-chrome px-3">
      <button type="button" className="btn btn-ghost btn-sm" onClick={p.onBack} title="All tests">
        <Icon name="back" className="size-3.5" /> Tests
      </button>
      <span className="h-5 w-px bg-line2" aria-hidden />
      <input
        className="input h-8 w-auto max-w-80 min-w-24 border-transparent bg-transparent px-2 text-title font-semibold hover:border-line2"
        style={{ width: `${Math.max(8, c.name.length + 2)}ch` }}
        aria-label="Test name"
        value={c.name}
        disabled={p.runActive}
        onChange={(e) => p.onChange({ ...c, name: e.target.value })}
      />
      <span className={`text-small ${p.save === "error" ? "text-danger" : "text-text4"}`} role="status" aria-live="polite">
        {SAVE_TEXT[p.save]}
      </span>
      <span className="flex-1" />
      {c.environments.length > 0 && (
        <label className="flex items-center gap-1.5 text-small text-text3">
          <Icon name="globe" className="size-3.5" />
          <select
            aria-label="Environment"
            className="input h-7 w-auto pr-7 text-small"
            value={c.active_env}
            disabled={p.runActive}
            onChange={(e) => p.onChange({ ...c, active_env: e.target.value })}
          >
            {c.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <LoadChip config={c} onChange={p.onChange} onOpen={p.onLoad} disabled={p.runActive} />
      {p.runActive ? (
        <>
          <button type="button" className="btn btn-sm" onClick={p.onOpenRun}>
            <span className="size-1.5 animate-pulse rounded-full bg-info" /> Running · <span className="tabular font-mono">{fmtSecs(p.runElapsedMs / 1000)}</span>
          </button>
          <button type="button" className="btn btn-danger btn-sm w-20" onClick={p.onStop} title={`Stop (${mod}.)`}>
            <Icon name="stop" className="size-3" /> Stop
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn-sm" onClick={p.onTry} disabled={p.trying} title={`One virtual user through every step, once (${mod}⇧Enter)`}>
            <Icon name="bolt" className="size-3.5" /> {p.trying ? "Trying…" : "Try once"}
          </button>
          <button type="button" className="btn btn-primary btn-sm w-24" onClick={p.onStart} disabled={p.starting} title={`Start (${mod}Enter)${p.errorCount ? ` · ${p.errorCount} issues to fix` : ""}`}>
            <Icon name="play" className="size-3" /> {p.starting ? "Starting…" : "Start"}
          </button>
        </>
      )}
    </div>
  );
}

/** "50 VUs · 30 s": the load at a glance, editable in place for single-scenario tests. */
function LoadChip({ config: c, onChange, onOpen, disabled }: { config: TestConfig; onChange: (c: TestConfig) => void; onOpen: () => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const enabled = c.scenarios.filter((s) => s.enabled);
  const one = enabled.length === 1 ? enabled[0]! : null;
  const e = one?.executor;
  const text = !one
    ? `${enabled.length} scenarios · ${fmtInt(enabled.reduce((n, s) => n + maxVus(s.executor), 0))} VUs`
    : e!.kind === "iterations"
      ? `${fmtInt(e!.vus)} VUs · ${fmtInt(e!.iterations)} iter.`
      : `${fmtInt(isOpen(e!) ? peak(e!) : maxVus(e!))} ${isOpen(e!) ? "iter/s" : "VUs"} · ${fmtSecs(duration(e!))}`;
  const setE = (patch: Record<string, number>) => {
    if (!one) return;
    onChange({ ...c, scenarios: c.scenarios.map((s) => (s.id === one.id ? { ...s, executor: { ...s.executor, ...patch } as typeof s.executor } : s)) });
  };
  return (
    <>
      <button ref={ref} type="button" className="btn btn-sm font-mono" disabled={disabled} onClick={() => (one && (e!.kind === "vus" || e!.kind === "rate" || e!.kind === "iterations") ? setOpen((o) => !o) : onOpen())} aria-haspopup="dialog" title="Load">
        <Icon name="load" className="size-3.5" /> <span className="tabular">{text}</span>
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end" width={300} className="p-3">
        {e?.kind === "vus" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-small text-text3">Virtual users<NumberInput min={1} value={e.vus} onChange={(v) => setE({ vus: v ?? 0 })} /></label>
            <label className="text-small text-text3">Duration<NumberInput suffix="s" min={1} value={e.duration_secs} onChange={(v) => setE({ duration_secs: v ?? 0 })} /></label>
          </div>
        )}
        {e?.kind === "rate" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-small text-text3">Iterations/s<NumberInput min={1} value={e.rate} onChange={(v) => setE({ rate: v ?? 0 })} /></label>
            <label className="text-small text-text3">Duration<NumberInput suffix="s" min={1} value={e.duration_secs} onChange={(v) => setE({ duration_secs: v ?? 0 })} /></label>
          </div>
        )}
        {e?.kind === "iterations" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-small text-text3">Virtual users<NumberInput min={1} value={e.vus} onChange={(v) => setE({ vus: v ?? 0 })} /></label>
            <label className="text-small text-text3">Iterations<NumberInput min={1} value={e.iterations} onChange={(v) => setE({ iterations: v ?? 0 })} /></label>
          </div>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-2 w-full justify-start"
          onClick={() => {
            setOpen(false);
            onOpen();
          }}
        >
          Stages, arrival rate and more in Load <Icon name="chevronRight" className="ml-auto size-3" />
        </button>
      </Popover>
    </>
  );
}
