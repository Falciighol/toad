import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { GENERATORS, openPlaceholder, tokenize, type Name } from "../lib/template";
import { Popover } from "./ui";

const SOURCE_LABEL: Record<Name["source"], string> = { env: "env", data: "data", extract: "extracted", builtin: "built-in", value: "value", base: "base URL" };

/** The text with {{placeholders}} coloured: variables in info, generators on a neutral fill, errors in danger. Mint stays for actions. */
function Highlight({ value, known }: { value: string; known: Set<string> | null }) {
  const tokens = useMemo(() => tokenize(value), [value]);
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === "lit") return <span key={i}>{t.text}</span>;
        if (t.kind === "var") {
          const unknown = known && !known.has(t.name);
          return (
            <span key={i} className={`rounded-sm ${unknown ? "bg-danger-soft text-danger" : "bg-info-soft text-info"}`}>
              {t.text}
            </span>
          );
        }
        if (t.kind === "gen") return <span key={i} className="rounded-sm bg-raised2 text-text2">{t.text}</span>;
        return <span key={i} className="rounded-sm bg-danger-soft text-danger underline decoration-wavy">{t.text}</span>;
      })}
      {"​"}
    </>
  );
}

type Option = { insert: string; label: string; detail: string; tag: string };

export function TemplateInput(props: {
  value: string;
  onChange: (v: string) => void;
  names: Name[];
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
  onBlur?: () => void;
  mono?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<[number, string] | null>(null);
  const [active, setActive] = useState(0);
  const known = useMemo(() => new Set(props.names.map((n) => n.name)), [props.names]);

  const options: Option[] = useMemo(() => {
    if (!open) return [];
    const q = open[1].trim().toLowerCase();
    if (q.startsWith("$")) {
      const g = q.slice(1);
      return GENERATORS.filter((x) => x.name.toLowerCase().startsWith(g)).map((x) => ({
        insert: `{{$${x.name}${x.args ? "(" : ""}`,
        label: `$${x.name}${x.args ? `(${x.args})` : ""}`,
        detail: x.doc,
        tag: "generator",
      }));
    }
    const vars = props.names
      .filter((n) => n.name.toLowerCase().includes(q))
      .map((n) => ({ insert: `{{${n.name}}}`, label: n.name, detail: n.detail, tag: SOURCE_LABEL[n.source] }));
    const gens = q ? [] : [{ insert: "{{$", label: "$generator…", detail: "uuid, randomInt, email, timestamp, …", tag: "generator" }];
    return [...vars, ...gens].slice(0, 40);
  }, [open, props.names]);

  const sync = () => {
    const el = input.current;
    if (el && back.current) {
      back.current.scrollLeft = el.scrollLeft;
      back.current.scrollTop = el.scrollTop;
    }
  };

  const check = () => {
    const el = input.current;
    if (!el) return;
    const o = openPlaceholder(el.value, el.selectionStart ?? el.value.length);
    setOpen(o);
    setActive(0);
  };

  const choose = (opt: Option) => {
    const el = input.current;
    if (!el || !open) return;
    const caret = el.selectionStart ?? el.value.length;
    let rest = el.value.slice(caret);
    if (opt.insert.endsWith("}}") && rest.startsWith("}}")) rest = rest.slice(2);
    const next = el.value.slice(0, open[0]) + opt.insert + rest;
    props.onChange(next);
    const pos = open[0] + opt.insert.length;
    setOpen(opt.insert.endsWith("}}") ? null : [open[0], opt.insert.slice(2)]);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
      sync();
    });
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open || options.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + options.length) % options.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(options[active]!);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(null);
    }
  };

  const shared = `${props.mono === false ? "" : "font-mono"} text-body ${props.multiline ? "py-2 leading-[18px] whitespace-pre-wrap break-words" : "whitespace-pre"}`;
  const field = (
    <>
      <div
        ref={back}
        aria-hidden
        className={`pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent px-2.5 text-text ${shared} ${props.multiline ? "" : "flex items-center"}`}
      >
        {props.value ? <Highlight value={props.value} known={known} /> : <span className="text-text4">{props.placeholder}</span>}
      </div>
      {props.multiline ? (
        <textarea
          ref={input}
          id={props.id}
          aria-label={props["aria-label"]}
          spellCheck={false}
          rows={props.rows ?? 6}
          disabled={props.disabled}
          aria-invalid={props.invalid || undefined}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
            requestAnimationFrame(check);
          }}
          onKeyDown={onKey}
          onKeyUp={(e) => !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key) && check()}
          onClick={check}
          onScroll={sync}
          onBlur={() => {
            setTimeout(() => setOpen(null), 120);
            props.onBlur?.();
          }}
          className={`input relative resize-y bg-transparent! text-transparent caret-text selection:bg-accent-soft selection:text-transparent ${shared} ${props.className ?? ""}`}
        />
      ) : (
        <input
          ref={input}
          id={props.id}
          aria-label={props["aria-label"]}
          spellCheck={false}
          autoComplete="off"
          disabled={props.disabled}
          aria-invalid={props.invalid || undefined}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
            requestAnimationFrame(check);
          }}
          onKeyDown={onKey}
          onKeyUp={(e) => !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key) && check()}
          onClick={check}
          onScroll={sync}
          onSelect={sync}
          onBlur={() => {
            setTimeout(() => setOpen(null), 120);
            props.onBlur?.();
          }}
          className={`input relative bg-transparent! text-transparent caret-text selection:bg-accent-soft selection:text-transparent ${shared} ${props.className ?? ""}`}
        />
      )}
    </>
  );

  return (
    <div ref={wrap} className="relative min-w-0 flex-1">
      {field}
      <Popover anchor={wrap} open={!!open && options.length > 0} onClose={() => setOpen(null)} width={340}>
        <ul role="listbox" aria-label="Variables and generators" className="max-h-64 overflow-y-auto">
          {options.map((o, i) => (
            <li key={o.label + i} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left ${i === active ? "bg-raised2" : ""}`}
              >
                <span className="min-w-0 truncate font-mono text-small text-text">{o.label}</span>
                <span className="min-w-0 flex-1 truncate text-micro text-text4">{o.detail}</span>
                <span className="shrink-0 text-micro text-text3">{o.tag}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-2 pt-1.5 pb-1 text-micro text-text4">↑↓ to choose · Enter to insert · Esc to close</p>
      </Popover>
    </div>
  );
}
