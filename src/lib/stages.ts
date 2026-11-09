// The test page's stages: which stage a field error belongs to, and each stage's summary line.
import type { FieldError, TestConfig } from "../bindings";
import { allSteps, stepCount } from "./flow";
import { fmtInt, fmtSecs } from "./format";
import { duration, fmtLevel, isOpen, maxVus, peak } from "./profile";

export type Stage = "flow" | "data" | "load" | "checks" | "review";
export const STAGES: Stage[] = ["flow", "data", "load", "checks", "review"];
export const STAGE_LABEL: Record<Stage, string> = { flow: "Flow", data: "Data", load: "Load", checks: "Checks", review: "Review" };

export function stageOf(field: string): Stage {
  if (field.startsWith("step:") || field.startsWith("group:") || field.startsWith("pause:") || field === "scenarios") return "flow";
  if (field.startsWith("scenario:")) return field.endsWith(".load") || field.endsWith(".graceful") ? "load" : "flow";
  if (field === "defaults.success_range") return "checks";
  if (field.startsWith("data:") || field.startsWith("env.") || field.startsWith("defaults.") || field === "data") return "data";
  if (field.startsWith("connection.")) return "load";
  if (field.startsWith("threshold:") || field === "warmup_secs") return "checks";
  return "flow";
}

export type Errors = Record<string, string>;

export function toErrors(fields: FieldError[]): Errors {
  const e: Errors = {};
  for (const f of fields) e[f.field] ??= f.message;
  return e;
}

export function errorsByStage(e: Errors): Record<Stage, number> {
  const out: Record<Stage, number> = { flow: 0, data: 0, load: 0, checks: 0, review: 0 };
  for (const k of Object.keys(e)) out[stageOf(k)]++;
  return out;
}

/** Errors under a prefix (a step, a scenario, a data file). */
export const errorsUnder = (e: Errors, prefix: string) => Object.entries(e).filter(([k]) => k === prefix || k.startsWith(`${prefix}.`));

const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

export function summary(c: TestConfig, stage: Stage, unconfirmed = 0): string {
  const enabled = c.scenarios.filter((s) => s.enabled);
  switch (stage) {
    case "flow": {
      const steps = allSteps(c, true).filter((r) => r.phase === "main").length;
      const groups = enabled.reduce((n, s) => n + s.steps.filter((i) => i.kind === "group").length, 0);
      const parts = [plural(steps, "step")];
      if (enabled.length > 1) parts.push(plural(enabled.length, "scenario"));
      if (groups) parts.push(plural(groups, "parallel group"));
      if (c.setup.length) parts.push("setup");
      return parts.join(" · ");
    }
    case "data": {
      const env = c.environments.find((e) => e.id === c.active_env);
      const parts = [];
      if (env) parts.push(env.name);
      if (c.variables.length) parts.push(plural(c.variables.length, "variable"));
      if (c.data.length) parts.push(plural(c.data.length, "file"));
      return parts.join(" · ") || "No variables";
    }
    case "load": {
      if (!enabled.length) return "No scenario on";
      if (enabled.length === 1) {
        const e = enabled[0]!.executor;
        const lvl = fmtLevel(e, isOpen(e) ? peak(e) : maxVus(e));
        return e.kind === "iterations" ? `${fmtInt(e.vus)} VUs · ${fmtInt(e.iterations)} iterations` : `${lvl} · ${fmtSecs(duration(e))}`;
      }
      const vus = enabled.reduce((n, s) => n + maxVus(s.executor), 0);
      return `${plural(enabled.length, "scenario")} · up to ${fmtInt(vus)} VUs`;
    }
    case "checks": {
      const n = c.thresholds.filter((t) => t.enabled).length;
      const checks = allSteps(c).reduce((k, r) => k + r.step.checks.filter((x) => x.enabled).length, 0);
      if (!n && !checks) return "No thresholds";
      return [n ? plural(n, "threshold") : "", checks ? plural(checks, "check") : ""].filter(Boolean).join(" · ");
    }
    case "review":
      return unconfirmed ? `${plural(unconfirmed, "host")} to confirm` : "Ready";
  }
}

export const scenarioStepCount = stepCount;
