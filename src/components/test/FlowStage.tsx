import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FlowItem, RequestStep, Sample, Scenario, ScenarioKind, TestConfig, ThinkTime, TryResult } from "../../bindings";
import { parseCurl } from "../../lib/curl";
import { groupItem, newScenario, newStep, pauseItem, uid } from "../../lib/defaults";
import { duplicateStep, findStep, insertItems, itemId, moveById, removeById, stepLabel, updateItem, updateScenario, updateStep, type Where } from "../../lib/flow";
import type { Errors } from "../../lib/stages";
import { namesFor } from "../../lib/template";
import { Field, Icon, IconButton, Menu, NumberInput, Segmented } from "../ui";
import { ResolvedPreview } from "./ResolvedPreview";
import { RunIfEditor, runIfText } from "./RunIfEditor";
import { StepEditor, type PickFile } from "./StepEditor";

export type FlowProps = {
  config: TestConfig;
  onChange: (c: TestConfig) => void;
  errors: Errors;
  selected: string | null;
  onSelect: (id: string | null) => void;
  scenarioId: string;
  onScenario: (id: string) => void;
  tryResult: TryResult | null;
  sent: Record<string, Sample>;
  onSend: (stepId: string) => void;
  sending: string | null;
  onPickFile: PickFile;
};

const METHOD_TONE: Record<string, string> = { GET: "text-info", POST: "text-success", PUT: "text-warning", PATCH: "text-warning", DELETE: "text-danger" };

function MethodTag({ m }: { m: string }) {
  return <span className={`w-11 shrink-0 font-mono text-micro font-semibold ${METHOD_TONE[m] ?? "text-text3"}`}>{m.length > 6 ? `${m.slice(0, 5)}…` : m}</span>;
}

function StepRow(props: { step: RequestStep; selected: boolean; onSelect: () => void; error: boolean; indent?: boolean; mix?: boolean; totalWeight?: number; tried?: Sample }) {
  const s = props.step;
  const produces = s.extract.filter((e) => e.enabled && e.var.trim()).map((e) => e.var.trim());
  const consumes = [...new Set([s.url, ...s.headers.map((h) => h.value), s.body?.content ?? "", ...s.params.map((p) => p.value)].join(" ").match(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)?.map((m) => m.slice(2, -2).trim()) ?? [])].filter(
    (v) => !v.includes(".") || !["vu.id", "run.id"].includes(v),
  );
  const rule = runIfText(s.run_if);
  const tried = props.tried;
  return (
    <button
      type="button"
      data-outline-id={s.id}
      onClick={props.onSelect}
      className={`group flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors ${props.indent ? "pl-5" : ""} ${props.selected ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "hover:bg-raised"}`}
    >
      <span className="flex w-full items-center gap-1.5">
        <MethodTag m={s.method} />
        <span className="min-w-0 flex-1 truncate text-body text-text">{stepLabel(s).replace(new RegExp(`^${s.method} `), "")}</span>
        {rule && <Icon name="branch" className="size-3 text-info" />}
        {tried && <span className={`size-1.5 rounded-full ${tried.outcome === "ok" ? "bg-success" : tried.outcome === "not_taken" ? "bg-text4" : "bg-danger-fill"}`} title={`Try once: ${tried.outcome}`} />}
        {props.error && <span className="size-1.5 rounded-full bg-danger-fill" aria-label="has errors" />}
        {props.mix && props.totalWeight ? <span className="tabular font-mono text-micro text-text4">{Math.round((s.weight / props.totalWeight) * 100)}%</span> : null}
      </span>
      {(produces.length > 0 || consumes.length > 0 || rule) && (
        <span className="flex flex-wrap items-center gap-1 pl-12.5">
          {consumes.slice(0, 3).map((v) => (
            <span key={`c-${v}`} className="rounded bg-raised2 px-1 font-mono text-micro text-text3" title={`reads {{${v}}}`}>
              {v}
            </span>
          ))}
          {produces.map((v) => (
            <span key={`p-${v}`} className="inline-flex items-center gap-0.5 rounded bg-raised2 px-1 font-mono text-micro text-text2" title={`extracts ${v}`}>
              <Icon name="arrowRight" className="size-2.5 text-text4" />
              {v}
            </span>
          ))}
          {rule && <span className="truncate text-micro text-info">{rule}</span>}
        </span>
      )}
    </button>
  );
}

