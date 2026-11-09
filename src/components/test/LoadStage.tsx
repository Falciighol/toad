import type { ClientCert, Executor, RateUnit, Scenario, Settings, TestConfig } from "../../bindings";
import { uid } from "../../lib/defaults";
import { estimateTest, ASSUMED_LATENCY_MS } from "../../lib/estimate";
import { updateScenario } from "../../lib/flow";
import { fmtInt, fmtPerTime, fmtRps, fmtSecs } from "../../lib/format";
import { convert, duration, isOpen, isStaged, peakPerSec, RATE_UNITS, rateSuffix, rateUnit, span } from "../../lib/profile";
import type { Errors } from "../../lib/stages";
import { DurationInput, Field, Icon, IconButton, NumberInput, Segmented, Toggle, UnitNumberInput } from "../ui";
import { Block, StageHeader } from "./DataStage";
import { ProfileChart } from "./ProfileChart";
import type { PickFile } from "./StepEditor";

type Model = "vus" | "rate" | "iterations";
const modelOf = (e: Executor): Model => (e.kind === "rate" || e.kind === "ramping_rate" ? "rate" : e.kind === "iterations" ? "iterations" : "vus");

const SCENARIO_COLORS = ["text-series1", "text-series2", "text-series3"];

export function LoadStage({ config: c, onChange, errors, settings, pickFile }: { config: TestConfig; onChange: (c: TestConfig) => void; errors: Errors; settings: Settings; pickFile: (filters?: { name: string; extensions: string[] }[]) => ReturnType<PickFile> }) {
  const est = estimateTest(c);
  const enabled = c.scenarios.filter((s) => s.enabled);
  const timeMax = Math.max(1, ...enabled.map((s) => span(s)[1]));
  return (
    <div className="mx-auto max-w-5xl px-8 py-7">
      <StageHeader title="Load">How hard each scenario pushes, over time. Drag the points on a profile, or type exact stages below it.</StageHeader>
      {enabled.length > 1 && <Timeline scenarios={enabled} timeMax={timeMax} />}
      {c.scenarios.map((sc, i) => (
        <ScenarioLoad
          key={sc.id}
          scenario={sc}
          colorClass={SCENARIO_COLORS[i % 3]!}
          timeMax={enabled.length > 1 ? timeMax : undefined}
          error={errors[`scenario:${sc.id}.load`] ?? errors[`scenario:${sc.id}.graceful`]}
          showName={c.scenarios.length > 1}
          estimate={est.scenarios.find((e) => e.id === sc.id)}
          onChange={(s) => onChange(updateScenario(c, sc.id, () => s))}
        />
      ))}
      <Estimate config={c} settings={settings} />
      <Connection config={c} onChange={onChange} errors={errors} pickFile={pickFile} />
    </div>
  );
}

