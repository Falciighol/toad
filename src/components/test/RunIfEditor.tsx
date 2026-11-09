import type { Clause, ClauseOp, ClauseSubject, RunIf } from "../../bindings";
import { Icon, IconButton, Segmented, Select } from "../ui";

const OPS: Record<ClauseSubject, { value: ClauseOp; label: string }[]> = {
  variable: [
    { value: "exists", label: "exists" },
    { value: "missing", label: "is missing" },
    { value: "equals", label: "=" },
    { value: "not_equals", label: "≠" },
    { value: "matches", label: "matches regex" },
    { value: "gt", label: ">" },
    { value: "gte", label: "≥" },
    { value: "lt", label: "<" },
    { value: "lte", label: "≤" },
  ],
  prev_status: [
    { value: "equals", label: "=" },
    { value: "not_equals", label: "≠" },
    { value: "gte", label: "≥" },
    { value: "lt", label: "<" },
  ],
  prev_outcome: [
    { value: "ok", label: "succeeded" },
    { value: "failed", label: "failed" },
  ],
};

const needsValue = (op: ClauseOp) => !["exists", "missing", "ok", "failed"].includes(op);

export function runIfText(r: RunIf | null | undefined): string | null {
  if (!r || r.clauses.length === 0) return null;
  const parts = r.clauses.map((c) => {
    const subject = c.subject === "variable" ? c.name || "…" : c.subject === "prev_status" ? "previous status" : "previous step";
    const op = OPS[c.subject].find((o) => o.value === c.op)?.label ?? c.op;
    return needsValue(c.op) ? `${subject} ${op} ${c.value}` : `${subject} ${op}`;
  });
  return `if ${parts.join(r.mode === "all" ? " and " : " or ")}`;
}

/** Declarative condition: all or any of a few clauses. A false rule means "not taken". */
export function RunIfEditor({ value, onChange, error, what = "step" }: { value: RunIf | null; onChange: (r: RunIf | null) => void; error?: string; what?: string }) {
  if (!value) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-small text-text3">Always runs. Add a rule to run this {what} only when a variable or the previous step says so.</p>
        <button type="button" className="btn btn-sm" onClick={() => onChange({ mode: "all", clauses: [{ subject: "variable", name: "", op: "exists", value: "" }] })}>
          <Icon name="branch" className="size-3.5" /> Add rule
        </button>
      </div>
    );
  }
  const set = (i: number, patch: Partial<Clause>) => onChange({ ...value, clauses: value.clauses.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-small text-text2">
        Run this {what} when
        <Segmented
          size="sm"
          aria-label="Match"
          value={value.mode}
          onChange={(mode) => onChange({ ...value, mode })}
          options={[
            { value: "all", label: "all" },
            { value: "any", label: "any" },
          ]}
        />
        of these hold. Otherwise it's <span className="font-medium text-text">not taken</span>, which isn't an error.
      </div>
      {value.clauses.map((c, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select
            aria-label={`Rule ${i + 1} subject`}
            className="w-40! shrink-0"
            value={c.subject}
            onChange={(subject) => set(i, { subject, op: OPS[subject][0]!.value })}
            options={[
              { value: "variable", label: "Variable" },
              { value: "prev_status", label: "Previous status" },
              { value: "prev_outcome", label: "Previous step" },
            ]}
          />
          {c.subject === "variable" && (
            <input className="input w-40! shrink-0 font-mono" placeholder="name" aria-label={`Rule ${i + 1} variable`} value={c.name} onChange={(e) => set(i, { name: e.target.value })} />
          )}
          <Select aria-label={`Rule ${i + 1} comparison`} className="w-36! shrink-0" value={c.op} onChange={(op) => set(i, { op })} options={OPS[c.subject]} />
          {needsValue(c.op) ? (
            <input className="input min-w-0 flex-1 font-mono" placeholder="value" aria-label={`Rule ${i + 1} value`} value={c.value} onChange={(e) => set(i, { value: e.target.value })} />
          ) : (
            <span className="flex-1" />
          )}
          <IconButton icon="x" size="sm" label={`Remove rule ${i + 1}`} onClick={() => onChange(value.clauses.length > 1 ? { ...value, clauses: value.clauses.filter((_, j) => j !== i) } : null)} />
        </div>
      ))}
      {error && <p role="alert" className="text-small text-danger">{error}</p>}
      <button type="button" className="btn btn-ghost btn-sm -ml-2" onClick={() => onChange({ ...value, clauses: [...value.clauses, { subject: "variable", name: "", op: "exists", value: "" }] })}>
        <Icon name="plus" className="size-3" /> Add clause
      </button>
    </div>
  );
}
