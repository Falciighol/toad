import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import type { ExportFormat, RunSummary, Settings, Snapshot, TestConfig } from "./bindings";
import { api, ApiError, errorMessage, on } from "./lib/api";
import { defaultSettings, newConfig } from "./lib/defaults";
import { appendPoint, toChartPoint, type ChartPoint } from "./lib/series";
import { validateConfig } from "./lib/validate";
import { RequestForm } from "./components/RequestForm";
import { LoadSettings } from "./components/LoadSettings";
import { isActive, RunControls, type UiPhase } from "./components/RunControls";
import { Dashboard } from "./components/Dashboard";
import { Summary } from "./components/Summary";
import { History } from "./components/History";
import { Compare } from "./components/Compare";
import { SettingsDialog } from "./components/SettingsDialog";
import { Field, Icon, Kbd, Section, Segmented } from "./components/ui";

type Tab = "results" | "history" | "compare";
const TAB_LABEL: Record<Tab, string> = { results: "Results", history: "History", compare: "Compare" };
type Toast = { kind: "error" | "info"; text: string };

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

function Logo() {
  return (
    <svg viewBox="0 0 1024 1024" className="size-5" aria-hidden>
      <rect x="64" y="64" width="896" height="896" rx="200" fill="#059669" />
      <circle cx="340" cy="330" r="118" fill="#ecfdf5" />
      <circle cx="684" cy="330" r="118" fill="#ecfdf5" />
      <circle cx="360" cy="340" r="56" fill="#064e3b" />
      <circle cx="704" cy="340" r="56" fill="#064e3b" />
      <polyline points="190,690 340,690 410,560 500,800 590,600 650,690 834,690" fill="none" stroke="#ecfdf5" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function App() {
  const [config, setConfig] = useState<TestConfig>(newConfig);
  const [tests, setTests] = useState<TestConfig[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [phase, setPhase] = useState<UiPhase>("idle");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [series, setSeries] = useState<ChartPoint[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [viewed, setViewed] = useState<RunSummary | null>(null);
  const [compare, setCompare] = useState<[RunSummary, RunSummary] | null>(null);
  const [tab, setTab] = useState<Tab>("results");
  const [showErrors, setShowErrors] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const runId = useRef<string | null>(null);
  const runConfig = useRef<TestConfig | null>(null);

  const notify = useCallback((kind: Toast["kind"], text: string) => setToast({ kind, text }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "error" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshRuns = useCallback(() => api.listRuns().then(setRuns).catch((e) => notify("error", errorMessage(e))), [notify]);
  const refreshTests = useCallback(() => api.listTests().then(setTests).catch((e) => notify("error", errorMessage(e))), [notify]);

  // Initial load + event wiring.
  useEffect(() => {
    void api.getSettings().then(setSettings);
    void refreshRuns();
    void refreshTests();
    void api.currentRun().then((id) => {
      if (id) {
        runId.current = id;
        setPhase("running");
      }
    });
    const unlisten = [
      on.snapshot((s) => {
        if (runId.current !== s.run_id) return;
        setSnapshot(s);
        if (s.phase !== "done" && s.phase !== "failed") setPhase((p) => (p === "stopping" && s.phase !== "stopping" ? p : s.phase));
        const second = s.second;
        if (second) setSeries((prev) => appendPoint(prev, toChartPoint(second, s.target_rps)));
      }),
      on.finished((r) => {
        if (runId.current !== r.run_id) return;
        runId.current = null;
        setSummary(r);
        setPhase(r.end_reason === "failed" ? "failed" : "done");
        void refreshRuns();
      }),
      on.error((e) => {
        if (runId.current !== e.run_id) return;
        runId.current = null;
        setPhase("failed");
        notify("error", e.message);
      }),
    ];
    return () => unlisten.forEach((p) => void p.then((f) => f()));
  }, [notify, refreshRuns, refreshTests]);

  const errors = useMemo(() => validateConfig(config, settings), [config, settings]);

  const start = useCallback(async () => {
    if (isActive(phase)) return;
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      notify("error", "Fix the highlighted fields before starting.");
      return;
    }
    setPhase("starting");
    try {
      const check = await api.checkTarget(config.request.url);
      if (!check.approved) {
        const ok = await confirm(
          `${check.host} resolves to ${check.addrs.join(", ")}, which is not a loopback address.\n\n` +
            `Only load-test APIs you own or are authorized to test.\n\nToad will remember this answer for ${check.host} until you quit.`,
          { title: "Run against a non-local target?", kind: "warning", okLabel: "Run test", cancelLabel: "Cancel" },
        );
        if (!ok) {
          setPhase("idle");
          return;
        }
        await api.approveHost(check.host);
      }
      setSnapshot(null);
      setSeries([]);
      setSummary(null);
      setTab("results");
      runConfig.current = config;
      runId.current = await api.startRun(config);
    } catch (e) {
      setPhase("idle");
      if (e instanceof ApiError && e.code === "invalid") setShowErrors(true);
      notify("error", errorMessage(e));
    }
  }, [phase, errors, config, notify]);

  const stop = useCallback(() => {
    if (!isActive(phase) || phase === "starting") return;
    setPhase("stopping");
    void api.stopRun();
  }, [phase]);

  // Shortcuts: Cmd/Ctrl+Enter start, Cmd/Ctrl+. stop, Esc stops only when nothing else wants it.
  const keys = useRef({ start, stop });
  keys.current = { start, stop };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void keys.current.start();
      } else if (mod && e.key === ".") {
        e.preventDefault();
        keys.current.stop();
      } else if (e.key === "Escape" && !document.querySelector("dialog[open]") && !isEditable(document.activeElement)) {
        keys.current.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- saved tests ----
  const saveTest = async () => {
    if (errors["name"]) return setShowErrors(true);
    try {
      const saved = await api.saveTest(config);
      setConfig(saved);
      await refreshTests();
      notify("info", `Saved “${saved.name}”.`);
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };
  const duplicateTest = async () => {
    try {
      const copy = await api.duplicateTest(config.id);
      setConfig(copy);
      await refreshTests();
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };
  const deleteTest = async () => {
    if (!(await confirm(`Delete the saved test “${config.name}”? The editor keeps these settings, so you can save them again.`, { title: "Delete test", kind: "warning", okLabel: "Delete" }))) return;
    try {
      await api.deleteTest(config.id);
      setConfig({ ...config, id: "", created_at: 0, updated_at: 0 });
      await refreshTests();
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  // ---- runs ----
  const exportRun = async (id: string, format: ExportFormat) => {
    const run = runs.find((r) => r.run_id === id) ?? summary;
    const base = (run?.config.name ?? "run").replace(/[^\w.-]+/g, "-").slice(0, 40);
    const stamp = new Date(run?.started_at ?? Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const path = await save({ defaultPath: `toad-${base}-${stamp}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!path) return;
    try {
      await api.exportRun(id, format, path);
      notify("info", `Exported to ${path}`);
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };
  const openRun = async (id: string) => {
    try {
      setViewed(await api.getRun(id));
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };
  const deleteRun = async (id: string) => {
    if (!(await confirm("Delete this run from history?", { title: "Delete run", kind: "warning", okLabel: "Delete" }))) return;
    try {
      await api.deleteRun(id);
      if (viewed?.run_id === id) setViewed(null);
      await refreshRuns();
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };
  const compareRuns = async (a: string, b: string) => {
    try {
      const [ra, rb] = await Promise.all([api.getRun(a), api.getRun(b)]);
      // Older run is A so deltas read "what changed since".
      setCompare(ra.started_at <= rb.started_at ? [ra, rb] : [rb, ra]);
      setTab("compare");
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  const active = isActive(phase);
  const rc = runConfig.current;
  const progress = (() => {
    if (!snapshot || !rc) return phase === "done" ? 1 : null;
    if (phase === "done" || phase === "failed") return 1;
    return rc.load.stop.kind === "duration" ? snapshot.t_ms / (rc.load.stop.secs * 1000) : snapshot.total / rc.load.stop.count;
  })();
  const capped = (rc ?? config).load.rps_cap !== null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-chrome px-4">
        <div className="flex items-center gap-2 text-title font-semibold">
          <Logo /> Toad
        </div>
        <Segmented
          aria-label="Views"
          value={tab}
          onChange={setTab}
          options={(["results", "history", "compare"] as const).map((t) => ({
            value: t,
            disabled: t === "compare" && !compare,
            title: t === "compare" && !compare ? "Pick two runs in History to compare them" : undefined,
            label: (
              <>
                {TAB_LABEL[t]}
                {t === "history" && runs.length > 0 && (
                  <span className={`tabular font-mono text-small ${tab === t ? "text-accent-ink" : "text-text4"}`} aria-label={`${runs.length} runs`}>
                    {runs.length}
                  </span>
                )}
              </>
            ),
          }))}
        />
        <button type="button" className="btn btn-ghost ml-auto" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" className="size-4" /> Settings
        </button>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(380px,440px)_minmax(0,1fr)]">
        <aside className="min-h-0 space-y-3 overflow-y-auto border-r border-line bg-chrome p-4">
          <Section
            title="Test"
            aside={
              <div className="-my-1 flex items-center gap-0.5">
                <button type="button" className="btn btn-sm btn-ghost" disabled={active} onClick={() => { setConfig(newConfig()); setShowErrors(false); }} title="Start a blank test">
                  <Icon name="file" /> New
                </button>
                <button type="button" className="btn btn-sm btn-ghost px-1.5" disabled={active || !config.id} onClick={() => void duplicateTest()} aria-label="Duplicate saved test" title={config.id ? "Duplicate saved test" : "Save the test first to duplicate it"}>
                  <Icon name="copy" />
                </button>
                <button type="button" className="btn btn-sm btn-ghost btn-danger-text px-1.5" disabled={active || !config.id} onClick={() => void deleteTest()} aria-label="Delete saved test" title={config.id ? "Delete saved test" : "Nothing to delete: this test isn't saved"}>
                  <Icon name="trash" />
                </button>
              </div>
            }
          >
            <div className="space-y-3">
              <Field label="Open saved test">
                {(id) => (
                  <select
                    id={id}
                    className="input"
                    value={config.id}
                    disabled={active || tests.length === 0}
                    onChange={(e) => {
                      const t = tests.find((x) => x.id === e.target.value);
                      if (t) {
                        setConfig(t);
                        setShowErrors(false);
                      }
                    }}
                  >
                    <option value="">{tests.length ? "Unsaved test — choose one to open" : "No saved tests yet"}</option>
                    {tests.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Name" error={showErrors ? errors["name"] : undefined}>
                {(id) => (
                  <div className="flex gap-1.5">
                    <input id={id} className="input" value={config.name} disabled={active} aria-invalid={(showErrors && !!errors["name"]) || undefined} onChange={(e) => setConfig({ ...config, name: e.target.value })} />
                    <button type="button" className="btn shrink-0" disabled={active} onClick={() => void saveTest()}>
                      <Icon name="save" /> {config.id ? "Save changes" : "Save test"}
                    </button>
                  </div>
                )}
              </Field>
            </div>
          </Section>
          <RequestForm value={config.request} onChange={(request) => setConfig({ ...config, request })} showAllErrors={showErrors} disabled={active} />
          <LoadSettings value={config.load} onChange={(load) => setConfig({ ...config, load })} limits={settings} showAllErrors={showErrors} disabled={active} />
        </aside>

        <section className="flex min-h-0 flex-col">
          <div className="border-b border-line p-4">
            <RunControls phase={phase} elapsedMs={snapshot?.t_ms ?? 0} progress={progress} onStart={() => void start()} onStop={stop} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "results" &&
              (summary && !active ? (
                <Summary summary={summary} onExport={(f) => void exportRun(summary.run_id, f)} />
              ) : snapshot || active ? (
                <Dashboard snapshot={snapshot} series={series} capped={capped} />
              ) : (
                <div className="flex flex-col items-center px-6 py-16 text-center">
                  <Icon name="play" className="size-8 text-text4" />
                  <p className="mt-3 text-title font-semibold text-text">Configure a request and press Start</p>
                  <p className="mt-1 max-w-sm text-body text-text3">Live throughput, latency percentiles and errors appear here while the test runs.</p>
                  <p className="mt-3 text-small text-text4">
                    <Kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter</Kbd> to start
                  </p>
                  <p className="mt-6 text-small text-text3">No API handy? Run the bundled mock server:</p>
                  <code className="mt-1.5 rounded border border-line2 px-2 py-1 font-mono text-small text-text2 select-all">cargo run --release --example mock_server</code>
                </div>
              ))}
            {tab === "history" &&
              (viewed ? (
                <Summary summary={viewed} onExport={(f) => void exportRun(viewed.run_id, f)} onClose={() => setViewed(null)} />
              ) : (
                <History runs={runs} onOpen={(id) => void openRun(id)} onDelete={(id) => void deleteRun(id)} onExport={(id, f) => void exportRun(id, f)} onCompare={(a, b) => void compareRuns(a, b)} />
              ))}
            {tab === "compare" && compare && <Compare a={compare[0]} b={compare[1]} onClose={() => setTab("history")} />}
          </div>
        </section>
      </main>

      <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-line bg-chrome px-4 text-small text-text3" role="note">
        <Icon name="alert" className="size-3 text-text4" /> Only test APIs you own or are explicitly authorized to test. Load testing other systems can be illegal and disruptive.
      </footer>

      {toast && (
        <div
          role={toast.kind === "error" ? "alert" : "status"}
          className={`floating animate-pop fixed bottom-11 left-1/2 flex max-w-md -translate-x-1/2 items-start gap-2 py-2.5 pr-2 pl-3 text-body text-text ${toast.kind === "error" ? "ring-1 ring-danger/40" : ""}`}
        >
          <Icon name={toast.kind === "error" ? "alert" : "check"} className={`mt-px size-4 ${toast.kind === "error" ? "text-danger" : "text-success"}`} />
          <span className="min-w-0 flex-1 break-words">{toast.text}</span>
          <button type="button" className="btn btn-ghost -my-1 h-6 w-6 px-0" aria-label="Dismiss" onClick={() => setToast(null)}>
            <Icon name="x" className="size-3.5" />
          </button>
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={async (s) => {
          setSettings(await api.saveSettings(s));
          void refreshRuns();
        }}
      />
    </div>
  );
}