function Timeline({ scenarios, timeMax }: { scenarios: Scenario[]; timeMax: number }) {
  return (
    <div className="mb-6 rounded-xl border border-line bg-panel px-4 py-3">
      <div className="mb-2 text-small font-medium text-text3">Scenarios run at the same time</div>
      <div className="space-y-1.5">
        {scenarios.map((s, i) => {
          const [a, b] = span(s);
          return (
            <div key={s.id} className="grid grid-cols-[140px_1fr] items-center gap-3">
              <span className="truncate text-small text-text2">{s.name}</span>
              <div className="relative h-4 rounded bg-raised">
                <div className={`absolute inset-y-0 rounded ${["bg-series1", "bg-series2", "bg-series3"][i % 3]}`} style={{ left: `${(a / timeMax) * 100}%`, width: `${Math.max(0.5, ((b - a) / timeMax) * 100)}%` }} title={`${fmtSecs(a)} → ${fmtSecs(b)}`} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 grid grid-cols-[140px_1fr] gap-3">
        <span />
        <div className="flex justify-between font-mono text-micro text-text4">
          <span>0 s</span>
          <span>{fmtSecs(timeMax)}</span>
        </div>
      </div>
    </div>
  );
}

function ScenarioLoad(props: { scenario: Scenario; colorClass: string; timeMax?: number; error?: string; showName: boolean; estimate?: ReturnType<typeof estimateTest>["scenarios"][number]; onChange: (s: Scenario) => void }) {
  const sc = props.scenario;
  const e = sc.executor;
  const set = (patch: Partial<Scenario>) => props.onChange({ ...sc, ...patch });
  const setE = (executor: Executor) => set({ executor });
  const model = modelOf(e);
  const staged = isStaged(e);
  const est = props.estimate;
  return (
    <section className={`mb-6 rounded-xl border bg-panel ${props.error ? "border-danger/50" : "border-line"} ${sc.enabled ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        {props.showName && (
          <span className={`flex items-center gap-2 text-title font-semibold ${sc.enabled ? "" : "line-through"}`}>
            <span className={`size-2.5 rounded-full bg-current ${props.colorClass}`} />
            {sc.name}
          </span>
        )}
        <Segmented<Model>
          aria-label="Load model"
          value={model}
          onChange={(m) => setE(convert(e, m === "vus" ? (staged ? "ramping_vus" : "vus") : m === "rate" ? (staged ? "ramping_rate" : "rate") : "iterations"))}
          options={[
            { value: "vus", label: "Virtual users", title: "Closed model: N users each run an iteration, then the next" },
            { value: "rate", label: "Arrival rate", title: "Open model: iterations start on a schedule, whatever the target's speed" },
            { value: "iterations", label: "Fixed iterations", title: "Run exactly N iterations, shared by the users" },
          ]}
        />
        {model !== "iterations" && (
          <Segmented
            size="sm"
            aria-label="Profile shape"
            value={staged ? "staged" : "constant"}
            onChange={(v) => setE(convert(e, model === "vus" ? (v === "staged" ? "ramping_vus" : "vus") : v === "staged" ? "ramping_rate" : "rate"))}
            options={[
              { value: "constant", label: "Constant" },
              { value: "staged", label: "Stages" },
            ]}
          />
        )}
        <span className="flex-1" />
        {est && (
          <span className="tabular font-mono text-small text-text3">
            ≈{fmtInt(est.iterations)} iterations · ≈{fmtInt(est.requests)} requests · {fmtSecs(est.secs)}
          </span>
        )}
      </div>
      <div className="px-2 pt-2">
        <ProfileChart executor={e} onChange={setE} offset={props.timeMax ? sc.start_offset_secs : 0} timeMax={props.timeMax} label={`${sc.name} load profile`} />
      </div>
      <div className="space-y-4 px-4 pt-2 pb-4">
        {props.error && <p role="alert" className="text-small text-danger">{props.error}</p>}
        <ExecutorFields executor={e} onChange={setE} perIteration={est?.perIteration ?? 1} />
        <div className="grid grid-cols-4 gap-4 border-t border-line pt-4">
          <Field label="Start after" hint="Offset from the run's start.">
            {(id) => <DurationInput id={id} min={0} value={sc.start_offset_secs} onChange={(v) => set({ start_offset_secs: Math.max(0, v ?? 0) })} />}
          </Field>
          <Field label="Graceful stop" hint="In-flight iterations may finish; then they're cancelled.">
            {(id) => <DurationInput id={id} units={["s", "min"]} min={0} value={sc.graceful_stop_secs} onChange={(v) => set({ graceful_stop_secs: Math.max(0, v ?? 0) })} />}
          </Field>
        </div>
      </div>
    </section>
  );
}

const UNIT_WORD: Record<RateUnit, string> = { second: "second", minute: "minute", hour: "hour" };

/** An arrival rate: whole iterations per second, minute or hour, the unit in a dropdown beside it. */
export function RateInput(props: { id?: string; value: number; unit: RateUnit; min: number; onChange: (v: number) => void; onUnit: (u: RateUnit) => void; "aria-label"?: string }) {
  return (
    <UnitNumberInput
      id={props.id}
      aria-label={props["aria-label"]}
      unitLabel="Rate unit"
      value={props.value}
      min={props.min}
      unit={props.unit}
      units={RATE_UNITS.map((u) => ({ value: u.value, label: u.short, title: `iterations ${u.label}` }))}
      onUnit={props.onUnit}
      onChange={(raw) => props.onChange(raw === "" ? 0 : Math.max(props.min, Math.round(Number(raw)) || 0))}
    />
  );
}

function ExecutorFields({ executor: e, onChange, perIteration }: { executor: Executor; onChange: (e: Executor) => void; perIteration: number }) {
  const u = rateUnit(e);
  const rateNote = (rate: number) => (perIteration > 1 ? `≈ ${fmtInt(rate * perIteration)} requests${rateSuffix(u)} (${perIteration} per iteration)` : "1 request per iteration");
  switch (e.kind) {
    case "vus":
      return (
        <div className="grid grid-cols-4 gap-4">
          <Field label="Virtual users">{(id) => <NumberInput id={id} min={1} value={e.vus} onChange={(v) => onChange({ ...e, vus: v ?? 0 })} />}</Field>
          <Field label="Duration">{(id) => <DurationInput id={id} min={1} value={e.duration_secs} onChange={(v) => onChange({ ...e, duration_secs: v ?? 0 })} />}</Field>
        </div>
      );
    case "iterations":
      return (
        <div className="grid grid-cols-4 gap-4">
          <Field label="Virtual users">{(id) => <NumberInput id={id} min={1} value={e.vus} onChange={(v) => onChange({ ...e, vus: v ?? 0 })} />}</Field>
          <Field label="Iterations" hint="Total, shared.">{(id) => <NumberInput id={id} min={1} value={e.iterations} onChange={(v) => onChange({ ...e, iterations: v ?? 0 })} />}</Field>
          <Field label="Give up after" hint="Stops even if iterations remain.">{(id) => <DurationInput id={id} min={1} value={e.max_duration_secs} onChange={(v) => onChange({ ...e, max_duration_secs: v ?? 0 })} />}</Field>
        </div>
      );
    case "rate":
      return (
        <div className="grid grid-cols-4 gap-4">
          <Field label={`Iterations per ${UNIT_WORD[u]}`} hint={rateNote(e.rate)}>
            {(id) => <RateInput id={id} min={0} value={e.rate} unit={u} onChange={(rate) => onChange({ ...e, rate })} onUnit={(rate_unit) => onChange({ ...e, rate_unit })} />}
          </Field>
          <Field label="Duration">{(id) => <DurationInput id={id} min={1} value={e.duration_secs} onChange={(v) => onChange({ ...e, duration_secs: v ?? 0 })} />}</Field>
          <Field label="Max virtual users" hint="When all are busy, iterations wait and their delay shows in latency.">{(id) => <NumberInput id={id} min={1} value={e.max_vus} onChange={(v) => onChange({ ...e, max_vus: v ?? 0 })} />}</Field>
        </div>
      );
    case "ramping_vus":
    case "ramping_rate": {
      const open = e.kind === "ramping_rate";
      const total = duration(e);
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-4">
            {open ? (
              <Field label={`Start at (iterations per ${UNIT_WORD[u]})`} hint="The unit applies to every stage.">
                {(id) => <RateInput id={id} min={0} value={e.start} unit={u} onChange={(start) => onChange({ ...e, start })} onUnit={(rate_unit) => onChange({ ...e, rate_unit })} />}
              </Field>
            ) : (
              <Field label="Start with (users)">{(id) => <NumberInput id={id} min={0} value={e.start} onChange={(v) => onChange({ ...e, start: Math.max(0, v ?? 0) })} />}</Field>
            )}
            {open && <Field label="Max virtual users" hint="When all are busy, iterations wait.">{(id) => <NumberInput id={id} min={1} value={e.max_vus} onChange={(v) => onChange({ ...e, max_vus: v ?? 0 })} />}</Field>}
          </div>
          <table className="w-full max-w-xl text-body">
            <thead>
              <tr className="text-left text-small text-text3">
                <th className="w-16 py-1 font-medium">Stage</th>
                <th className="py-1 font-medium">Over</th>
                <th className="py-1 font-medium">Move to</th>
                <th className="w-24 py-1 font-medium">Ends at</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {e.stages.map((s, i) => {
                const end = e.stages.slice(0, i + 1).reduce((n, x) => n + x.duration_secs, 0);
                return (
                  <tr key={i}>
                    <td className="py-1 font-mono text-small text-text3">{i + 1}</td>
                    <td className="py-1 pr-2">
                      <DurationInput aria-label={`Stage ${i + 1} duration`} min={1} value={s.duration_secs} onChange={(v) => onChange({ ...e, stages: e.stages.map((x, j) => (j === i ? { ...x, duration_secs: v ?? 0 } : x)) })} />
                    </td>
                    <td className="py-1 pr-2">
                      <NumberInput aria-label={`Stage ${i + 1} target`} suffix={open ? rateSuffix(u) : "VUs"} min={0} value={s.target} onChange={(v) => onChange({ ...e, stages: e.stages.map((x, j) => (j === i ? { ...x, target: Math.max(0, v ?? 0) } : x)) })} />
                    </td>
                    <td className="tabular py-1 font-mono text-small text-text3">{fmtSecs(end)}</td>
                    <td className="py-1">
                      <IconButton icon="x" size="sm" label={`Remove stage ${i + 1}`} disabled={e.stages.length < 2} onClick={() => onChange({ ...e, stages: e.stages.filter((_, j) => j !== i) })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex items-center gap-3">
            <button type="button" className="btn btn-ghost btn-sm -ml-2" onClick={() => onChange({ ...e, stages: [...e.stages, { duration_secs: 30, target: e.stages[e.stages.length - 1]?.target ?? 10 }] })}>
              <Icon name="plus" className="size-3" /> Add stage
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...e, stages: [...e.stages, { duration_secs: Math.max(5, Math.round(total / 6)), target: 0 }] })}>
              Ramp down to 0
            </button>
            {open && <span className="text-small text-text3">{rateNote(Math.max(e.start, ...e.stages.map((s) => s.target)))} at the peak</span>}
          </div>
        </div>
      );
    }
  }
}

function Estimate({ config: c, settings }: { config: TestConfig; settings: Settings }) {
  const e = estimateTest(c);
  const overVus = e.peakVus > settings.max_concurrency;
  // Per second, whatever unit each scenario's rate is set in: the Settings ceiling is per second.
  const openRate = c.scenarios.filter((s) => s.enabled && isOpen(s.executor)).reduce((n, s) => n + peakPerSec(s.executor), 0);
  return (
    <Block title="This run" hint={e.latencyBound ? `Estimates for user-paced scenarios assume the target answers in ~${ASSUMED_LATENCY_MS} ms; the real numbers follow its speed.` : "Arrival-rate scenarios start iterations on schedule, so these numbers hold if the target keeps up."}>
      <dl className="grid grid-cols-5 gap-4">
        {[
          ["Length", fmtSecs(e.secs)],
          ["Requests", `≈${fmtInt(e.requests)}`],
          ["Peak rate", `≈${fmtPerTime(e.peakRps)}`],
          ["Peak users", fmtInt(e.peakVus)],
          ["Sockets", `up to ${fmtInt(e.peakVus)}`],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-micro text-text4">{k}</dt>
            <dd className="tabular font-mono text-title font-medium text-text">{v}</dd>
          </div>
        ))}
      </dl>
      {overVus && <p className="mt-3 text-small text-danger">Up to {fmtInt(e.peakVus)} virtual users across scenarios, over the Settings ceiling of {fmtInt(settings.max_concurrency)}.</p>}
      {openRate > settings.max_rps && <p className="mt-1 text-small text-danger">Up to {fmtRps(openRate)} iterations/s, over the Settings ceiling of {fmtInt(settings.max_rps)} per second.</p>}
      {e.scenarios.filter((s) => s.vusNeeded).map((s) => (
        <p key={s.id} className="mt-2 flex gap-1.5 text-small text-warning">
          <Icon name="alert" className="mt-px size-3.5" />
          {s.name}: at {ASSUMED_LATENCY_MS} ms per request, keeping the peak rate takes about {fmtInt(s.vusNeeded!)} virtual users. With fewer, iterations wait, which shows up in corrected latency.
        </p>
      ))}
      <p className="mt-3 text-micro text-text4">Each virtual user holds a socket. If the run reports "out of file descriptors", raise the limit (ulimit -n) or lower the users.</p>
    </Block>
  );
}

function Connection({ config: c, onChange, errors, pickFile }: { config: TestConfig; onChange: (c: TestConfig) => void; errors: Errors; pickFile: (filters?: { name: string; extensions: string[] }[]) => ReturnType<PickFile> }) {
  const k = c.connection;
  const set = (patch: Partial<typeof k>) => onChange({ ...c, connection: { ...k, ...patch } });
  const px = k.proxy;
  const setPx = (patch: Partial<typeof px>) => set({ proxy: { ...px, ...patch } });
  const addCert = async () => {
    const f = await pickFile([{ name: "PEM certificate", extensions: ["pem", "crt", "cer"] }]);
    if (!f) return;
    const cert: ClientCert = { id: uid("k"), host: "", cert_file: f.file, cert_name: f.name, key_file: "", key_name: "" };
    set({ client_certs: [...k.client_certs, cert] });
  };
  const setCert = (id: string, patch: Partial<ClientCert>) => set({ client_certs: k.client_certs.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  return (
    <Block title="Connection" hint="How Toad connects: pooling, protocol, TLS, name overrides, client certificates and a proxy.">
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3">
          <Toggle label="Keep connections alive" hint={k.keep_alive ? "Connections are reused between requests." : "A new connection per request (churns ports)."} checked={k.keep_alive} onChange={(keep_alive) => set({ keep_alive })} />
          <Toggle label="Allow invalid TLS certificates" hint="Skips certificate checks. Only for self-signed test servers." checked={k.allow_invalid_certs} onChange={(allow_invalid_certs) => set({ allow_invalid_certs })} />
          <Field label="Connection pool" hint={k.pool === "per_vu" ? "Each virtual user opens its own connections, like separate browsers." : "All users share one pool (fewer sockets)."}>
            {() => (
              <Segmented
                aria-label="Connection pool"
                value={k.pool}
                onChange={(pool) => set({ pool })}
                options={[
                  { value: "shared", label: "Shared" },
                  { value: "per_vu", label: "Per user" },
                ]}
              />
            )}
          </Field>
          <Field label="HTTP version" hint="HTTPS targets may negotiate HTTP/2 and multiplex over a few connections.">
            {() => (
              <Segmented
                aria-label="HTTP version"
                value={k.http}
                onChange={(http) => set({ http })}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "http1", label: "HTTP/1.1 only" },
                ]}
              />
            )}
          </Field>
        </div>

        <div>
          <div className="label">Host overrides</div>
          <p className="mb-2 text-small text-text3">Resolve a name to a fixed address for this test, like /etc/hosts. The safety check uses the override's address.</p>
          {k.host_overrides.map((o, i) => (
            <div key={i} className="mb-1.5">
              <div className="flex items-center gap-1.5">
                <input className="input w-60! font-mono" placeholder="api.local" aria-label={`Override ${i + 1} host`} value={o.host} onChange={(e) => set({ host_overrides: k.host_overrides.map((x, j) => (j === i ? { ...x, host: e.target.value } : x)) })} />
                <span className="text-text4">→</span>
                <input className="input w-48! font-mono" placeholder="127.0.0.1" aria-label={`Override ${i + 1} address`} value={o.address} onChange={(e) => set({ host_overrides: k.host_overrides.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)) })} />
                <IconButton icon="x" size="sm" label={`Remove override ${i + 1}`} onClick={() => set({ host_overrides: k.host_overrides.filter((_, j) => j !== i) })} />
              </div>
              {errors[`connection.host_overrides.${i}`] && <p role="alert" className="mt-1 text-small text-danger">{errors[`connection.host_overrides.${i}`]}</p>}
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm -ml-2" onClick={() => set({ host_overrides: [...k.host_overrides, { host: "", address: "127.0.0.1" }] })}>
            <Icon name="plus" className="size-3" /> Add override
          </button>
        </div>

        <div>
          <div className="label">Client certificates (mTLS)</div>
          <p className="mb-2 text-small text-text3">PEM certificate with an unencrypted key, in one file or two. Applies to an exact host, <code className="font-mono">*.example.com</code>, or every host. Files are copied into the test and stored in plain text.</p>
          {k.client_certs.map((cert) => (
            <div key={cert.id} className="mb-2 rounded-lg border border-line px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Icon name="lock" className="size-3.5 text-text3" />
                <span className="font-mono text-small text-text">{cert.cert_name}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    const f = await pickFile([{ name: "PEM key", extensions: ["pem", "key"] }]);
                    if (f) setCert(cert.id, { key_file: f.file, key_name: f.name });
                  }}
                >
                  {cert.key_file ? `Key: ${cert.key_name}` : "Add key file"}
                </button>
                <span className="text-small text-text3">for</span>
                <input className="input h-7 w-56 font-mono text-small" placeholder="every host" aria-label="Certificate host" value={cert.host} onChange={(e) => setCert(cert.id, { host: e.target.value })} />
                <span className="flex-1" />
                <IconButton icon="trash" size="sm" danger label="Remove certificate" onClick={() => set({ client_certs: k.client_certs.filter((x) => x.id !== cert.id) })} />
              </div>
              {errors[`connection.cert:${cert.id}`] && <p role="alert" className="mt-1 text-small text-danger">{errors[`connection.cert:${cert.id}`]}</p>}
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm -ml-2" onClick={() => void addCert()}>
            <Icon name="upload" className="size-3" /> Add certificate
          </button>
        </div>

        <div>
          <Toggle label="Send requests through a proxy" checked={px.enabled} onChange={(enabled) => setPx({ enabled })} />
          {px.enabled && (
            <div className="mt-3 space-y-3 rounded-lg border border-line px-3 py-3">
              <div className="grid grid-cols-[auto_1fr] gap-3">
                <Field label="Type">
                  {() => (
                    <Segmented
                      aria-label="Proxy type"
                      value={px.kind}
                      onChange={(kind) => setPx({ kind })}
                      options={[
                        { value: "http", label: "HTTP" },
                        { value: "https", label: "HTTPS" },
                        { value: "socks5", label: "SOCKS5" },
                      ]}
                    />
                  )}
                </Field>
                <Field label="Address" error={errors["connection.proxy"]}>
                  {(id) => <input id={id} className="input font-mono" placeholder="127.0.0.1:8888" value={px.address} onChange={(e) => setPx({ address: e.target.value })} />}
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Username" optional>{(id) => <input id={id} className="input font-mono" value={px.username} onChange={(e) => setPx({ username: e.target.value })} />}</Field>
                <Field label="Password" optional>{(id) => <input id={id} type="password" className="input font-mono" value={px.password} onChange={(e) => setPx({ password: e.target.value })} />}</Field>
                <Field label="Bypass for" optional hint="Comma-separated hosts.">{(id) => <input id={id} className="input font-mono" placeholder="localhost, 127.0.0.1" value={px.no_proxy} onChange={(e) => setPx({ no_proxy: e.target.value })} />}</Field>
              </div>
              <p className="flex gap-1.5 text-small text-warning">
                <Icon name="alert" className="mt-px size-3.5" />
                <span>
                  The proxy resolves target names itself, so Toad can't pin them to the addresses it checked (DNS rebinding protection is off). The proxy host must be local or confirmed, and every target is still checked by name. Latency includes the proxy hop.
                </span>
              </p>
            </div>
          )}
        </div>
      </div>
    </Block>
  );
}

