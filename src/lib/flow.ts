// Walking and editing a test's steps. Every helper returns a new config (no mutation).
import type { FlowItem, RequestStep, Scenario, StepPhase, TestConfig } from "../bindings";
import { uid } from "./defaults";

export type Where = "setup" | "teardown" | { scenario: string; list: "init" | "steps" };

export type StepRef = {
  step: RequestStep;
  phase: StepPhase;
  scenario: Scenario | null;
  groupId: string | null;
  where: Where;
};

export function itemSteps(item: FlowItem): RequestStep[] {
  if (item.kind === "request") return [item.step];
  if (item.kind === "group") return item.group.steps;
  return [];
}

export function itemId(item: FlowItem): string {
  return item.kind === "request" ? item.step.id : item.kind === "group" ? item.group.id : item.pause.id;
}

/** Every request step in run order: setup, each scenario's init then steps, teardown. */
export function allSteps(c: TestConfig, enabledOnly = false): StepRef[] {
  const out: StepRef[] = c.setup.map((step) => ({ step, phase: "setup", scenario: null, groupId: null, where: "setup" }));
  for (const sc of c.scenarios) {
    if (enabledOnly && !sc.enabled) continue;
    for (const list of ["init", "steps"] as const) {
      for (const item of sc[list]) {
        const groupId = item.kind === "group" ? item.group.id : null;
        for (const step of itemSteps(item)) {
          out.push({ step, phase: list === "init" ? "init" : "main", scenario: sc, groupId, where: { scenario: sc.id, list } });
        }
      }
    }
  }
  for (const step of c.teardown) out.push({ step, phase: "teardown", scenario: null, groupId: null, where: "teardown" });
  return out;
}

export const findStep = (c: TestConfig, id: string) => allSteps(c).find((r) => r.step.id === id) ?? null;

export function stepLabel(s: RequestStep): string {
  if (s.name.trim()) return s.name.trim();
  const url = s.url.trim();
  const m = url.match(/^[a-z]+:\/\/[^/]*(\/.*)?$/i);
  const path = m ? (m[1] ?? "/") : url || "(no URL)";
  return `${s.method} ${path}`;
}

function mapItems(items: FlowItem[], id: string, fn: (s: RequestStep) => RequestStep): FlowItem[] {
  return items.map((it) => {
    if (it.kind === "request") return it.step.id === id ? { ...it, step: fn(it.step) } : it;
    if (it.kind === "group" && it.group.steps.some((s) => s.id === id))
      return { ...it, group: { ...it.group, steps: it.group.steps.map((s) => (s.id === id ? fn(s) : s)) } };
    return it;
  });
}

export function updateStep(c: TestConfig, id: string, fn: (s: RequestStep) => RequestStep): TestConfig {
  return {
    ...c,
    setup: c.setup.map((s) => (s.id === id ? fn(s) : s)),
    teardown: c.teardown.map((s) => (s.id === id ? fn(s) : s)),
    scenarios: c.scenarios.map((sc) => ({ ...sc, init: mapItems(sc.init, id, fn), steps: mapItems(sc.steps, id, fn) })),
  };
}

export function updateScenario(c: TestConfig, id: string, fn: (s: Scenario) => Scenario): TestConfig {
  return { ...c, scenarios: c.scenarios.map((s) => (s.id === id ? fn(s) : s)) };
}

export function updateItem(c: TestConfig, id: string, fn: (it: FlowItem) => FlowItem): TestConfig {
  return {
    ...c,
    scenarios: c.scenarios.map((sc) => ({
      ...sc,
      init: sc.init.map((it) => (itemId(it) === id ? fn(it) : it)),
      steps: sc.steps.map((it) => (itemId(it) === id ? fn(it) : it)),
    })),
  };
}

/** Remove a step, group or pause wherever it lives. An emptied group is removed too. */
export function removeById(c: TestConfig, id: string): TestConfig {
  const strip = (items: FlowItem[]) =>
    items
      .filter((it) => itemId(it) !== id)
      .map((it) => (it.kind === "group" ? { ...it, group: { ...it.group, steps: it.group.steps.filter((s) => s.id !== id) } } : it))
      .filter((it) => it.kind !== "group" || it.group.steps.length > 0);
  return {
    ...c,
    setup: c.setup.filter((s) => s.id !== id),
    teardown: c.teardown.filter((s) => s.id !== id),
    scenarios: c.scenarios.map((sc) => ({ ...sc, init: strip(sc.init), steps: strip(sc.steps) })),
  };
}

