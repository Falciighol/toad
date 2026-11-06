import { useMemo, useState } from "react";
import type { BodyKind, Header, Method, RequestSpec } from "../bindings";
import { isSensitiveHeader, validateRequest } from "../lib/validate";
import { Field, Section, Segmented } from "./ui";

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

type Props = {
  value: RequestSpec;
  onChange: (r: RequestSpec) => void;
  /** Reveal every error (e.g. after a Start attempt), not just touched fields. */
  showAllErrors?: boolean;
  disabled?: boolean;
};

function SecretInput(props: { value: string; onChange: (v: string) => void; placeholder?: string; id?: string; label: string; disabled?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-1">
      <input
        id={props.id}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className="input font-mono"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <button type="button" className="btn px-2 text-xs" onClick={() => setShown((s) => !s)} aria-label={shown ? `Hide ${props.label}` : `Show ${props.label}`}>
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function RequestForm({ value, onChange, showAllErrors = false, disabled = false }: Props) {
  const errors = useMemo(() => validateRequest(value), [value]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const touch = (k: string) => setTouched((t) => (t.has(k) ? t : new Set(t).add(k)));
  const err = (k: string) => (showAllErrors || touched.has(k) ? errors[k] : undefined);

  const set = (patch: Partial<RequestSpec>) => onChange({ ...value, ...patch });
  const setHeader = (i: number, patch: Partial<Header>) =>
    set({ headers: value.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  const bodyKind: BodyKind | "none" = value.body?.kind ?? "none";

  const formatJson = () => {
    if (!value.body) return;
    try {
      set({ body: { ...value.body, content: JSON.stringify(JSON.parse(value.body.content), null, 2) } });
    } catch {
      touch("request.body");
    }
  };

  return (
    <Section title="Request">
      <fieldset disabled={disabled} className="space-y-3">
        <Field label="URL" error={err("request.url")}>
          {(id) => (
            <div className="flex gap-1.5">
              <select
                aria-label="Method"
                className="input w-28 font-mono font-semibold"
                value={value.method}
                onChange={(e) => set({ method: e.target.value as Method })}
              >
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input
                id={id}
                className="input font-mono"
                spellCheck={false}
                placeholder="http://localhost:8080/api"
                value={value.url}
                aria-invalid={!!err("request.url") || undefined}
                onChange={(e) => set({ url: e.target.value })}
                onBlur={() => touch("request.url")}
              />
            </div>
          )}
        </Field>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="label mb-0">Headers</span>
            <button
              type="button"
              className="btn px-2 py-0.5 text-xs"
              onClick={() => set({ headers: [...value.headers, { name: "", value: "", enabled: true }] })}
            >
              + Add header
            </button>
          </div>
          {value.headers.length === 0 && <p className="text-xs text-ink-3">No headers.</p>}
          <div className="space-y-1.5">
            {value.headers.map((h, i) => {
              const key = `request.headers.${i}`;
              const sensitive = isSensitiveHeader(h.name);
              return (
                <div key={i}>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Enable header ${i + 1}`}
                      className="size-3.5 accent-[var(--c-accent)]"
                      checked={h.enabled}
                      onChange={(e) => setHeader(i, { enabled: e.target.checked })}
                    />
                    <input
                      className="input w-2/5 font-mono"
                      placeholder="Name"
                      aria-label={`Header ${i + 1} name`}
                      spellCheck={false}
                      value={h.name}
                      aria-invalid={!!err(key) || undefined}
                      onChange={(e) => setHeader(i, { name: e.target.value })}
                      onBlur={() => touch(key)}
                    />
                    <div className="flex-1">
                      {sensitive ? (
                        <SecretInput label={`Header ${i + 1} value`} value={h.value} onChange={(v) => setHeader(i, { value: v })} placeholder="Value" />
                      ) : (
                        <input
                          className="input font-mono"
                          placeholder="Value"
                          aria-label={`Header ${i + 1} value`}
                          spellCheck={false}
                          value={h.value}
                          onChange={(e) => setHeader(i, { value: e.target.value })}
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn px-2 text-ink-3"
                      aria-label={`Remove header ${i + 1}`}
                      onClick={() => set({ headers: value.headers.filter((_, j) => j !== i) })}
                    >
                      ×
                    </button>
                  </div>
                  {err(key) && (
                    <p role="alert" className="mt-1 ml-5 text-xs text-critical">
                      {err(key)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <Field
          label="Bearer token"
          error={err("request.bearer")}
          hint={<>Sent as <code>Authorization: Bearer …</code>. Saved tests store it in plain text on this machine.</>}
        >
          {(id) => (
            <SecretInput
              id={id}
              label="Bearer token"
              value={value.bearer ?? ""}
              placeholder="Optional"
              onChange={(v) => set({ bearer: v === "" ? null : v })}
            />
          )}
        </Field>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="label mb-0">Body</span>
            <div className="flex items-center gap-2">
              {bodyKind === "json" && (
                <button type="button" className="btn px-2 py-0.5 text-xs" onClick={formatJson}>
                  Format
                </button>
              )}
              <Segmented
                aria-label="Body type"
                value={bodyKind}
                options={[
                  { value: "none", label: "None" },
                  { value: "json", label: "JSON" },
                  { value: "text", label: "Text" },
                ]}
                onChange={(k) => set({ body: k === "none" ? null : { kind: k, content: value.body?.content ?? "" } })}
              />
            </div>
          </div>
          {value.body && (
            <>
              <textarea
                aria-label="Request body"
                className="input h-28 resize-y font-mono text-xs"
                spellCheck={false}
                value={value.body.content}
                placeholder={value.body.kind === "json" ? '{ "key": "value" }' : "Raw text body"}
                aria-invalid={!!err("request.body") || undefined}
                onChange={(e) => set({ body: { kind: value.body!.kind, content: e.target.value } })}
                onBlur={() => touch("request.body")}
              />
              {err("request.body") ? (
                <p role="alert" className="mt-1 text-xs text-critical">
                  {err("request.body")}
                </p>
              ) : value.body.kind === "json" ? (
                <p className="mt-1 text-xs text-ink-3">Content-Type: application/json is added unless you set one.</p>
              ) : null}
            </>
          )}
        </div>
      </fieldset>
    </Section>
  );
}
