import { useId, type ReactNode } from "react";

export function Field(props: { label: string; error?: string | null | undefined; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={props.className}>
      <label htmlFor={id} className="label">
        {props.label}
      </label>
      {props.children(id)}
      {props.error ? (
        <p role="alert" className="mt-1 text-xs text-critical">
          {props.error}
        </p>
      ) : props.hint ? (
        <p className="mt-1 text-xs text-ink-3">{props.hint}</p>
      ) : null}
    </div>
  );
}

export function NumberInput(props: {
  id?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  onBlur?: () => void;
  min?: number;
  max?: number;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  suffix?: string;
  "aria-label"?: string;
}) {
  return (
    <div className="relative">
      <input
        id={props.id}
        type="number"
        inputMode="numeric"
        className="input tabular pr-10"
        value={props.value ?? ""}
        min={props.min}
        max={props.max}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
        aria-label={props["aria-label"]}
        onBlur={props.onBlur}
        onChange={(e) => {
          const raw = e.target.value.trim();
          props.onChange(raw === "" ? null : Number(raw));
        }}
      />
      {props.suffix && (
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-ink-3">{props.suffix}</span>
      )}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 select-none">
      <input
        type="checkbox"
        className="mt-0.5 size-3.5 accent-[var(--c-accent)]"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>
        <span className="text-ink">{props.label}</span>
        {props.hint && <span className="block text-xs text-ink-3">{props.hint}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; "aria-label": string }) {
  return (
    <div role="radiogroup" aria-label={props["aria-label"]} className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          disabled={props.disabled}
          onClick={() => props.onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium ${props.value === o.value ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wide text-ink-2 uppercase">{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

export function Stat(props: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "critical" }) {
  const tone = props.tone === "good" ? "text-good-text" : props.tone === "critical" ? "text-critical" : "text-ink";
  return (
    <div className="card px-3 py-2.5">
      <div className="text-xs text-ink-2">{props.label}</div>
      <div className={`tabular mt-0.5 text-xl font-semibold ${tone}`}>{props.value}</div>
      {props.sub && <div className="tabular text-xs text-ink-3">{props.sub}</div>}
    </div>
  );
}
