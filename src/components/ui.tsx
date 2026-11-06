import { useId, type ReactNode } from "react";

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
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
  save: <path d="M5 4.5h11l3.5 3.5v11.5h-15zM8 4.5v5h7v-5M8 19.5v-6h8v6" />,
  file: <path d="M13.5 3.5H6.5v17h11V7.5zM13.5 3.5v4h4M9.5 12.5h5M9.5 16h5" />,
  back: <path d="M19 12H5m0 0 6-6m-6 6 6 6" />,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "size-3.5" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden focusable="false">
      {ICONS[name]}
    </svg>
  );
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
