import { useEffect, useState } from "react";
import type { DataFile, DataFormat, DataPreview, Distribution, JarMode, OnExhausted, SeedCookie, TestConfig, Variable } from "../../bindings";
import { api, errorMessage } from "../../lib/api";
import { uid } from "../../lib/defaults";
import type { Errors } from "../../lib/stages";
import { namesFor } from "../../lib/template";
import { isSensitiveHeader } from "../../lib/validate";
import { fmtInt } from "../../lib/format";
import { Empty, Field, Icon, IconButton, NumberInput, Segmented, Select, Toggle } from "../ui";
import { KeyValueTable } from "./KeyValueTable";
import { AuthEditor, type PickFile } from "./StepEditor";

export function StageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="mb-5">
      <h2 className="text-display font-semibold text-text">{title}</h2>
      {children && <p className="mt-1 max-w-2xl text-body text-text3">{children}</p>}
    </header>
  );
}

export function Block({ title, hint, children, aside }: { title: string; hint?: React.ReactNode; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-t border-line py-6 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-title font-semibold text-text">{title}</h3>
          {hint && <p className="mt-0.5 max-w-2xl text-small text-text3">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function DataStage({ config: c, onChange, errors, pickFile, testId }: { config: TestConfig; onChange: (c: TestConfig) => void; errors: Errors; pickFile: (filters?: { name: string; extensions: string[] }[]) => ReturnType<PickFile>; testId: string }) {
  const names = namesFor(c, null);
  return (
    <div className="mx-auto max-w-5xl px-8 py-7">
      <StageHeader title="Data">Where the values in your templates come from: environments, data files, the cookie jar, and defaults every step inherits.</StageHeader>
      <Environments config={c} onChange={onChange} errors={errors} />
      <DataFiles config={c} onChange={onChange} errors={errors} pickFile={pickFile} testId={testId} />
      <Cookies config={c} onChange={onChange} />
      <Block title="Defaults" hint="Every step uses these unless it sets its own.">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Base URL" optional error={errors["defaults.base_url"]} hint={<>Read as <code className="font-mono">{"{{baseUrl}}"}</code>. To switch per environment, define a <code className="font-mono">baseUrl</code> variable instead.</>}>
              {(id) => <input id={id} className="input font-mono" placeholder="http://localhost:8787" value={c.defaults.base_url} onChange={(e) => onChange({ ...c, defaults: { ...c.defaults, base_url: e.target.value } })} />}
            </Field>
            <Field label="User-Agent" optional hint="Empty: toad/version.">
              {(id) => <input id={id} className="input font-mono" placeholder="toad/0.1.0" value={c.defaults.user_agent} onChange={(e) => onChange({ ...c, defaults: { ...c.defaults, user_agent: e.target.value } })} />}
            </Field>
          </div>
          <div>
            <div className="label">Headers on every request</div>
            <KeyValueTable label="default header" rows={c.defaults.headers} onChange={(headers) => onChange({ ...c, defaults: { ...c.defaults, headers } })} names={names} sensitive={isSensitiveHeader} empty="None." />
          </div>
          <div>
            <div className="label">Default auth</div>
            <AuthEditor auth={c.defaults.auth} onChange={(auth) => onChange({ ...c, defaults: { ...c.defaults, auth } })} names={names} />
          </div>
          <div className="grid grid-cols-4 gap-4">
            <Field label="Timeout" error={errors["defaults.timeout_ms"]} hint="Per request, including redirects.">
              {(id) => <NumberInput id={id} suffix="ms" value={c.defaults.timeout_ms} onChange={(v) => onChange({ ...c, defaults: { ...c.defaults, timeout_ms: v ?? Number.NaN } })} />}
            </Field>
            <Field label="Max redirects" error={errors["defaults.max_redirects"]} hint="0 – 20 hops.">
              {(id) => <NumberInput id={id} value={c.defaults.max_redirects} onChange={(v) => onChange({ ...c, defaults: { ...c.defaults, max_redirects: v ?? 0 } })} />}
            </Field>
            <Field label="Read at most" hint="Of a body, for extraction.">
              {(id) => <NumberInput id={id} suffix="KB" value={c.defaults.max_response_kb} onChange={(v) => onChange({ ...c, defaults: { ...c.defaults, max_response_kb: v ?? 1024 } })} />}
            </Field>
            <div className="pt-6">
              <Toggle label="Follow redirects" checked={c.defaults.follow_redirects} onChange={(follow_redirects) => onChange({ ...c, defaults: { ...c.defaults, follow_redirects } })} />
            </div>
          </div>
        </div>
      </Block>
    </div>
  );
}

function Environments({ config: c, onChange, errors }: { config: TestConfig; onChange: (c: TestConfig) => void; errors: Errors }) {
  const envs = c.environments;
  const cols = envs.length ? envs : [{ id: "", name: "Value" }];
  const setVar = (i: number, v: Variable) => onChange({ ...c, variables: c.variables.map((x, j) => (j === i ? v : x)) });
  const addEnv = () => {
    const id = uid("e");
    const name = envs.length === 0 ? "local" : envs.length === 1 ? "staging" : `env ${envs.length + 1}`;
    // The first environment takes over the values entered without one.
    const variables = envs.length === 0 ? c.variables.map((v) => ({ ...v, values: { [id]: v.values[""] ?? "" } })) : c.variables;
    onChange({ ...c, environments: [...envs, { id, name }], variables, active_env: c.active_env || id });
  };
  return (
    <Block
      title="Variables"
      hint={<>Read anywhere as <code className="font-mono">{"{{name}}"}</code>. Add environments (local, staging) to switch values without editing steps; the active one is chosen in the header. Switching re-checks every host.</>}
      aside={
        <button type="button" className="btn btn-sm" onClick={addEnv}>
          <Icon name="plus" className="size-3" /> Environment
        </button>
      }
    >
      {c.variables.length === 0 && envs.length === 0 ? (
        <Empty
          title="No variables yet"
          icon="data"
          action={
            <button type="button" className="btn btn-sm" onClick={() => onChange({ ...c, variables: [{ name: "baseUrl", secret: false, values: { [c.active_env]: c.defaults.base_url || "http://localhost:8787" } }] })}>
              <Icon name="plus" className="size-3" /> Add a variable
            </button>
          }
        >
          Hosts, credentials and IDs that change between environments belong here, not in steps.
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b border-line text-left text-small text-text3">
                <th className="w-48 py-2 pr-2 pl-3 font-medium">Name</th>
                {cols.map((e) => (
                  <th key={e.id} className="px-2 py-2 font-medium">
                    {envs.length ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="active-env"
                          aria-label={`Use ${e.name}`}
                          title="Active environment"
                          checked={c.active_env === e.id}
                          onChange={() => onChange({ ...c, active_env: e.id })}
                          className="size-3.5"
                        />
                        <input
                          className="input h-6 w-28 border-transparent bg-transparent px-1 text-small font-medium hover:border-line2"
                          aria-label="Environment name"
                          value={e.name}
                          onChange={(ev) => onChange({ ...c, environments: envs.map((x) => (x.id === e.id ? { ...x, name: ev.target.value } : x)) })}
                        />
                        <IconButton
                          icon="x"
                          size="sm"
                          label={`Delete environment ${e.name}`}
                          onClick={() => {
                            const rest = envs.filter((x) => x.id !== e.id);
                            onChange({ ...c, environments: rest, active_env: c.active_env === e.id ? (rest[0]?.id ?? "") : c.active_env, variables: c.variables.map((v) => ({ ...v, values: Object.fromEntries(Object.entries(v.values).filter(([k]) => k !== e.id)) })) });
                          }}
                        />
                      </div>
                    ) : (
                      "Value"
                    )}
                  </th>
                ))}
                <th className="w-20 px-2 py-2 font-medium">Secret</th>
                <th className="w-9" />
              </tr>
            </thead>
            <tbody>
              {c.variables.map((v, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <td className="py-1.5 pr-2 pl-3 align-top">
                    <input className="input font-mono" aria-label={`Variable ${i + 1} name`} aria-invalid={!!errors[`env.var.${i}`] || undefined} value={v.name} onChange={(e) => setVar(i, { ...v, name: e.target.value })} />
                    {errors[`env.var.${i}`] && <p role="alert" className="mt-1 text-small text-danger">{errors[`env.var.${i}`]}</p>}
                  </td>
                  {cols.map((e) => (
                    <td key={e.id} className="px-2 py-1.5 align-top">
                      <input
                        className="input font-mono"
                        type={v.secret ? "password" : "text"}
                        aria-label={`${v.name || "variable"} in ${e.name}`}
                        value={v.values[e.id] ?? ""}
                        onChange={(ev) => setVar(i, { ...v, values: { ...v.values, [e.id]: ev.target.value } })}
                      />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 align-top">
                    <label className="flex h-8 items-center gap-1.5 text-small text-text3">
                      <input type="checkbox" className="size-3.5" checked={v.secret} onChange={(e) => setVar(i, { ...v, secret: e.target.checked })} /> <Icon name="lock" className="size-3" />
                    </label>
                  </td>
                  <td className="py-1.5 pr-2 align-top">
                    <IconButton icon="x" size="sm" label={`Remove ${v.name || "variable"}`} onClick={() => onChange({ ...c, variables: c.variables.filter((_, j) => j !== i) })} className="mt-1" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-line px-2 py-1.5">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...c, variables: [...c.variables, { name: "", secret: false, values: {} }] })}>
              <Icon name="plus" className="size-3" /> Add variable
            </button>
            {errors["env.active"] && <span className="text-small text-danger">{errors["env.active"]}</span>}
          </div>
        </div>
      )}
      {c.variables.some((v) => v.secret) && <p className="mt-2 text-small text-text4">Secret values are stored in plain text in the test file, masked here, and redacted in run history, samples and exports.</p>}
    </Block>
  );
}

const DIST_HINT: Record<Distribution, string> = {
  sequential: "Each iteration takes the next row, shared by every virtual user.",
  random: "Each iteration takes a random row. Never runs out.",
  unique_per_vu: "Each virtual user keeps one row for its whole life (one account per user).",
};

function DataFiles({ config: c, onChange, errors, pickFile, testId }: { config: TestConfig; onChange: (c: TestConfig) => void; errors: Errors; pickFile: (filters?: { name: string; extensions: string[] }[]) => ReturnType<PickFile>; testId: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    setProblem(null);
    const f = await pickFile([{ name: "CSV or JSON", extensions: ["csv", "tsv", "txt", "json"] }]);
    if (!f) return;
    setBusy(true);
    try {
      const format: DataFormat = /\.json$/i.test(f.name) ? "json" : "csv";
      const p = await api.previewData(testId, f.file, format, true);
      const base = f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "data";
      let name = base;
      for (let i = 2; c.data.some((d) => d.name === name); i++) name = `${base}${i}`;
      const file: DataFile = { id: uid("d"), name, file: f.file, original_name: f.name, format, has_header: true, columns: p.columns, secret_columns: [], rows: p.row_count, distribution: "sequential", on_exhausted: "wrap" };
      onChange({ ...c, data: [...c.data, file] });
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Block
      title="Data files"
      hint={<>CSV or JSON rows for virtual users, read as <code className="font-mono">{"{{file.column}}"}</code>. Files are copied into the test, so moving the original doesn't break it.</>}
      aside={
        <button type="button" className="btn btn-sm" onClick={() => void add()} disabled={busy}>
          <Icon name="upload" className="size-3" /> {busy ? "Reading…" : "Add file"}
        </button>
      }
    >
      {problem && <p role="alert" className="mb-2 text-small text-danger">{problem}</p>}
      {c.data.length === 0 ? (
        <Empty title="No data files" icon="list">
          Feed usernames, product IDs or search terms from a CSV. Each row becomes values like <code className="font-mono">{"{{users.email}}"}</code>.
        </Empty>
      ) : (
        <div className="space-y-3">
          {c.data.map((d) => (
            <DataFileCard key={d.id} file={d} testId={testId} error={errors[`data:${d.id}`]} onChange={(next) => onChange({ ...c, data: c.data.map((x) => (x.id === d.id ? next : x)) })} onRemove={() => onChange({ ...c, data: c.data.filter((x) => x.id !== d.id) })} />
          ))}
        </div>
      )}
    </Block>
  );
}

function DataFileCard({ file: d, testId, error, onChange, onRemove }: { file: DataFile; testId: string; error?: string; onChange: (d: DataFile) => void; onRemove: () => void }) {
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .previewData(testId, d.file, d.format, d.has_header)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setProblem(null);
        if (p.row_count !== d.rows || p.columns.join() !== d.columns.join()) onChange({ ...d, rows: p.row_count, columns: p.columns, secret_columns: d.secret_columns.filter((s) => p.columns.includes(s)) });
      })
      .catch((e) => live && setProblem(errorMessage(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testId, d.file, d.format, d.has_header]);
  return (
    <div className={`rounded-xl border ${error ? "border-danger/50" : "border-line"} bg-panel`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <label className="flex items-center gap-1 font-mono text-body">
          <input className="input h-7 w-36 font-mono font-medium" aria-label="Name used in templates" value={d.name} onChange={(e) => onChange({ ...d, name: e.target.value })} />
          <span className="text-text4">.column</span>
        </label>
        <span className="truncate text-small text-text3" title={d.original_name}>
          {d.original_name} · <span className="tabular font-mono">{fmtInt(d.rows)}</span> rows
        </span>
        <span className="flex-1" />
        <Toggle label="First row is a header" checked={d.has_header} onChange={(has_header) => onChange({ ...d, has_header })} disabled={d.format === "json"} />
        <IconButton icon="trash" size="sm" danger label={`Remove ${d.name}`} onClick={onRemove} />
      </div>
      <div className="grid grid-cols-2 gap-4 px-4 py-3">
        <Field label="Rows go to virtual users" hint={DIST_HINT[d.distribution]}>
          {(id) => (
            <Select<Distribution>
              id={id}
              value={d.distribution}
              onChange={(distribution) => onChange({ ...d, distribution })}
              options={[
                { value: "sequential", label: "In order, shared" },
                { value: "random", label: "At random" },
                { value: "unique_per_vu", label: "One per virtual user" },
              ]}
            />
          )}
        </Field>
        <Field label="When rows run out" hint={d.distribution === "random" ? "Random rows never run out." : undefined}>
          {(id) => (
            <Select<OnExhausted>
              id={id}
              disabled={d.distribution === "random"}
              value={d.on_exhausted}
              onChange={(on_exhausted) => onChange({ ...d, on_exhausted })}
              options={[
                { value: "wrap", label: "Start over from the first row" },
                { value: "stop_vu", label: "Stop that virtual user" },
                { value: "stop_run", label: "Stop the run" },
              ]}
            />
          )}
        </Field>
      </div>
      {(error || problem) && <p role="alert" className="px-4 pb-2 text-small text-danger">{error ?? problem}</p>}
      {preview && (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-small">
            <thead>
              <tr className="border-b border-line text-left text-text3">
                {preview.columns.map((col) => {
                  const secret = d.secret_columns.includes(col);
                  return (
                    <th key={col} className="px-3 py-1.5 font-medium whitespace-nowrap">
                      <span className="font-mono text-accent-ink">{col}</span>
                      <button
                        type="button"
                        className={`ml-1.5 align-[-2px] ${secret ? "text-warning" : "text-text4 hover:text-text2"}`}
                        title={secret ? "Secret: redacted in samples. Click to unmark." : "Mark as secret (redacted in samples)"}
                        aria-pressed={secret}
                        aria-label={`${col} is secret`}
                        onClick={() => onChange({ ...d, secret_columns: secret ? d.secret_columns.filter((x) => x !== col) : [...d.secret_columns, col] })}
                      >
                        <Icon name="lock" className="size-3" />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 5).map((r, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {r.map((cell, j) => (
                    <td key={j} className="max-w-60 truncate px-3 py-1 font-mono text-text2">
                      {d.secret_columns.includes(preview.columns[j]!) ? "••••" : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {preview.warnings.map((w) => (
            <p key={w} className="px-3 py-1.5 text-micro text-warning">{w}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function Cookies({ config: c, onChange }: { config: TestConfig; onChange: (c: TestConfig) => void }) {
  const p = c.cookies;
  const set = (patch: Partial<typeof p>) => onChange({ ...c, cookies: { ...p, ...patch } });
  const setSeed = (i: number, patch: Partial<SeedCookie>) => set({ seed: p.seed.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const HINT: Record<JarMode, string> = {
    per_vu: "Each virtual user has its own jar, like separate browsers. Set-Cookie responses are kept and sent back by domain and path.",
    shared: "One jar for every virtual user (a single shared session).",
    off: "Cookies are neither stored nor sent, except the ones a step sets itself.",
  };
  return (
    <Block title="Cookies" hint={HINT[p.mode]}>
      <div className="space-y-3">
        <div className="flex items-center gap-4">
          <Segmented<JarMode>
            aria-label="Cookie jar"
            value={p.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: "per_vu", label: "Jar per user" },
              { value: "shared", label: "Shared jar" },
              { value: "off", label: "Off" },
            ]}
          />
          {p.mode === "per_vu" && <Toggle label="Empty the jar at each iteration" checked={p.clear_each_iteration} onChange={(clear_each_iteration) => set({ clear_each_iteration })} />}
        </div>
        {p.mode !== "off" && (
          <div>
            <div className="label">Start every jar with</div>
            {p.seed.map((s, i) => (
              <div key={i} className="mb-1.5 flex items-center gap-1.5">
                <input className="input w-40! font-mono" placeholder="domain" aria-label={`Cookie ${i + 1} domain`} value={s.domain} onChange={(e) => setSeed(i, { domain: e.target.value })} />
                <input className="input w-20! font-mono" placeholder="/" aria-label={`Cookie ${i + 1} path`} value={s.path} onChange={(e) => setSeed(i, { path: e.target.value })} />
                <input className="input w-36! font-mono" placeholder="name" aria-label={`Cookie ${i + 1} name`} value={s.name} onChange={(e) => setSeed(i, { name: e.target.value })} />
                <input className="input min-w-0 flex-1 font-mono" type="password" placeholder="value" aria-label={`Cookie ${i + 1} value`} value={s.value} onChange={(e) => setSeed(i, { value: e.target.value })} />
                <label className="flex items-center gap-1 text-small text-text3">
                  <input type="checkbox" className="size-3.5" checked={s.secure} onChange={(e) => setSeed(i, { secure: e.target.checked })} /> HTTPS only
                </label>
                <IconButton icon="x" size="sm" label={`Remove cookie ${i + 1}`} onClick={() => set({ seed: p.seed.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <button type="button" className="btn btn-ghost btn-sm -ml-2" onClick={() => set({ seed: [...p.seed, { domain: "localhost", path: "/", name: "", value: "", secure: false }] })}>
              <Icon name="plus" className="size-3" /> Add cookie
            </button>
          </div>
        )}
      </div>
    </Block>
  );
}