function Section(props: { title: string; hint: string; children: ReactNode; onAdd: () => void; addLabel: string; count: number; collapsed?: boolean }) {
  const [open, setOpen] = useState(!props.collapsed || props.count > 0);
  return (
    <section className="mb-2">
      <div className="flex items-center gap-1 px-1">
        <button type="button" className="flex flex-1 items-center gap-1 py-1 text-left text-micro font-semibold tracking-wide text-text3 uppercase" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name={open ? "chevronDown" : "chevronRight"} className="size-3" />
          {props.title}
          {props.count > 0 && <span className="tabular font-mono font-normal text-text4">{props.count}</span>}
        </button>
        <IconButton icon="plus" size="sm" label={props.addLabel} onClick={() => { setOpen(true); props.onAdd(); }} />
      </div>
      {open && (props.count === 0 ? <p className="px-2 pb-1 text-micro text-text4">{props.hint}</p> : <div className="space-y-0.5">{props.children}</div>)}
    </section>
  );
}

export function FlowStage(p: FlowProps) {
  const c = p.config;
  const sc = c.scenarios.find((s) => s.id === p.scenarioId) ?? c.scenarios[0]!;
  const [curlOpen, setCurlOpen] = useState<Where | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [split, setSplit] = useState(0.62);
  const right = useRef<HTMLDivElement>(null);
  const outline = useRef<HTMLDivElement>(null);
  const hasError = (id: string) => Object.keys(p.errors).some((k) => k.startsWith(`step:${id}`) || k.startsWith(`group:${id}`) || k.startsWith(`pause:${id}`));
  const tried = useMemo(() => {
    const m = new Map<string, Sample>();
    for (const s of p.tryResult?.steps ?? []) m.set(s.step_id, s);
    return m;
  }, [p.tryResult]);
  const totalWeight = sc.kind === "mix" ? sc.steps.reduce((n, it) => n + (it.kind === "request" ? it.step.weight : 0), 0) : 0;

  const add = (where: Where, item: FlowItem) => {
    p.onChange(insertItems(c, where, [item], p.selected ?? undefined));
    p.onSelect(item.kind === "request" ? item.step.id : itemId(item));
  };
  const firstReq = sc.steps.find((i) => i.kind === "request");
  const lastUrl = findStep(c, p.selected ?? "")?.step.url ?? (firstReq?.kind === "request" ? firstReq.step.url : "");
  const newRequest = (): FlowItem => ({ kind: "request", step: newStep(lastUrl.replace(/(\/\/[^/]+).*/, "$1/") || (c.defaults.base_url ? "{{baseUrl}}/" : "http://localhost:8787/")) });

  const addMenu = (where: Where, isMain: boolean) => [
    { label: "Request", icon: "plus" as const, onSelect: () => add(where, newRequest()) },
    { label: "Paste cURL…", icon: "terminal" as const, hint: "From a browser's Copy as cURL or API docs", onSelect: () => setCurlOpen(where) },
    ...(isMain && sc.kind === "flow"
      ? [
          { label: "Parallel group", icon: "parallel" as const, hint: "Requests that fire together", onSelect: () => add(where, groupItem(lastUrl)) },
          { label: "Pause", icon: "pause" as const, hint: "Think time between steps", onSelect: () => add(where, pauseItem()) },
        ]
      : []),
  ];

  const loginPreset = (perUser: boolean) => {
    const login = newStep(c.defaults.base_url ? "{{baseUrl}}/login" : "http://localhost:8787/login", "POST");
    login.name = "Log in";
    login.body = { kind: "json", content: '{\n  "user": "{{$email}}"\n}', fields: [], variables: "", file: null, content_type: "", gzip: false };
    login.extract = [{ id: uid("x"), var: "token", source: "json", expr: "$.token", pick: "first", index: 0, default: "", on_missing: "skip_iteration", secret: true, enabled: true }];
    let next = perUser ? updateScenario(c, sc.id, (s) => ({ ...s, init: [...s.init, { kind: "request", step: login }] })) : { ...c, setup: [...c.setup, login] };
    if (next.defaults.auth.kind === "none") next = { ...next, defaults: { ...next.defaults, auth: { kind: "bearer", token: "{{token}}" } } };
    p.onChange(next);
    p.onSelect(login.id);
  };

  // Outline keyboard: arrows move the selection, ⌥ + arrows move the item, ⌘D duplicates, Delete removes.
  const onOutlineKey = (e: KeyboardEvent) => {
    const ids = [...(outline.current?.querySelectorAll<HTMLElement>("[data-outline-id]") ?? [])].map((el) => el.dataset.outlineId!);
    const i = p.selected ? ids.indexOf(p.selected) : -1;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey) {
      e.preventDefault();
      const j = Math.max(0, Math.min(ids.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      if (ids[j]) {
        p.onSelect(ids[j]!);
        outline.current?.querySelector<HTMLElement>(`[data-outline-id="${ids[j]}"]`)?.focus();
      }
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey && p.selected) {
      e.preventDefault();
      p.onChange(moveById(c, p.selected, e.key === "ArrowDown" ? 1 : -1));
      requestAnimationFrame(() => outline.current?.querySelector<HTMLElement>(`[data-outline-id="${p.selected}"]`)?.focus());
    } else if (e.key.toLowerCase() === "d" && (e.metaKey || e.ctrlKey) && p.selected && findStep(c, p.selected)) {
      e.preventDefault();
      const [next, id] = duplicateStep(c, p.selected);
      p.onChange(next);
      p.onSelect(id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && p.selected) {
      e.preventDefault();
      const j = ids[i + 1] ?? ids[i - 1] ?? null;
      p.onChange(removeById(c, p.selected));
      p.onSelect(j);
    }
  };

  const renderItems = (items: FlowItem[], isMix: boolean) =>
    items.map((it) => {
      if (it.kind === "request")
        return <StepRow key={it.step.id} step={it.step} selected={p.selected === it.step.id} onSelect={() => p.onSelect(it.step.id)} error={hasError(it.step.id)} mix={isMix} totalWeight={totalWeight} tried={tried.get(it.step.id)} />;
      if (it.kind === "pause") {
        const t = it.pause.think;
        const text = t.kind === "fixed" ? `${t.ms} ms` : t.kind === "uniform" ? `${t.min_ms}–${t.max_ms} ms` : `~${t.mean_ms} ms ±${t.sd_ms}`;
        return (
          <button
            key={it.pause.id}
            type="button"
            data-outline-id={it.pause.id}
            onClick={() => p.onSelect(it.pause.id)}
            className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-small ${p.selected === it.pause.id ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "text-text3 hover:bg-raised"}`}
          >
            <Icon name="pause" className="size-3.5 w-11" />
            <span className="flex-1">Pause {text}</span>
            {it.pause.run_if && <Icon name="branch" className="size-3 text-info" />}
          </button>
        );
      }
      const g = it.group;
      return (
        <div key={g.id} className={`rounded-lg border ${p.selected === g.id ? "border-accent" : "border-line2"} border-dashed`}>
          <button
            type="button"
            data-outline-id={g.id}
            onClick={() => p.onSelect(g.id)}
            className={`flex w-full items-center gap-1.5 rounded-t-lg px-2 py-1 text-left text-small ${p.selected === g.id ? "bg-accent-soft text-text" : "text-text3 hover:bg-raised"}`}
          >
            <Icon name="parallel" className="size-3.5" />
            <span className="flex-1 font-medium">{g.name || "Parallel group"}</span>
            {g.run_if && <Icon name="branch" className="size-3 text-info" />}
            {hasError(g.id) && <span className="size-1.5 rounded-full bg-danger-fill" />}
            <span className="tabular font-mono text-micro text-text4">{g.steps.length}</span>
          </button>
          <div className="space-y-0.5 p-0.5">
            {g.steps.map((s) => (
              <StepRow key={s.id} step={s} indent selected={p.selected === s.id} onSelect={() => p.onSelect(s.id)} error={hasError(s.id)} tried={tried.get(s.id)} />
            ))}
          </div>
        </div>
      );
    });

  const ref = p.selected ? findStep(c, p.selected) : null;
  const item = !ref && p.selected ? [...sc.init, ...sc.steps].find((i) => itemId(i) === p.selected) ?? null : null;

  // Keep the selection inside the scenario being shown.
  useEffect(() => {
    if (!p.selected) {
      const first = sc.steps[0];
      if (first) p.onSelect(first.kind === "request" ? first.step.id : itemId(first));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selected, sc.id]);

  const names = useMemo(() => namesFor(c, ref?.step.id ?? null), [c, ref?.step.id]);
  const stepErrors = (id: string) => Object.fromEntries(Object.entries(p.errors).filter(([k]) => k.startsWith(`step:${id}`)));

  const onDrag = (e: React.PointerEvent) => {
    const box = right.current?.getBoundingClientRect();
    if (!box) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSplit(Math.min(0.85, Math.max(0.3, (ev.clientY - box.top) / box.height)));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-chrome">
        <ScenarioBar config={c} scenario={sc} onScenario={p.onScenario} onChange={p.onChange} />
        <div ref={outline} className="min-h-0 flex-1 overflow-y-auto px-2 py-2" onKeyDown={onOutlineKey} role="tree" aria-label="Steps">
          <Section title="Setup · once per test" hint="Runs before load starts; extracted values are shared by every virtual user (log in once)." count={c.setup.length} collapsed onAdd={() => add("setup", newRequest())} addLabel="Add a setup step">
            {c.setup.map((s) => (
              <StepRow key={s.id} step={s} selected={p.selected === s.id} onSelect={() => p.onSelect(s.id)} error={hasError(s.id)} tried={tried.get(s.id)} />
            ))}
          </Section>
          <Section title="Per-user init" hint="Runs once per virtual user before its first iteration (log in per user)." count={sc.init.length} collapsed onAdd={() => add({ scenario: sc.id, list: "init" }, newRequest())} addLabel="Add an init step">
            {renderItems(sc.init, false)}
          </Section>
          <section className="mb-2">
            <div className="flex items-center gap-1 px-1">
              <span className="flex-1 py-1 text-micro font-semibold tracking-wide text-text3 uppercase">
                {sc.kind === "mix" ? "Mix · one step per iteration" : "Steps · in order"}
              </span>
              <Menu label="Add to steps" icon="plus" items={addMenu({ scenario: sc.id, list: "steps" }, true)} />
            </div>
            <div className="space-y-0.5">{renderItems(sc.steps, sc.kind === "mix")}</div>
            {sc.steps.length === 0 && <p className="px-2 py-2 text-small text-text3">No steps yet. Add a request, or paste a cURL command.</p>}
          </section>
          <Section title="Teardown · once at the end" hint="Runs after load ends (clean up)." count={c.teardown.length} collapsed onAdd={() => add("teardown", newRequest())} addLabel="Add a teardown step">
            {c.teardown.map((s) => (
              <StepRow key={s.id} step={s} selected={p.selected === s.id} onSelect={() => p.onSelect(s.id)} error={hasError(s.id)} tried={tried.get(s.id)} />
            ))}
          </Section>
        </div>
        <div className="flex items-center gap-1 border-t border-line px-2 py-1.5">
          <Menu
            label="Add"
            className="btn btn-ghost btn-sm"
            trigger={
              <>
                <Icon name="plus" className="size-3" /> Add
              </>
            }
            align="start"
            items={[
              ...addMenu({ scenario: sc.id, list: "steps" }, true),
              "sep",
              { label: "Login step, once for everyone", icon: "lock", hint: "Setup: POST /login, extract {{token}}, Bearer by default", onSelect: () => loginPreset(false) },
              { label: "Login step, per user", icon: "lock", hint: "Per-user init with the same extraction", onSelect: () => loginPreset(true) },
            ]}
          />
          <span className="flex-1" />
          {p.selected && findStep(c, p.selected) && (
            <>
              <IconButton icon="arrowUp" size="sm" label="Move up (⌥↑)" onClick={() => p.onChange(moveById(c, p.selected!, -1))} />
              <IconButton icon="arrowDown" size="sm" label="Move down (⌥↓)" onClick={() => p.onChange(moveById(c, p.selected!, 1))} />
              <IconButton
                icon="copy"
                size="sm"
                label="Duplicate (⌘D)"
                onClick={() => {
                  const [next, id] = duplicateStep(c, p.selected!);
                  p.onChange(next);
                  p.onSelect(id);
                }}
              />
            </>
          )}
          {p.selected && (
            <IconButton
              icon="trash"
              size="sm"
              danger
              label="Remove (Delete)"
              onClick={() => {
                p.onChange(removeById(c, p.selected!));
                p.onSelect(null);
              }}
            />
          )}
        </div>
      </aside>

      <div ref={right} className="flex min-w-0 flex-1 flex-col">
        {ref ? (
          <>
            <div className="min-h-0 overflow-hidden" style={{ flex: previewOpen ? `0 0 ${split * 100}%` : "1 1 auto" }}>
              <StepEditor
                key={ref.step.id}
                step={ref.step}
                onChange={(s) => p.onChange(updateStep(c, s.id, () => s))}
                names={names}
                errors={stepErrors(ref.step.id)}
                mix={ref.scenario?.kind === "mix" && ref.phase === "main"}
                inheritedHeaders={c.defaults.headers.filter((h) => h.enabled && h.name.trim())}
                defaultAuth={c.defaults.auth}
                onSend={() => p.onSend(ref.step.id)}
                sending={p.sending === ref.step.id}
                lastSample={p.sent[ref.step.id] ?? tried.get(ref.step.id) ?? null}
                onPickFile={p.onPickFile}
              />
            </div>
            {previewOpen ? (
              <>
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize the preview"
                  className="group relative h-1.5 shrink-0 cursor-row-resize border-t border-line"
                  onPointerDown={onDrag}
                >
                  <span className="absolute inset-x-0 -top-px h-0.5 bg-accent opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <div className="relative min-h-0 flex-1 bg-chrome">
                  <ResolvedPreview config={c} step={ref.step} tryVars={p.tryResult?.vars ?? null} />
                  <div className="absolute top-1.5 right-10">
                    <IconButton icon="chevronDown" size="sm" label="Hide the resolved request" onClick={() => setPreviewOpen(false)} />
                  </div>
                </div>
              </>
            ) : (
              <button type="button" className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-chrome px-4 text-small text-text3 hover:text-text" onClick={() => setPreviewOpen(true)}>
                <Icon name="chevronRight" className="size-3 -rotate-90" /> Resolved request
              </button>
            )}
          </>
        ) : item?.kind === "group" ? (
          <GroupEditor config={c} item={item} onChange={p.onChange} errors={p.errors} onAddMember={() => p.onChange(updateItem(c, item.group.id, (it) => (it.kind === "group" ? { ...it, group: { ...it.group, steps: [...it.group.steps, newStep(it.group.steps[0]?.url ?? "")] } } : it)))} />
        ) : item?.kind === "pause" ? (
          <PauseEditor config={c} item={item} onChange={p.onChange} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <Icon name="flow" className="size-8 text-text4" />
            <p className="text-title font-semibold">Pick a step to edit it</p>
            <p className="max-w-sm text-body text-text3">Or add one from the outline: a request, a parallel group, a pause, or a pasted cURL command.</p>
          </div>
        )}
      </div>
      {curlOpen && (
        <CurlDialog
          onClose={() => setCurlOpen(null)}
          onAdd={(step) => {
            add(curlOpen, { kind: "request", step });
            setCurlOpen(null);
          }}
        />
      )}
    </div>
  );
}

function ScenarioBar({ config: c, scenario: sc, onScenario, onChange }: { config: TestConfig; scenario: Scenario; onScenario: (id: string) => void; onChange: (c: TestConfig) => void }) {
  const set = (patch: Partial<Scenario>) => onChange(updateScenario(c, sc.id, (s) => ({ ...s, ...patch })));
  const multi = c.scenarios.length > 1;
  return (
    <div className="border-b border-line px-3 pt-2.5 pb-2">
      {multi && (
        <div className="-mx-1 mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Scenarios">
          {c.scenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === sc.id}
              onClick={() => onScenario(s.id)}
              className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-small font-medium ${s.id === sc.id ? "bg-seg text-text shadow-[0_1px_2px_rgb(0_0_0/0.12)]" : "text-text3 hover:text-text"} ${s.enabled ? "" : "line-through opacity-60"}`}
            >
              {s.name || "Unnamed"}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {multi ? (
          <input className="input h-7 min-w-0 flex-1 text-body font-medium" aria-label="Scenario name" value={sc.name} onChange={(e) => set({ name: e.target.value })} />
        ) : (
          <span className="min-w-0 flex-1 text-body font-medium text-text2">Flow</span>
        )}
        <Segmented<ScenarioKind>
          size="sm"
          aria-label="Scenario kind"
          value={sc.kind}
          onChange={(kind) => set({ kind, steps: kind === "mix" ? sc.steps.filter((i) => i.kind === "request") : sc.steps })}
          options={[
            { value: "flow", label: "Sequence", title: "Each virtual user walks the steps in order" },
            { value: "mix", label: "Mix", title: "Each iteration picks one step by weight" },
          ]}
        />
        <Menu
          label="Scenario options"
          items={[
            {
              label: "Add scenario",
              icon: "plus",
              hint: "Runs at the same time, with its own load",
              onSelect: () => {
                const s = newScenario(`Scenario ${c.scenarios.length + 1}`, "http://localhost:8787/");
                onChange({ ...c, scenarios: [...c.scenarios, s] });
                onScenario(s.id);
              },
            },
            { label: sc.enabled ? "Turn off this scenario" : "Turn on this scenario", onSelect: () => set({ enabled: !sc.enabled }), disabled: !multi && sc.enabled },
            {
              label: "Delete scenario",
              icon: "trash",
              danger: true,
              disabled: !multi,
              onSelect: () => {
                const rest = c.scenarios.filter((s) => s.id !== sc.id);
                onChange({ ...c, scenarios: rest });
                onScenario(rest[0]!.id);
              },
            },
          ]}
        />
      </div>
      {sc.kind === "mix" && <p className="mt-1.5 text-micro text-text4">Weights set each step's share. Groups and pauses aren't part of a mix.</p>}
      {sc.kind === "flow" && (
        <ThinkDefault value={sc.think} onChange={(think) => set({ think })} />
      )}
    </div>
  );
}

function ThinkDefault({ value, onChange }: { value: ThinkTime | null; onChange: (t: ThinkTime | null) => void }) {
  return (
    <label className="mt-1.5 flex items-center gap-2 text-micro text-text3">
      <input type="checkbox" className="size-3" checked={!!value} onChange={(e) => onChange(e.target.checked ? { kind: "uniform", min_ms: 500, max_ms: 1500 } : null)} />
      Think time after each request
      {value?.kind === "uniform" && (
        <span className="tabular font-mono text-text2">
          {value.min_ms}–{value.max_ms} ms
        </span>
      )}
    </label>
  );
}

function ThinkEditor({ value, onChange }: { value: ThinkTime; onChange: (t: ThinkTime) => void }) {
  return (
    <div className="space-y-3">
      <Segmented
        aria-label="Think time distribution"
        value={value.kind}
        onChange={(kind) =>
          onChange(kind === "fixed" ? { kind, ms: 1000 } : kind === "uniform" ? { kind, min_ms: 500, max_ms: 1500 } : { kind, mean_ms: 1000, sd_ms: 250 })
        }
        options={[
          { value: "fixed", label: "Fixed" },
          { value: "uniform", label: "Between" },
          { value: "normal", label: "Around" },
        ]}
      />
      <div className="grid max-w-md grid-cols-2 gap-3">
        {value.kind === "fixed" && <Field label="Wait">{(id) => <NumberInput id={id} suffix="ms" value={value.ms} onChange={(v) => onChange({ ...value, ms: v ?? 0 })} />}</Field>}
        {value.kind === "uniform" && (
          <>
            <Field label="At least">{(id) => <NumberInput id={id} suffix="ms" value={value.min_ms} onChange={(v) => onChange({ ...value, min_ms: v ?? 0 })} />}</Field>
            <Field label="At most">{(id) => <NumberInput id={id} suffix="ms" value={value.max_ms} onChange={(v) => onChange({ ...value, max_ms: v ?? 0 })} />}</Field>
          </>
        )}
        {value.kind === "normal" && (
          <>
            <Field label="Mean">{(id) => <NumberInput id={id} suffix="ms" value={value.mean_ms} onChange={(v) => onChange({ ...value, mean_ms: v ?? 0 })} />}</Field>
            <Field label="Std. deviation">{(id) => <NumberInput id={id} suffix="ms" value={value.sd_ms} onChange={(v) => onChange({ ...value, sd_ms: v ?? 0 })} />}</Field>
          </>
        )}
      </div>
      <p className="text-small text-text3">Not counted in latency; counted in iteration time.</p>
    </div>
  );
}

function PauseEditor({ config, item, onChange }: { config: TestConfig; item: Extract<FlowItem, { kind: "pause" }>; onChange: (c: TestConfig) => void }) {
  const set = (patch: Partial<typeof item.pause>) => onChange(updateItem(config, item.pause.id, (it) => (it.kind === "pause" ? { ...it, pause: { ...it.pause, ...patch } } : it)));
  return (
    <div className="space-y-6 overflow-y-auto px-6 py-5">
      <h2 className="text-title font-semibold">Pause</h2>
      <ThinkEditor value={item.pause.think} onChange={(think) => set({ think })} />
      <section className="border-t border-line pt-4">
        <h3 className="mb-2 text-body font-semibold">Run if</h3>
        <RunIfEditor value={item.pause.run_if} onChange={(run_if) => set({ run_if })} what="pause" />
      </section>
    </div>
  );
}

function GroupEditor({ config, item, onChange, errors, onAddMember }: { config: TestConfig; item: Extract<FlowItem, { kind: "group" }>; onChange: (c: TestConfig) => void; errors: Errors; onAddMember: () => void }) {
  const g = item.group;
  const set = (patch: Partial<typeof g>) => onChange(updateItem(config, g.id, (it) => (it.kind === "group" ? { ...it, group: { ...it.group, ...patch } } : it)));
  return (
    <div className="space-y-5 overflow-y-auto px-6 py-5">
      <div>
        <input className="input h-8 max-w-80 border-transparent bg-transparent px-1.5 text-title font-semibold hover:border-line2" placeholder="Parallel group" aria-label="Group name" value={g.name} onChange={(e) => set({ name: e.target.value })} />
        <p className="mt-1 text-body text-text3">
          {g.steps.length} requests start together; the group ends when the last one finishes. Members can't read each other's extracted values. Its time in the analysis is the slowest member.
        </p>
      </div>
      <button type="button" className="btn btn-sm" onClick={onAddMember}>
        <Icon name="plus" className="size-3" /> Add a request to the group
      </button>
      <section className="border-t border-line pt-4">
        <h3 className="mb-2 text-body font-semibold">Run if</h3>
        <RunIfEditor value={g.run_if} onChange={(run_if) => set({ run_if })} what="group" error={errors[`group:${g.id}.run_if`]} />
      </section>
    </div>
  );
}

function CurlDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (s: RequestStep) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const parsed = text.trim() ? parseCurl(text) : null;
  return (
    <dialog ref={ref} onClose={onClose} className="floating animate-pop m-auto w-[640px] max-w-[calc(100vw-2rem)] p-0 text-text backdrop:bg-(--overlay) backdrop:backdrop-blur-[4px]">
      <form
        method="dialog"
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed && "step" in parsed) onAdd(parsed.step);
        }}
      >
        <h2 className="text-title font-semibold">Paste a cURL command</h2>
        <textarea
          autoFocus
          className="input h-40 font-mono text-small"
          spellCheck={false}
          placeholder={"curl -X POST https://api.example.com/login \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"user\":\"ada\"}'"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="cURL command"
        />
        {parsed && "error" in parsed && <p role="alert" className="text-small text-danger">{parsed.error}</p>}
        {parsed && "step" in parsed && (
          <div className="rounded-lg bg-raised px-3 py-2 text-small">
            <p className="font-mono text-text">
              {parsed.step.method} {parsed.step.url}
            </p>
            <p className="text-text3">
              {parsed.step.params.length} params · {parsed.step.headers.length} headers · body {parsed.step.body?.kind ?? "none"} · auth {parsed.step.auth.kind === "inherit" ? "test default" : parsed.step.auth.kind}
            </p>
            {parsed.ignored.length > 0 && <p className="mt-1 text-warning">Not imported: {parsed.ignored.join(", ")}</p>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!parsed || "error" in parsed}>
            Add step
          </button>
        </div>
      </form>
    </dialog>
  );
}