export function cloneStep(s: RequestStep): RequestStep {
  return {
    ...structuredClone(s),
    id: uid("r"),
    name: s.name ? `${s.name} (copy)` : "",
    extract: s.extract.map((e) => ({ ...e, id: uid("x") })),
    checks: s.checks.map((k) => ({ ...k, id: uid("c") })),
  };
}

/** Duplicate a step right after itself. Returns the config and the copy's id. */
export function duplicateStep(c: TestConfig, id: string): [TestConfig, string] {
  const ref = findStep(c, id);
  if (!ref) return [c, id];
  const copy = cloneStep(ref.step);
  const after = (list: RequestStep[]) => list.flatMap((s) => (s.id === id ? [s, copy] : [s]));
  const afterItems = (items: FlowItem[]): FlowItem[] =>
    items.flatMap((it) => {
      if (it.kind === "request" && it.step.id === id) return [it, { kind: "request", step: copy } as FlowItem];
      if (it.kind === "group" && it.group.steps.some((s) => s.id === id)) return [{ ...it, group: { ...it.group, steps: after(it.group.steps) } }];
      return [it];
    });
  return [
    {
      ...c,
      setup: after(c.setup),
      teardown: after(c.teardown),
      scenarios: c.scenarios.map((sc) => ({ ...sc, init: afterItems(sc.init), steps: afterItems(sc.steps) })),
    },
    copy.id,
  ];
}

/** Move an item (or a setup/teardown step) one place up or down within its list. */
export function moveById(c: TestConfig, id: string, delta: -1 | 1): TestConfig {
  const move = <T,>(list: T[], idOf: (t: T) => string): T[] => {
    const i = list.findIndex((t) => idOf(t) === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  };
  const moveItems = (items: FlowItem[]): FlowItem[] => {
    if (items.some((it) => itemId(it) === id)) return move(items, itemId);
    return items.map((it) => (it.kind === "group" ? { ...it, group: { ...it.group, steps: move(it.group.steps, (s) => s.id) } } : it));
  };
  return {
    ...c,
    setup: move(c.setup, (s) => s.id),
    teardown: move(c.teardown, (s) => s.id),
    scenarios: c.scenarios.map((sc) => ({ ...sc, init: moveItems(sc.init), steps: moveItems(sc.steps) })),
  };
}

/** Insert items into a list (append, or after `afterId`). */
export function insertItems(c: TestConfig, where: Where, items: FlowItem[], afterId?: string): TestConfig {
  if (where === "setup" || where === "teardown") {
    const steps = items.flatMap(itemSteps);
    const list = c[where];
    const i = afterId ? list.findIndex((s) => s.id === afterId) : -1;
    const next = i < 0 ? [...list, ...steps] : [...list.slice(0, i + 1), ...steps, ...list.slice(i + 1)];
    return { ...c, [where]: next };
  }
  return updateScenario(c, where.scenario, (sc) => {
    const list = sc[where.list];
    const i = afterId ? list.findIndex((it) => itemId(it) === afterId || itemSteps(it).some((s) => s.id === afterId)) : -1;
    const next = i < 0 ? [...list, ...items] : [...list.slice(0, i + 1), ...items, ...list.slice(i + 1)];
    return { ...sc, [where.list]: next };
  });
}

/** Variables extracted by steps before `stepId` (in run order, honouring parallel groups). */
export function extractedBefore(c: TestConfig, stepId: string | null): { name: string; from: string }[] {
  const out: { name: string; from: string }[] = [];
  const add = (s: RequestStep) => s.extract.filter((e) => e.enabled && e.var.trim()).forEach((e) => out.push({ name: e.var.trim(), from: stepLabel(s) }));
  const ref = stepId ? findStep(c, stepId) : null;
  for (const s of c.setup) {
    if (s.id === stepId) return out;
    add(s);
  }
  if (ref?.phase === "teardown") return out;
  const sc = ref?.scenario;
  if (!sc) return out;
  for (const list of ["init", "steps"] as const) {
    for (const it of sc[list]) {
      const steps = itemSteps(it);
      if (steps.some((s) => s.id === stepId)) return out;
      if (sc.kind === "flow" || list === "init") steps.forEach(add);
    }
  }
  return out;
}

export const scenarioOf = (c: TestConfig, stepId: string) => findStep(c, stepId)?.scenario ?? null;

export const stepCount = (sc: Scenario) => sc.steps.reduce((n, it) => n + itemSteps(it).length, 0);
