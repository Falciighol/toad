import { useEffect, useRef, useState } from "react";
import type { Settings } from "../bindings";
import { Field, NumberInput, Toggle } from "./ui";

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
    <dialog ref={ref} onClose={props.onClose} className="m-auto w-[440px] rounded-xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40">
      <form method="dialog" className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2 className="text-sm font-semibold">Settings</h2>
        <div className="grid grid-cols-2 gap-3">
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
        <div className="space-y-2">
          <Toggle label="Strip secrets from exports" hint="Bearer tokens and Authorization / Cookie / X-API-Key values." checked={draft.strip_secrets_on_export} onChange={(v) => set({ strip_secrets_on_export: v })} />
          <Toggle label="Keep secrets in run history" hint="Off: history files store those values as [redacted]." checked={draft.store_secrets_in_history} onChange={(v) => set({ store_secrets_in_history: v })} />
          <Toggle label="Treat private networks as local" hint="Skip the confirmation for 10/8, 172.16/12, 192.168/16 and IPv6 ULA targets." checked={draft.private_ranges_as_local} onChange={(v) => set({ private_ranges_as_local: v })} />
        </div>
        <p className="rounded-md bg-surface-2 px-2 py-1.5 text-xs text-ink-2">
          Saved tests are stored as plain JSON in the app data folder. Toad does not use the OS keychain.
        </p>
        {error && <p role="alert" className="text-xs text-critical">{error}</p>}
        <div className="flex justify-end gap-1.5">
          <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>
  );
}
