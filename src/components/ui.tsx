import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/* One authored icon family: 24-unit grid, 2px round strokes, currentColor. */
const ICONS = {
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  alert: (
    <>
      <path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4M12 17h.01" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
      <path d="M10 11v5.5M14 11v5.5" />
    </>
  ),
  download: <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />,
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  arrowUp: <path d="M12 19V5m0 0-6 6m6-6 6 6" />,
  arrowDown: <path d="M12 5v14m0 0-6-6m6 6 6-6" />,
  arrowRight: <path d="M5 12h14m0 0-6-6m6 6-6 6" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
  save: <path d="M5 4.5h11l3.5 3.5v11.5h-15zM8 4.5v5h7v-5M8 19.5v-6h8v6" />,
  file: <path d="M13.5 3.5H6.5v17h11V7.5zM13.5 3.5v4h4M9.5 12.5h5M9.5 16h5" />,
  back: <path d="M19 12H5m0 0 6-6m-6 6 6 6" />,
  flow: (
    <>
      <rect x="4" y="3.5" width="8" height="5" rx="1.5" />
      <rect x="12" y="15.5" width="8" height="5" rx="1.5" />
      <path d="M8 8.5v3.5a2 2 0 0 0 2 2h6v1.5" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </>
  ),
  load: <path d="M3.5 19.5h17M5 16l4-5 4 2.5 6-8" />,
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  review: (
    <>
      <rect x="5" y="4" width="14" height="16.5" rx="2" />
      <path d="M9 4V3h6v1M8.5 10.5h7M8.5 14h7M8.5 17.5h4" />
    </>
  ),
  branch: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="8.5" r="2" />
      <path d="M6.5 7.5v9M17.5 10.5c0 4-4.5 3.5-9 6.5" />
    </>
  ),
  parallel: <path d="M5 4.5v15M12 4.5v15M19 4.5v15M3 4.5h18M3 19.5h18" />,
  pause: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1" fill="currentColor" />
    </>
  ),
  upload: <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15v4.5h14V15" />,
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5" />
    </>
  ),
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  timeline: <path d="M3.5 19.5h17M6 16V9M10 16V5M14 16v-6M18 16v-3" />,
  layers: <path d="m12 4 8.5 4.5L12 13 3.5 8.5zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5" />,
  terminal: <path d="m5 7.5 4.5 4.5L5 16.5M12 17h7" />,
  minus: <path d="M5 12h14" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "size-3.5" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden focusable="false">
      {ICONS[name]}
    </svg>
  );
}

