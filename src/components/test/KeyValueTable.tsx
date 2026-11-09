import { useState } from "react";
import type { KeyValue } from "../../bindings";
import type { Name } from "../../lib/template";
import { TemplateInput } from "../TemplateInput";
import { Icon, IconButton } from "../ui";

/**
 * Rows of name/value pairs with on/off switches. Values (and optionally names) accept
 * templates; sensitive values are masked until revealed.
 */
export function KeyValueTable(props: {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  names: Name[];
  label: string;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  errors?: (i: number) => string | undefined;
  sensitive?: (name: string) => boolean;
  inherited?: { name: string; value: string }[];
  empty?: string;
  templateNames?: boolean;
}) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const set = (i: number, patch: Partial<KeyValue>) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => props.onChange([...props.rows, { name: "", value: "", enabled: true }]);
  const overridden = (n: string) => props.rows.some((r) => r.enabled && r.name.trim().toLowerCase() === n.toLowerCase());
  return (
    <div className="space-y-1.5">
      {props.inherited?.map((h) => (
        <div key={`inh-${h.name}`} className="flex items-center gap-1.5 text-text4" title="From the test's defaults (Data stage)">
          <span className="w-3.5 shrink-0" />
          <span className={`w-2/5 truncate px-2.5 font-mono text-small ${overridden(h.name) ? "line-through" : ""}`}>{h.name}</span>
          <span className="min-w-0 flex-1 truncate px-2.5 font-mono text-small">{props.sensitive?.(h.name) ? "••••••" : h.value}</span>
          <span className="w-7 shrink-0 text-right text-micro">{overridden(h.name) ? "overridden" : "default"}</span>
        </div>
      ))}
      {props.rows.length === 0 && !props.inherited?.length && props.empty && <p className="text-small text-text4">{props.empty}</p>}
      {props.rows.map((r, i) => {
        const err = props.errors?.(i);
        const masked = props.sensitive?.(r.name) && !shown.has(i);
        return (
          <div key={i}>
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="size-3.5 shrink-0"
                aria-label={`Send ${props.label} ${i + 1}`}
                checked={r.enabled}
                onChange={(e) => set(i, { enabled: e.target.checked })}
              />
              <div className="w-2/5 shrink-0">
                {props.templateNames ? (
                  <TemplateInput value={r.name} onChange={(v) => set(i, { name: v })} names={props.names} placeholder={props.namePlaceholder ?? "Name"} aria-label={`${props.label} ${i + 1} name`} invalid={!!err} />
                ) : (
                  <input
                    className="input font-mono"
                    spellCheck={false}
                    placeholder={props.namePlaceholder ?? "Name"}
                    aria-label={`${props.label} ${i + 1} name`}
                    aria-invalid={!!err || undefined}
                    value={r.name}
                    onChange={(e) => set(i, { name: e.target.value })}
                  />
                )}
              </div>
              {masked ? (
                <input className="input min-w-0 flex-1 font-mono" type="password" aria-label={`${props.label} ${i + 1} value`} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
              ) : (
                <TemplateInput value={r.value} onChange={(v) => set(i, { value: v })} names={props.names} placeholder={props.valuePlaceholder ?? "Value"} aria-label={`${props.label} ${i + 1} value`} />
              )}
              {props.sensitive?.(r.name) && (
                <IconButton
                  icon="lock"
                  size="sm"
                  label={masked ? `Show ${props.label} ${i + 1}` : `Hide ${props.label} ${i + 1}`}
                  onClick={() => setShown((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set(s).add(i)))}
                />
              )}
              <IconButton icon="x" size="sm" label={`Remove ${props.label} ${i + 1}`} onClick={() => props.onChange(props.rows.filter((_, j) => j !== i))} />
            </div>
            {err && (
              <p role="alert" className="mt-1 ml-5 text-small text-danger">
                {err}
              </p>
            )}
          </div>
        );
      })}
      <button type="button" className="btn btn-ghost btn-sm -ml-2" onClick={add}>
        <Icon name="plus" className="size-3" /> {props.addLabel ?? `Add ${props.label}`}
      </button>
    </div>
  );
}
