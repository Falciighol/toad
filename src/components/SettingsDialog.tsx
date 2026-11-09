import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Settings } from "../bindings";
import { ACCENT_ORDER, ACCENTS, accentSwatch, getAccent, setAccent, subscribeAccent } from "../lib/theme";
import { Field, NumberInput, Toggle } from "./ui";

/** Saga's accent swatches. A pick applies at once and is kept on this machine, apart from Save. */
function AccentPicker() {
  const accent = useSyncExternalStore(subscribeAccent, getAccent);
  return (
    <div className="flex items-center gap-3">
      <span id="accent-label" className="min-w-0 flex-1">
        <span className="block text-body text-text">Accent</span>
        <span className="block text-small text-text3">{ACCENTS[accent].label}. Applies right away.</span>
      </span>
      <div role="radiogroup" aria-labelledby="accent-label" className="flex gap-2">
        {ACCENT_ORDER.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={accent === a}
            aria-label={ACCENTS[a].label}
            title={ACCENTS[a].label}
            onClick={() => setAccent(a)}
            className={`size-6 rounded-full ring-offset-2 ring-offset-panel transition-shadow ${accent === a ? "ring-2 ring-text" : "hover:ring-2 hover:ring-line2"}`}
            style={{ background: accentSwatch(a) }}
          />
        ))}
      </div>
    </div>
  );
}

export function SettingsDialog(props: { open: boolean; settings: Settings; onClose: () => void; onSave: (s: Settings) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(props.settings);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) {
      setDraft(props.settings);
      setError(null);
      d.showModal();
    } else if (!props.open && d.open) d.close();
  }, [props.open, props.settings]);

  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));
  const save = async () => {
    try {
      await props.onSave(draft);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <dialog ref={ref} onClose={props.onClose} className="floating animate-pop m-auto max-h-[calc(100vh-2rem)] w-[520px] overflow-y-auto max-w-[calc(100vw-2rem)] p-0 text-text backdrop:bg-(--overlay) backdrop:backdrop-blur-[4px]">
      <form method="dialog" className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2 className="text-title font-semibold">Settings</h2>
        <AccentPicker />
        <div className="grid grid-cols-2 gap-3 border-t border-line pt-4">
          <Field label="Concurrency ceiling">
            {(id) => <NumberInput id={id} min={1} value={draft.max_concurrency} onChange={(v) => set({ max_concurrency: v ?? 0 })} />}
          </Field>
          <Field label="RPS ceiling">
            {(id) => <NumberInput id={id} min={1} value={draft.max_rps} onChange={(v) => set({ max_rps: v ?? 0 })} />}
          </Field>
          <Field label="Runs kept in history">
            {(id) => <NumberInput id={id} min={1} value={draft.history_limit} onChange={(v) => set({ history_limit: v ?? 0 })} />}
          </Field>
        </div>
        <div className="border-t border-line pt-4">
          <div className="mb-1 text-body text-text">Samples kept per endpoint</div>
          <p className="mb-3 text-small text-text3">Real requests and responses saved with each run for the analysis.</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Failures, per kind">{(id) => <NumberInput id={id} min={0} value={draft.sample_failures ?? 200} onChange={(v) => set({ sample_failures: v ?? 0 })} />}</Field>
            <Field label="Slowest">{(id) => <NumberInput id={id} min={0} value={draft.sample_slowest ?? 50} onChange={(v) => set({ sample_slowest: v ?? 0 })} />}</Field>
            <Field label="Random">{(id) => <NumberInput id={id} min={0} value={draft.sample_random ?? 100} onChange={(v) => set({ sample_random: v ?? 0 })} />}</Field>
            <Field label="Body size cap">{(id) => <NumberInput id={id} suffix="KB" min={1} value={draft.sample_body_kb ?? 64} onChange={(v) => set({ sample_body_kb: v ?? 0 })} />}</Field>
            <Field label="Per run, at most">{(id) => <NumberInput id={id} suffix="MB" min={1} value={draft.sample_run_mb ?? 50} onChange={(v) => set({ sample_run_mb: v ?? 0 })} />}</Field>
          </div>
          <div className="mt-3">
            <Toggle label="Keep bodies" hint="Off: only status, headers and timing are kept (for targets with personal data)." checked={draft.sample_bodies ?? true} onChange={(v) => set({ sample_bodies: v })} />
          </div>
        </div>
        <div className="space-y-3 border-t border-line pt-4">
          <Toggle label="Strip secrets from exports" hint="Auth credentials, secret variables, and Authorization / Cookie / X-API-Key values." checked={draft.strip_secrets_on_export} onChange={(v) => set({ strip_secrets_on_export: v })} />
          <Toggle label="Keep secrets in run history" hint="Off: history files and samples store those values as [redacted]." checked={draft.store_secrets_in_history} onChange={(v) => set({ store_secrets_in_history: v })} />
          <Toggle label="Treat private networks as local" hint="Skip the confirmation for 10/8, 172.16/12, 192.168/16 and IPv6 ULA targets." checked={draft.private_ranges_as_local} onChange={(v) => set({ private_ranges_as_local: v })} />
        </div>
        <p className="rounded-lg bg-raised px-3 py-2 text-small text-text3">
          Saved tests are stored as plain JSON in the app data folder. Toad does not use the OS keychain.
        </p>
        {error && <p role="alert" className="text-small text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>
  );
}