/** Small indeterminate ring, sized like an icon; inherits the text color. */
export function Spinner({ className = "size-3.5" }: { className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`} />;
}

export function Field(props: {
  label: string;
  /** Marks the field as optional with a quiet tag; required fields carry no marker. */
  optional?: boolean;
  error?: string | null | undefined;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={props.className}>
      <label htmlFor={id} className="label">
        {props.label}
        {props.optional && <span className="ml-1.5 font-normal text-text4">Optional</span>}
      </label>
      {props.children(id)}
      {props.error ? (
        <p role="alert" className="mt-1.5 text-small text-danger">
          {props.error}
        </p>
      ) : props.hint ? (
        <p className="mt-1.5 text-small text-text3">{props.hint}</p>
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
        className="input tabular pr-10 font-mono"
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
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-small text-text4">{props.suffix}</span>
      )}
    </div>
  );
}

/**
 * A number with its unit picked from a dropdown joined to the input's right edge
 * ("30 [/min ▾]"). The value is in the selected unit; callers convert.
 */
export function UnitNumberInput<U extends string>(props: {
  id?: string;
  value: number | string | null;
  onChange: (raw: string) => void;
  onBlur?: () => void;
  unit: U;
  units: { value: U; label: string; title?: string }[];
  onUnit: (u: U) => void;
  min?: number;
  step?: number | "any";
  invalid?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  unitLabel?: string;
}) {
  return (
    <div className="flex min-w-0">
      <input
        id={props.id}
        type="number"
        inputMode={props.step === "any" ? "decimal" : "numeric"}
        className="input tabular min-w-0 flex-1 rounded-r-none font-mono"
        value={props.value ?? ""}
        min={props.min}
        step={props.step}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
        aria-label={props["aria-label"]}
        onBlur={props.onBlur}
        onChange={(e) => props.onChange(e.target.value.trim())}
      />
      <select
        className="input -ml-px w-auto! shrink-0 rounded-l-none pl-2 text-small text-text2"
        aria-label={props.unitLabel ?? `${props["aria-label"] ?? "Value"} unit`}
        value={props.unit}
        disabled={props.disabled}
        onChange={(e) => props.onUnit(e.target.value as U)}
      >
        {props.units.map((u) => (
          <option key={u.value} value={u.value} title={u.title}>
            {u.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export type DurationUnit = "s" | "min" | "h";
const DURATION_UNITS: { value: DurationUnit; label: string; title: string; secs: number }[] = [
  { value: "s", label: "s", title: "seconds", secs: 1 },
  { value: "min", label: "min", title: "minutes", secs: 60 },
  { value: "h", label: "h", title: "hours", secs: 3600 },
];
const unitSecs = (u: DurationUnit) => DURATION_UNITS.find((x) => x.value === u)!.secs;
/** Shows cleanly in this unit: at most two decimals (90 s → 1.5 min, not 37 s → 0.6167 min). */
const fitsUnit = (secs: number, u: DurationUnit) => {
  const x = (secs / unitSecs(u)) * 100;
  return Math.abs(x - Math.round(x)) < 1e-6;
};
/** The largest allowed unit that holds the value exactly: 7200 → h, 90 → s. */
export function inferDurationUnit(secs: number, allowed: readonly DurationUnit[] = ["s", "min", "h"]): DurationUnit {
  const fits = [...allowed].reverse().find((u) => secs > 0 && secs % unitSecs(u) === 0);
  return fits ?? allowed[0] ?? "s";
}

/**
 * A length of time stored in whole seconds, entered in seconds, minutes or hours. The unit
 * starts as the largest that holds the value exactly and then follows the dropdown. Changing
 * the unit keeps the typed number (30 s → 30 min), like picking the unit for what you typed.
 */
export function DurationInput(props: {
  id?: string;
  /** Seconds. */
  value: number;
  onChange: (secs: number | null) => void;
  units?: readonly DurationUnit[];
  /** Seconds. */
  min?: number;
  invalid?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const allowed = props.units ?? (["s", "min", "h"] as const);
  const [chosen, setChosen] = useState<DurationUnit | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // While typing, the picked unit holds; afterwards a value it can't show cleanly (a chart drag
  // to 37 s under "min") falls back to the unit that can.
  const unit = chosen && allowed.includes(chosen) && (draft !== null || fitsUnit(props.value, chosen)) ? chosen : inferDurationUnit(props.value, allowed);
  const per = unitSecs(unit);
  const shown = draft ?? String(Math.round((props.value / per) * 10000) / 10000);
  return (
    <UnitNumberInput
      id={props.id}
      aria-label={props["aria-label"]}
      unitLabel={props["aria-label"] ? `${props["aria-label"]} unit` : "Time unit"}
      value={shown}
      min={props.min !== undefined ? props.min / per : undefined}
      step={per === 1 ? 1 : "any"}
      invalid={props.invalid}
      disabled={props.disabled}
      unit={unit}
      units={DURATION_UNITS.filter((u) => allowed.includes(u.value))}
      onBlur={() => setDraft(null)}
      onChange={(raw) => {
        setDraft(raw);
        setChosen(unit);
        props.onChange(raw === "" || !Number.isFinite(Number(raw)) ? null : Math.round(Number(raw) * per));
      }}
      onUnit={(u) => {
        const n = Number(shown);
        setChosen(u);
        setDraft(null);
        if (Number.isFinite(n)) props.onChange(Math.round(n * unitSecs(u)));
      }}
    />
  );
}

/** An on/off setting: the label and a text-3 hint, with Saga's 26×16 switch at the right. */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 ${props.disabled ? "opacity-45" : ""}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-body text-text">{props.label}</span>
        {props.hint && <span className="block text-small text-text3">{props.hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={`relative mt-px h-4 w-6.5 shrink-0 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${props.checked ? "bg-accent" : "bg-raised2 ring-1 ring-line2 ring-inset"}`}
      >
        <span className={`absolute top-0.5 left-0.5 size-3 rounded-full transition-transform duration-150 ${props.checked ? "translate-x-2.5 bg-on-accent" : "bg-text3"}`} />
      </span>
    </label>
  );
}

/** Two to four choices in a raised track, the chosen one on `seg`. For settings and for views. */
export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string | undefined }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  "aria-label": string;
}) {
  const sm = props.size === "sm";
  return (
    <div role="radiogroup" aria-label={props["aria-label"]} className="inline-flex shrink-0 gap-0.5 rounded-lg bg-raised2 p-0.75">
      {props.options.map((o) => {
        const on = props.value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            disabled={props.disabled || o.disabled}
            onClick={() => props.onChange(o.value)}
            className={`flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-45 ${sm ? "h-5.5 px-2 text-small" : "h-6.5 px-3 text-body"} ${on ? "bg-seg text-text shadow-[0_1px_2px_rgb(0_0_0/0.12)]" : "text-text3 enabled:hover:text-text"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** An icon-only button with a tooltip and an accessible name. */
export function IconButton(props: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; className?: string; size?: "sm" | "md"; danger?: boolean }) {
  const sm = props.size === "sm";
  return (
    <button
      type="button"
      className={`btn btn-ghost ${sm ? "h-6 w-6" : "h-7 w-7"} px-0 ${props.danger ? "btn-danger-text" : ""} ${props.className ?? ""}`}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} className={sm ? "size-3.5" : "size-4"} />
    </button>
  );
}

/** Underlined tabs for switching a panel's content. Counts and dots sit after the label. */
export function Tabs<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: string; count?: number; dot?: "danger" | "accent" | null }[];
  "aria-label": string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={props["aria-label"]} className={`flex gap-4 border-b border-line ${props.className ?? ""}`}>
      {props.tabs.map((t) => {
        const on = t.value === props.value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => props.onChange(t.value)}
            className={`-mb-px flex h-8.5 items-center gap-1.5 border-b-2 text-body font-medium whitespace-nowrap transition-colors ${on ? "border-accent text-text" : "border-transparent text-text3 hover:text-text"}`}
          >
            {t.label}
            {t.count ? <span className="tabular rounded-full bg-raised2 px-1.5 font-mono text-micro text-text3">{t.count}</span> : null}
            {t.dot && <span aria-label={t.dot === "danger" ? "has errors" : "set"} className={`size-1.5 rounded-full ${t.dot === "danger" ? "bg-danger-fill" : "bg-accent"}`} />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Floating panel anchored to an element. Rendered in a portal with fixed positioning so
 * scroll containers never clip it. Closes on Escape and on a click outside.
 */
export function Popover(props: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; children: ReactNode; align?: "start" | "end"; width?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!props.open || !props.anchor.current) return;
    const place = () => {
      const r = props.anchor.current!.getBoundingClientRect();
      const w = props.width ?? 280;
      const left = props.align === "end" ? Math.max(8, r.right - w) : Math.min(r.left, window.innerWidth - w - 8);
      const up = r.bottom + 320 > window.innerHeight && r.top > 320;
      setPos({ top: up ? r.top - 6 : r.bottom + 6, left, up });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [props.open, props.anchor, props.align, props.width]);
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !props.anchor.current?.contains(t)) props.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [props.open, props.onClose, props.anchor]);
  if (!props.open || !pos) return null;
  return createPortal(
    <div
      ref={ref}
      className={`floating animate-pop fixed z-50 ${props.className ?? "p-1"}`}
      style={{ top: pos.top, left: pos.left, width: props.width ?? 280, transform: pos.up ? "translateY(-100%)" : undefined }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

/** A menu of actions in a popover. */
export function Menu(props: { label: string; icon?: IconName; trigger?: ReactNode; items: ({ label: string; hint?: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean } | "sep")[]; align?: "start" | "end"; className?: string; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.trigger ? undefined : props.label}
        title={props.trigger ? undefined : props.label}
        className={props.className ?? "btn btn-ghost h-7 w-7 px-0"}
        onClick={() => setOpen((o) => !o)}
      >
        {props.trigger ?? <Icon name={props.icon ?? "more"} className="size-4" />}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align={props.align ?? "end"} width={props.width ?? 240}>
        <div role="menu" aria-label={props.label}>
          {props.items.map((it, i) =>
            it === "sep" ? (
              <div key={i} className="my-1 h-px bg-line" role="separator" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-body enabled:hover:bg-raised disabled:opacity-45 ${it.danger ? "text-danger" : "text-text"}`}
              >
                {it.icon && <Icon name={it.icon} className="mt-0.5 size-3.5 text-text3" />}
                <span className="min-w-0 flex-1">
                  <span className="block">{it.label}</span>
                  {it.hint && <span className="block text-small text-text3">{it.hint}</span>}
                </span>
              </button>
            ),
          )}
        </div>
      </Popover>
    </>
  );
}

/** Quiet explanatory block for empty lists: what goes here and how to add it. */
export function Empty(props: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-start gap-1 rounded-xl border border-dashed border-line2 px-4 py-4">
      <div className="flex items-center gap-2 text-body font-medium text-text2">
        {props.icon && <Icon name={props.icon} className="size-4 text-text4" />}
        {props.title}
      </div>
      {props.children && <div className="text-small text-text3">{props.children}</div>}
      {props.action && <div className="mt-2">{props.action}</div>}
    </div>
  );
}

/** A labelled select with the shared input styling. */
export function Select<T extends string>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; "aria-label"?: string; id?: string; className?: string; disabled?: boolean }) {
  return (
    <select
      id={props.id}
      aria-label={props["aria-label"]}
      className={`input ${props.className ?? ""}`}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as T)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-title font-semibold text-text">{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

/** A card's heading inside the results (chart and breakdown titles). */
export function CardTitle(props: { children: ReactNode; className?: string }) {
  return <h3 className={`text-small font-medium text-text3 ${props.className ?? ""}`}>{props.children}</h3>;
}

/** A metric. Values are literal, so they're set in mono with tabular figures. */
export function Stat(props: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "critical" }) {
  const tone = props.tone === "good" ? "text-success" : props.tone === "critical" ? "text-danger" : "text-text";
  return (
    <div className="card px-4 py-3">
      <div className="text-small text-text3">{props.label}</div>
      <div className={`tabular mt-1 font-mono text-display font-medium ${tone}`}>{props.value}</div>
      {props.sub && <div className="tabular mt-0.5 font-mono text-small text-text4">{props.sub}</div>}
    </div>
  );
}

export type Tone = "neutral" | "accent" | "success" | "info" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-raised2 text-text3",
  accent: "bg-accent-soft text-accent-ink",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft font-semibold text-danger",
};

/** A state, as a tinted pill with an optional 12px icon first. */
export function Pill({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-small font-medium whitespace-nowrap [&_svg]:size-3 ${TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <kbd className={`rounded border border-line2 px-1.5 py-px font-mono text-micro font-medium text-text3 ${className}`}>{children}</kbd>;
}
