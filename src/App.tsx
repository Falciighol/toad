import { useCallback, useEffect, useRef, useState } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import type { ExportFormat, RunSummary, Settings, Snapshot, TestConfig } from "./bindings";
import { api, errorMessage, on } from "./lib/api";
import { defaultSettings, newTest } from "./lib/defaults";
import { appendPoint, toChartPoint, type ChartPoint } from "./lib/series";
import { History } from "./components/History";
import { Compare } from "./components/Compare";
import { SettingsDialog } from "./components/SettingsDialog";
import { TestsLibrary } from "./components/TestsLibrary";
import { TestPage } from "./components/test/TestPage";
import { RunView, type Live } from "./components/run/RunView";
import { Icon, Segmented } from "./components/ui";

type View = { kind: "tests" } | { kind: "test"; config: TestConfig } | { kind: "run"; runId: string | null } | { kind: "runs" } | { kind: "compare" };
type Toast = { kind: "error" | "info"; text: string };
type Phase = "idle" | "running" | "stopping";

const LAST_TEST = "toad.lastTest";

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

const remember = (id: string) => {
  try {
    localStorage.setItem(LAST_TEST, id);
  } catch {
    /* storage can be unavailable */
  }
};

export default function App() {
  const [view, setView] = useState<View | null>(null);
  const [tests, setTests] = useState<TestConfig[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [phase, setPhase] = useState<Phase>("idle");
  const [live, setLive] = useState<Live | null>(null);
  const [finished, setFinished] = useState<RunSummary | null>(null);
  const [viewed, setViewed] = useState<RunSummary | null>(null);
  const [compare, setCompare] = useState<[RunSummary, RunSummary] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const runId = useRef<string | null>(null);
  const testKey = useRef(0);

  const notify = useCallback((kind: Toast["kind"], text: string) => setToast({ kind, text }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "error" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshRuns = useCallback(() => api.listRuns().then(setRuns).catch((e) => notify("error", errorMessage(e))), [notify]);
  const refreshTests = useCallback(() => api.listTests().then((t) => (setTests(t), t)).catch((e) => (notify("error", errorMessage(e)), [] as TestConfig[])), [notify]);

  // Startup: open the last test (or a new one), and pick up a run already in progress.
  useEffect(() => {
    void api.getSettings().then(setSettings);
    void refreshRuns();
    void refreshTests().then((list) => {
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_TEST);
      } catch {
        /* none */
      }
      const t = list.find((x) => x.id === last) ?? list[0];
      setView((v) => v ?? { kind: "test", config: t ?? newTest() });
    });
    void api.currentRun().then((id) => {
      if (id) {
        runId.current = id;
        setPhase("running");
      }
    });
  }, [refreshRuns, refreshTests]);

  useEffect(() => {
    const unlisten = [
      on.snapshot((s: Snapshot) => {
        if (runId.current !== s.run_id) return;
        setLive((l) => {
          if (!l) return l;
          const spark = new Map(l.spark);
          for (const e of s.endpoints) {
            const prev = spark.get(e.step_id) ?? [];
            if (s.second) spark.set(e.step_id, [...prev.slice(-119), e.p95]);
          }
          const second = s.second;
          let scen = l.scen;
          if (second) {
            scen = { ...l.scen };
            for (const sc of s.scenarios) scen[sc.id] = [...(scen[sc.id] ?? []), { t: second.t_s, vus: sc.vus, iterations: sc.iterations }];
          }
          return { ...l, snapshot: s, series: second ? appendPoint(l.series, toChartPoint(second, s.target_rps)) : l.series, spark, scen };
        });
        if (s.phase === "stopping") setPhase("stopping");
      }),
      on.finished((r) => {
        if (runId.current !== r.run_id) return;
        runId.current = null;
        setPhase("idle");
        setFinished(r);
        void refreshRuns();
      }),
      on.error((e) => {
        if (runId.current !== e.run_id) return;
        runId.current = null;
        setPhase("idle");
        notify("error", e.message);
      }),
    ];
    return () => unlisten.forEach((p) => void p.then((f) => f()));
  }, [notify, refreshRuns]);

  const stop = useCallback(() => {
    if (phase !== "running") return;
    setPhase("stopping");
    void api.stopRun();
  }, [phase]);

  const keys = useRef({ stop });
  keys.current = { stop };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        keys.current.stop();
      } else if (e.key === "Escape" && !document.querySelector("dialog[open]") && !isEditable(document.activeElement)) {
        keys.current.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const exportRun = async (run: RunSummary, format: ExportFormat) => {
    const base = (run.config.name || "run").replace(/[^\w.-]+/g, "-").slice(0, 40);
    const stamp = new Date(run.started_at).toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const path = await save({ defaultPath: `toad-${base}-${stamp}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!path) return;
    try {
      await api.exportRun(run.run_id, format, path);
      notify("info", `Exported to ${path}`);
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  const openTest = (config: TestConfig) => {
    testKey.current++;
    if (config.id) remember(config.id);
    setView({ kind: "test", config });
  };

  const openRun = async (id: string) => {
    try {
      setViewed(await api.getRun(id));
      setView({ kind: "run", runId: id });
    } catch (e) {
      notify("error", errorMessage(e));
    }
  };

  const previousOf = (r: RunSummary | null) => (r ? (runs.find((x) => x.config.id === r.config.id && x.started_at < r.started_at && x.run_id !== r.run_id) ?? null) : null);
  const [previous, setPrevious] = useState<RunSummary | null>(null);
  const shown = view?.kind === "run" ? (view.runId === null ? (phase === "idle" ? finished : null) : viewed) : null;
  useEffect(() => {
    const p = previousOf(shown);
    if (!p) return setPrevious(null);
    api.getRun(p.run_id).then(setPrevious).catch(() => setPrevious(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.run_id, runs.length]);

  const active = phase !== "idle";
  const nav = view?.kind === "runs" || view?.kind === "compare" || (view?.kind === "run" && view.runId !== null) ? "runs" : "tests";

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-4 border-b border-line bg-chrome px-4">
        <div className="flex items-center gap-2 text-title font-semibold">
          <Logo /> Toad
        </div>
        <Segmented
          aria-label="Views"
          value={nav}
          onChange={(v) => (v === "tests" ? (refreshTests(), setView({ kind: "tests" })) : setView({ kind: "runs" }))}
          options={[
            { value: "tests", label: "Tests" },
            {
              value: "runs",
              label: (
                <>
                  Runs
                  {runs.length > 0 && <span className={`tabular font-mono text-small ${nav === "runs" ? "text-accent-ink" : "text-text4"}`}>{runs.length}</span>}
                </>
              ),
            },
          ]}
        />
        {active && (
          <button type="button" className="btn btn-sm" onClick={() => setView({ kind: "run", runId: null })}>
            <span className="size-1.5 animate-pulse rounded-full bg-info" /> {phase === "stopping" ? "Stopping" : "Running"} · {live?.config.name}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" className="size-4" /> Settings
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {view?.kind === "tests" && (
          <div className="h-full overflow-y-auto">
            <TestsLibrary
              tests={tests}
              runs={runs}
              onOpen={openTest}
              onNew={openTest}
              onDuplicate={async (id) => {
                try {
                  const copy = await api.duplicateTest(id);
                  await refreshTests();
                  openTest(copy);
                } catch (e) {
                  notify("error", errorMessage(e));
                }
              }}
              onDelete={async (t) => {
                if (!(await confirm(`Delete “${t.name}” and its files? Its runs stay in Runs.`, { title: "Delete test", kind: "warning", okLabel: "Delete" }))) return;
                try {
                  await api.deleteTest(t.id);
                  await refreshTests();
                } catch (e) {
                  notify("error", errorMessage(e));
                }
              }}
            />
          </div>
        )}
        {view?.kind === "test" && (
          <TestPage
            key={`${view.config.id || "new"}-${testKey.current}`}
            initial={view.config}
            settings={settings}
            runActive={active && live?.config.id === view.config.id}
            runElapsedMs={live?.snapshot?.t_ms ?? 0}
            onBack={() => {
              void refreshTests();
              setView({ kind: "tests" });
            }}
            onOpenRun={() => setView({ kind: "run", runId: null })}
            onStop={stop}
            onStarted={(id, config) => {
              runId.current = id;
              remember(config.id);
              setFinished(null);
              setLive({ snapshot: null, series: [] as ChartPoint[], spark: new Map(), scen: {}, config });
              setPhase("running");
              setView({ kind: "run", runId: null });
            }}
            onSaved={(c) => {
              remember(c.id);
              setTests((list) => [c, ...list.filter((x) => x.id !== c.id)]);
            }}
            notify={notify}
          />
        )}
        {view?.kind === "run" &&
          (view.runId === null && !live && !finished ? (
            <div className="flex h-full items-center justify-center text-body text-text3">No run in progress.</div>
          ) : (
            <RunView
              live={view.runId === null && phase !== "idle" ? live : null}
              summary={view.runId === null ? (phase === "idle" ? finished : null) : viewed}
              previous={previous}
              onStop={stop}
              onExport={(f) => {
                const r = view.runId === null ? finished : viewed;
                if (r) void exportRun(r, f);
              }}
              onOpenTest={(c) => openTest(tests.find((t) => t.id === c.id) ?? c)}
              onBack={() => (view.runId === null ? openTest(tests.find((t) => t.id === live?.config.id) ?? live!.config) : setView({ kind: "runs" }))}
              backLabel={view.runId === null ? "Test" : "Runs"}
            />
          ))}
        {view?.kind === "runs" && (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-5xl px-8 py-7">
              <h1 className="mb-4 text-display font-semibold">Runs</h1>
              <History
                runs={runs}
                onOpen={(id) => void openRun(id)}
                onDelete={async (id) => {
                  if (!(await confirm("Delete this run and its samples?", { title: "Delete run", kind: "warning", okLabel: "Delete" }))) return;
                  try {
                    await api.deleteRun(id);
                    await refreshRuns();
                  } catch (e) {
                    notify("error", errorMessage(e));
                  }
                }}
                onExport={(id, f) => {
                  const r = runs.find((x) => x.run_id === id);
                  if (r) void exportRun(r, f);
                }}
                onCompare={async (a, b) => {
                  try {
                    const [ra, rb] = await Promise.all([api.getRun(a), api.getRun(b)]);
                    setCompare(ra.started_at <= rb.started_at ? [ra, rb] : [rb, ra]);
                    setView({ kind: "compare" });
                  } catch (e) {
                    notify("error", errorMessage(e));
                  }
                }}
              />
            </div>
          </div>
        )}
        {view?.kind === "compare" && compare && (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-5xl px-8 py-7">
              <Compare a={compare[0]} b={compare[1]} onClose={() => setView({ kind: "runs" })} />
            </div>
          </div>
        )}
      </main>

      <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-line bg-chrome px-4 text-small text-text3" role="note">
        <Icon name="alert" className="size-3 text-text4" /> Only test APIs you own or are explicitly authorized to test. Load testing other systems can be illegal and disruptive.
      </footer>

      {toast && (
        <div
          role={toast.kind === "error" ? "alert" : "status"}
          className={`floating animate-pop fixed bottom-11 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-start gap-2 py-2.5 pr-2 pl-3 text-body text-text ${toast.kind === "error" ? "ring-1 ring-danger/40" : ""}`}
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
