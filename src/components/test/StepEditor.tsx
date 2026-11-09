import { useState } from "react";
import type { Auth, BodyKind, BodySpec, Check, CheckKind, CheckOp, CookieMode, Extractor, ExtractPick, ExtractSource, FormField, OnMissing, RequestStep, Sample } from "../../bindings";
import { METHODS, newBody, newCheck, newExtractor } from "../../lib/defaults";
import type { Errors } from "../../lib/stages";
import type { Name } from "../../lib/template";
import { isSensitiveHeader, jsonError } from "../../lib/validate";
import { TemplateInput } from "../TemplateInput";
import { Field, Icon, IconButton, Kbd, NumberInput, Pill, Segmented, Select, Spinner, Tabs, Toggle } from "../ui";
import { KeyValueTable } from "./KeyValueTable";
import { RunIfEditor, runIfText } from "./RunIfEditor";

type Tab = "params" | "headers" | "cookies" | "body" | "auth" | "extract" | "checks" | "options";

const BODY_KINDS: { value: BodyKind | "none"; label: string }[] = [
  { value: "none", label: "None" },
  { value: "json", label: "JSON" },
  { value: "xml", label: "XML" },
  { value: "text", label: "Text" },
  { value: "form", label: "Form (URL-encoded)" },
  { value: "multipart", label: "Multipart form" },
  { value: "graphql", label: "GraphQL" },
  { value: "binary", label: "Binary file" },
  { value: "raw", label: "Raw (custom type)" },
];

const AUTO_CT: Record<BodyKind, string> = {
  json: "application/json",
  graphql: "application/json",
  xml: "application/xml",
  text: "text/plain; charset=utf-8",
  form: "application/x-www-form-urlencoded",
  multipart: "multipart/form-data; boundary=…",
  binary: "application/octet-stream",
  raw: "application/octet-stream",
};

export type PickFile = () => Promise<{ file: string; name: string } | null>;

export function StepEditor(props: {
  step: RequestStep;
  onChange: (s: RequestStep) => void;
  names: Name[];
  errors: Errors;
  mix: boolean;
  inheritedHeaders: { name: string; value: string }[];
  defaultAuth: Auth;
  onSend: () => void;
  sending: boolean;
  lastSample: Sample | null;
  onPickFile: PickFile;
}) {
  const { step: s, onChange } = props;
  const [tab, setTab] = useState<Tab>(s.body ? "body" : "params");
  const set = (patch: Partial<RequestStep>) => onChange({ ...s, ...patch });
  const err = (k: string) => props.errors[`step:${s.id}.${k}`];
  const errPrefix = (k: string) => Object.keys(props.errors).some((x) => x.startsWith(`step:${s.id}.${k}`));
  const custom = !(METHODS as readonly string[]).includes(s.method);
  const rule = runIfText(s.run_if);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line px-5 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <input
            className="input h-7 max-w-80 border-transparent bg-transparent px-1.5 text-title font-semibold hover:border-line2"
            aria-label="Step name"
            placeholder={`${s.method} ${s.url.replace(/^[a-z]+:\/\/[^/]*/i, "") || "/"}`}
            value={s.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          {rule && (
            <button type="button" onClick={() => setTab("options")} title="Edit the Run if rule">
              <Pill tone="info">
                <Icon name="branch" /> {rule}
              </Pill>
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className="btn btn-sm" onClick={props.onSend} disabled={props.sending} aria-busy={props.sending} title="Send this request once with the current environment (⌘⇧S)">
            {props.sending ? <Spinner /> : <Icon name="bolt" className="size-3.5" />} {props.sending ? "Sending…" : "Send once"}
          </button>
        </div>
        <div className="flex gap-1.5">
          {custom ? (
            <input className="input w-28! shrink-0 font-mono font-semibold uppercase" aria-label="Method" value={s.method} onChange={(e) => set({ method: e.target.value.toUpperCase() })} />
          ) : (
            <select
              aria-label="Method"
              className="input w-28! shrink-0 font-mono font-semibold"
              value={s.method}
              onChange={(e) => set({ method: e.target.value === "custom" ? "PURGE" : e.target.value })}
            >
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          )}
          <TemplateInput
            value={s.url}
            onChange={(url) => set({ url })}
            names={props.names}
            placeholder="https://api.example.com/users or {{baseUrl}}/users"
            aria-label="URL"
            invalid={!!err("url")}
          />
        </div>
        {(err("url") || err("method")) && (
          <p role="alert" className="text-small text-danger">
            {err("url") ?? err("method")}
          </p>
        )}
      </div>

      <Tabs
        aria-label="Request sections"
        className="px-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "params", label: "Params", count: s.params.length, dot: errPrefix("params") ? "danger" : null },
          { value: "headers", label: "Headers", count: s.headers.length, dot: errPrefix("headers") ? "danger" : null },
          { value: "cookies", label: "Cookies", count: s.cookies.length, dot: errPrefix("cookies") ? "danger" : null },
          { value: "body", label: "Body", dot: errPrefix("body") ? "danger" : s.body ? "accent" : null },
          { value: "auth", label: "Auth", dot: errPrefix("auth") ? "danger" : s.auth.kind !== "inherit" ? "accent" : null },
          { value: "extract", label: "Extract", count: s.extract.length, dot: errPrefix("extract") ? "danger" : null },
          { value: "checks", label: "Checks", count: s.checks.length, dot: errPrefix("checks") ? "danger" : null },
          { value: "options", label: "Options", dot: errPrefix("run_if") || errPrefix("timeout") ? "danger" : s.run_if ? "accent" : null },
        ]}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-8 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]">
        {tab === "params" && (
          <KeyValueTable
            label="parameter"
            rows={s.params}
            onChange={(params) => set({ params })}
            names={props.names}
            templateNames
            errors={(i) => err(`params.${i}`)}
            empty="No query parameters. They're added to the URL, encoded."
          />
        )}
        {tab === "headers" && (
          <KeyValueTable
            label="header"
            rows={s.headers}
            onChange={(headers) => set({ headers })}
            names={props.names}
            sensitive={isSensitiveHeader}
            inherited={props.inheritedHeaders}
            errors={(i) => err(`headers.${i}`)}
            empty="No headers. Content-Type follows the body; auth goes in the Auth tab."
          />
        )}
        {tab === "cookies" && (
          <div className="space-y-4">
            <Field label="Cookie jar for this step" hint={COOKIE_HINT[s.cookie_mode]}>
              {() => (
                <Segmented
                  aria-label="Cookie jar for this step"
                  value={s.cookie_mode}
                  onChange={(cookie_mode: CookieMode) => set({ cookie_mode })}
                  options={[
                    { value: "jar", label: "Use the jar" },
                    { value: "clear_before", label: "Clear jar first" },
                    { value: "no_jar", label: "No jar" },
                  ]}
                />
              )}
            </Field>
            <div>
              <div className="label">Extra cookies</div>
              <KeyValueTable label="cookie" rows={s.cookies} onChange={(cookies) => set({ cookies })} names={props.names} sensitive={() => true} errors={(i) => err(`cookies.${i}`)} empty="None. Cookies the server set earlier come from the jar." />
            </div>
          </div>
        )}
        {tab === "body" && <BodyEditor step={s} set={set} names={props.names} error={err("body")} errors={props.errors} onPickFile={props.onPickFile} />}
        {tab === "auth" && <AuthEditor auth={s.auth} onChange={(auth) => set({ auth })} names={props.names} error={err("auth")} defaultAuth={props.defaultAuth} />}
        {tab === "extract" && <ExtractEditor step={s} set={set} errors={props.errors} sample={props.lastSample} />}
        {tab === "checks" && <ChecksEditor step={s} set={set} errors={props.errors} sample={props.lastSample} />}
        {tab === "options" && (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-body font-semibold">Run if</h3>
              <RunIfEditor value={s.run_if} onChange={(run_if) => set({ run_if })} error={err("run_if")} />
            </section>
            <section className="grid grid-cols-3 gap-3 border-t border-line pt-4">
              <Field label="Timeout" optional error={err("timeout")} hint="Empty: the test default.">
                {(id) => <NumberInput id={id} suffix="ms" value={s.timeout_ms} placeholder="default" onChange={(v) => set({ timeout_ms: v })} />}
              </Field>
              <Field label="Follow redirects" hint="Each hop is host-checked.">
                {(id) => (
                  <Select
                    id={id}
                    value={s.follow_redirects === null ? "default" : s.follow_redirects ? "yes" : "no"}
                    onChange={(v) => set({ follow_redirects: v === "default" ? null : v === "yes" })}
                    options={[
                      { value: "default", label: "Test default" },
                      { value: "yes", label: "Follow" },
                      { value: "no", label: "Don't follow" },
                    ]}
                  />
                )}
              </Field>
              <Field label="Read at most" optional hint="For extraction and checks.">
                {(id) => <NumberInput id={id} suffix="KB" value={s.max_response_kb} placeholder="default" onChange={(v) => set({ max_response_kb: v })} />}
              </Field>
              {props.mix && (
                <Field label="Weight" error={err("weight")} hint="Share of the mix, relative to the other steps.">
                  {(id) => <NumberInput id={id} min={0} value={s.weight} onChange={(v) => set({ weight: v ?? 0 })} />}
                </Field>
              )}
            </section>
            <section className="border-t border-line pt-4">
              <h3 className="mb-1 text-body font-semibold">Values</h3>
              <p className="mb-2 text-small text-text3">
                Computed once before the request, so one generated value can appear in the URL, a header and the body. Each bare <code className="font-mono">{"{{$uuid}}"}</code> is fresh; <code className="font-mono">{"{{orderId}}"}</code> repeats.
              </p>
              <KeyValueTable label="value" rows={s.values} onChange={(values) => set({ values })} names={props.names} namePlaceholder="orderId" valuePlaceholder="{{$uuid}}" errors={(i) => err(`values.${i}`)} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

const COOKIE_HINT: Record<CookieMode, string> = {
  jar: "Sends cookies the server set earlier for this user, and stores new ones.",
  clear_before: "Empties this user's jar before sending (a fresh session from here on).",
  no_jar: "Neither sends nor stores jar cookies for this request.",
};

function BodyEditor({ step: s, set, names, error, errors, onPickFile }: { step: RequestStep; set: (p: Partial<RequestStep>) => void; names: Name[]; error?: string; errors: Errors; onPickFile: PickFile }) {
  const b = s.body;
  const kind: BodyKind | "none" = b?.kind ?? "none";
  const setBody = (patch: Partial<BodySpec>) => b && set({ body: { ...b, ...patch } });
  const localJson = b?.kind === "json" ? jsonError(b.content) : null;
  const ctHeader = s.headers.find((h) => h.enabled && h.name.trim().toLowerCase() === "content-type");
  const pick = async (apply: (f: { file: string; name: string }) => void) => {
    const f = await onPickFile();
    if (f) apply(f);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Select
          aria-label="Body type"
          className="w-52!"
          value={kind}
          onChange={(k) => set({ body: k === "none" ? null : newBody(k, b) })}
          options={BODY_KINDS}
        />
        {b && b.kind !== "multipart" && b.kind !== "form" && (
          <span className="text-small text-text3">
            Content-Type: <span className="font-mono text-text2">{ctHeader?.value || b.content_type || AUTO_CT[b.kind]}</span>
          </span>
        )}
        {b?.kind === "json" && (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            onClick={() => {
              try {
                const holes: string[] = [];
                const text = b.content.replace(/\{\{[^}]*\}\}/g, (m) => `"__toad_${holes.push(m) - 1}__"`);
                const out = JSON.stringify(JSON.parse(text), null, 2).replace(/"__toad_(\d+)__"/g, (_, i) => holes[Number(i)]!);
                setBody({ content: out });
              } catch {
                /* invalid: the error below says why */
              }
            }}
          >
            Format JSON
          </button>
        )}
      </div>
      {!b && <p className="text-small text-text3">No body. GET and HEAD requests usually don't have one.</p>}
      {b && ["json", "xml", "text", "raw"].includes(b.kind) && (
        <TemplateInput multiline rows={10} value={b.content} onChange={(content) => setBody({ content })} names={names} aria-label="Request body" invalid={!!error || !!localJson} placeholder={b.kind === "json" ? '{ "user": "{{users.email}}", "id": "{{$uuid}}" }' : ""} />
      )}
      {b?.kind === "graphql" && (
        <>
          <Field label="Query">{() => <TemplateInput multiline rows={8} value={b.content} onChange={(content) => setBody({ content })} names={names} aria-label="GraphQL query" placeholder="query { me { id name } }" />}</Field>
          <Field label="Variables" optional hint="JSON object, templates allowed.">
            {() => <TemplateInput multiline rows={4} value={b.variables} onChange={(variables) => setBody({ variables })} names={names} aria-label="GraphQL variables" placeholder='{ "id": "{{userId}}" }' />}
          </Field>
        </>
      )}
      {b && (b.kind === "form" || b.kind === "multipart") && (
        <FormFields
          fields={b.fields}
          multipart={b.kind === "multipart"}
          onChange={(fields) => setBody({ fields })}
          names={names}
          errors={(i) => errors[`step:${s.id}.body.${i}`]}
          pick={(i) => pick((f) => setBody({ fields: b.fields.map((x, j) => (j === i ? { ...x, value: f.file } : x)) }))}
        />
      )}
      {b?.kind === "binary" && (
        <div className="flex items-center gap-3">
          <button type="button" className="btn" onClick={() => pick((f) => setBody({ file: f.file }))}>
            <Icon name="upload" className="size-3.5" /> {b.file ? "Replace file" : "Choose file"}
          </button>
          <span className="font-mono text-small text-text2">{b.file ? b.file.replace(/^[0-9a-f]{12}-/, "") : "No file yet"}</span>
        </div>
      )}
      {(error || localJson) && (
        <p role="alert" className="text-small text-danger">
          {error ?? `Not valid JSON: ${localJson}`}
        </p>
      )}
      {b && (
        <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
          <Field label="Content-Type" optional hint={ctHeader ? "A Content-Type header is set in Headers; it wins." : `Empty: ${AUTO_CT[b.kind]}`}>
            {(id) => <input id={id} className="input font-mono" placeholder={AUTO_CT[b.kind]} value={b.content_type} disabled={b.kind === "multipart"} onChange={(e) => setBody({ content_type: e.target.value })} />}
          </Field>
          <div className="pt-6">
            <Toggle label="Compress with gzip" hint="Sends Content-Encoding: gzip." checked={b.gzip} onChange={(gzip) => setBody({ gzip })} />
          </div>
        </div>
      )}
    </div>
  );
}

function FormFields(props: { fields: FormField[]; multipart: boolean; onChange: (f: FormField[]) => void; names: Name[]; errors: (i: number) => string | undefined; pick: (i: number) => void }) {
  const set = (i: number, patch: Partial<FormField>) => props.onChange(props.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-1.5">
      {props.fields.map((f, i) => (
        <div key={i}>
          <div className="flex items-center gap-1.5">
            <input type="checkbox" className="size-3.5" aria-label={`Send field ${i + 1}`} checked={f.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />
            <input className="input w-2/5! font-mono" placeholder="Field" aria-label={`Field ${i + 1} name`} value={f.name} onChange={(e) => set(i, { name: e.target.value })} />
            {f.file ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <button type="button" className="btn btn-sm" onClick={() => props.pick(i)}>
                  <Icon name="upload" className="size-3" /> {f.value ? "Replace" : "Choose file"}
                </button>
                <span className="truncate font-mono text-small text-text2">{f.value.replace(/^[0-9a-f]{12}-/, "")}</span>
              </div>
            ) : (
              <TemplateInput value={f.value} onChange={(value) => set(i, { value })} names={props.names} placeholder="Value" aria-label={`Field ${i + 1} value`} />
            )}
            {props.multipart && (
              <Select
                aria-label={`Field ${i + 1} type`}
                className="w-20! shrink-0"
                value={f.file ? "file" : "text"}
                onChange={(v) => set(i, { file: v === "file", value: "" })}
                options={[
                  { value: "text", label: "Text" },
                  { value: "file", label: "File" },
                ]}
              />
            )}
            <IconButton icon="x" size="sm" label={`Remove field ${i + 1}`} onClick={() => props.onChange(props.fields.filter((_, j) => j !== i))} />
          </div>
          {props.errors(i) && <p role="alert" className="mt-1 ml-5 text-small text-danger">{props.errors(i)}</p>}
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm -ml-2" onClick={() => props.onChange([...props.fields, { name: "", value: "", enabled: true, file: false }])}>
        <Icon name="plus" className="size-3" /> Add field
      </button>
    </div>
  );
}

function authLabel(a: Auth): string {
  switch (a.kind) {
    case "none":
    case "inherit":
      return "none";
    case "bearer":
      return "Bearer token";
    case "basic":
      return `Basic (${a.username || "no user"})`;
    case "api_key":
      return `API key in ${a.location} ${a.name}`;
  }
}

export function AuthEditor({ auth, onChange, names, error, defaultAuth }: { auth: Auth; onChange: (a: Auth) => void; names: Name[]; error?: string; defaultAuth?: Auth }) {
  const kinds: { value: Auth["kind"]; label: string }[] = [
    ...(defaultAuth ? [{ value: "inherit" as const, label: `Test default (${authLabel(defaultAuth)})` }] : []),
    { value: "none", label: "None" },
    { value: "bearer", label: "Bearer token" },
    { value: "basic", label: "Basic" },
    { value: "api_key", label: "API key" },
  ];
  const pick = (k: Auth["kind"]): Auth =>
    k === "bearer" ? { kind: k, token: "" } : k === "basic" ? { kind: k, username: "", password: "" } : k === "api_key" ? { kind: k, name: "X-API-Key", value: "", location: "header" } : { kind: k };
  return (
    <div className="space-y-3">
      <Select aria-label="Auth type" className="w-72!" value={auth.kind} onChange={(k) => onChange(pick(k))} options={kinds} />
      {auth.kind === "bearer" && (
        <Field label="Token" hint={<>Sent as <code className="font-mono">Authorization: Bearer …</code>. To log in first, extract a token in an earlier step and write <code className="font-mono">{"{{token}}"}</code>.</>}>
          {(id) => <TemplateInput id={id} value={auth.token} onChange={(token) => onChange({ ...auth, token })} names={names} placeholder="{{token}}" />}
        </Field>
      )}
      {auth.kind === "basic" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username">{(id) => <TemplateInput id={id} value={auth.username} onChange={(username) => onChange({ ...auth, username })} names={names} />}</Field>
          <Field label="Password">{(id) => <input id={id} type="password" className="input font-mono" value={auth.password} onChange={(e) => onChange({ ...auth, password: e.target.value })} />}</Field>
        </div>
      )}
      {auth.kind === "api_key" && (
        <div className="grid grid-cols-[1fr_1fr_auto] gap-3">
          <Field label="Name">{(id) => <input id={id} className="input font-mono" value={auth.name} onChange={(e) => onChange({ ...auth, name: e.target.value })} />}</Field>
          <Field label="Value">{(id) => <TemplateInput id={id} value={auth.value} onChange={(value) => onChange({ ...auth, value })} names={names} />}</Field>
          <Field label="Send in">
            {() => (
              <Segmented
                aria-label="Send the API key in"
                value={auth.location}
                onChange={(location) => onChange({ ...auth, location })}
                options={[
                  { value: "header", label: "Header" },
                  { value: "query", label: "Query" },
                ]}
              />
            )}
          </Field>
        </div>
      )}
      {auth.kind !== "inherit" && auth.kind !== "none" && <p className="text-small text-text3">Stored in plain text in the test file; masked here and redacted in run history and exports.</p>}
      {error && <p role="alert" className="text-small text-danger">{error}</p>}
      {auth.kind !== "bearer" && auth.kind !== "inherit" && (
        <p className="text-small text-text4">
          OAuth and other login flows: add a login step (or a Setup step), extract the token, then use Bearer with <code className="font-mono">{"{{token}}"}</code>.
        </p>
      )}
    </div>
  );
}

const SOURCES: { value: ExtractSource; label: string; placeholder: string }[] = [
  { value: "json", label: "JSON body", placeholder: "$.data.token" },
  { value: "xpath", label: "XML body", placeholder: "//order/@id" },
  { value: "header", label: "Header", placeholder: "Location" },
  { value: "cookie", label: "Set-Cookie", placeholder: "session" },
  { value: "regex", label: "Regex on body", placeholder: "order=(\\d+)" },
  { value: "status", label: "Status code", placeholder: "" },
  { value: "latency", label: "Response time", placeholder: "" },
];

function ExtractEditor({ step: s, set, errors, sample }: { step: RequestStep; set: (p: Partial<RequestStep>) => void; errors: Errors; sample: Sample | null }) {
  const upd = (i: number, patch: Partial<Extractor>) => set({ extract: s.extract.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  return (
    <div className="space-y-3">
      <p className="text-small text-text3">
        Capture values from the response for later steps, as <code className="font-mono">{"{{name}}"}</code>. Each virtual user keeps its own. Use Send once to see what each rule finds.
      </p>
      {s.extract.map((e, i) => {
        const src = SOURCES.find((x) => x.value === e.source)!;
        const live = sample?.extracted.find((x) => x.id === e.id);
        const error = errors[`step:${s.id}.extract.${e.id}`];
        return (
          <div key={e.id} className={`space-y-2 rounded-xl border p-3 ${error ? "border-danger/50" : "border-line"}`}>
            <div className="flex items-center gap-1.5">
              <input type="checkbox" className="size-3.5" aria-label={`Use rule ${i + 1}`} checked={e.enabled} onChange={(x) => upd(i, { enabled: x.target.checked })} />
              <input className="input w-36! font-mono text-accent-ink" placeholder="variable" aria-label={`Rule ${i + 1} variable name`} value={e.var} onChange={(x) => upd(i, { var: x.target.value })} />
              <span className="text-small text-text3">from</span>
              <Select aria-label={`Rule ${i + 1} source`} className="w-36! shrink-0" value={e.source} onChange={(source) => upd(i, { source, expr: SOURCES.find((x) => x.value === source)!.placeholder })} options={SOURCES} />
              {src.placeholder !== "" ? (
                <input className="input min-w-0 flex-1 font-mono" placeholder={src.placeholder} aria-label={`Rule ${i + 1} expression`} value={e.expr} onChange={(x) => upd(i, { expr: x.target.value })} />
              ) : (
                <span className="flex-1" />
              )}
              <IconButton icon="x" size="sm" label={`Remove rule ${i + 1}`} onClick={() => set({ extract: s.extract.filter((_, j) => j !== i) })} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-5 text-small text-text3">
              <label className="flex items-center gap-1.5">
                Take
                <Select<ExtractPick>
                  aria-label={`Rule ${i + 1} match`}
                  className="h-7! w-28! text-small"
                  value={e.pick}
                  onChange={(pick) => upd(i, { pick })}
                  options={[
                    { value: "first", label: "first match" },
                    { value: "last", label: "last match" },
                    { value: "random", label: "a random one" },
                    { value: "all", label: "all (JSON array)" },
                    { value: "index", label: "match #" },
                  ]}
                />
                {e.pick === "index" && <input type="number" className="input h-7 w-16 font-mono text-small" aria-label={`Rule ${i + 1} index`} value={e.index} min={0} onChange={(x) => upd(i, { index: Math.max(0, Number(x.target.value) || 0) })} />}
              </label>
              <label className="flex items-center gap-1.5">
                If missing
                <Select<OnMissing>
                  aria-label={`Rule ${i + 1} when missing`}
                  className="h-7! w-48! text-small"
                  value={e.on_missing}
                  onChange={(on_missing) => upd(i, { on_missing })}
                  options={[
                    { value: "skip_iteration", label: "skip the rest of the iteration" },
                    { value: "fail_step", label: "count this request as failed" },
                    { value: "use_default", label: "use a default" },
                  ]}
                />
                {e.on_missing === "use_default" && <input className="input h-7 w-32 font-mono text-small" placeholder="default" aria-label={`Rule ${i + 1} default`} value={e.default} onChange={(x) => upd(i, { default: x.target.value })} />}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="size-3.5" checked={e.secret} onChange={(x) => upd(i, { secret: x.target.checked })} /> Secret (redacted in samples)
              </label>
            </div>
            {live && (
              <p className="flex items-center gap-1 pl-5 font-mono text-small">
                <Icon name="arrowRight" className={`size-3 shrink-0 ${live.value !== null ? "text-success" : "text-danger"}`} />
                {live.value !== null ? (
                  <span className="text-success">{live.secret ? "•••••• (secret)" : live.value}</span>
                ) : (
                  <span className="text-danger">{live.error ?? "nothing matched"}</span>
                )}
                <span className="ml-2 font-sans text-micro text-text4">last Send once</span>
              </p>
            )}
            {error && <p role="alert" className="pl-5 text-small text-danger">{error}</p>}
          </div>
        );
      })}
      <button type="button" className="btn btn-sm" onClick={() => set({ extract: [...s.extract, newExtractor()] })}>
        <Icon name="plus" className="size-3" /> Add extraction
      </button>
    </div>
  );
}

const CHECK_KINDS: { value: CheckKind; label: string; expr?: string }[] = [
  { value: "status", label: "Status" },
  { value: "body", label: "Body" },
  { value: "json", label: "JSON path", expr: "$.data.id" },
  { value: "xpath", label: "XPath", expr: "//status" },
  { value: "header", label: "Header", expr: "Content-Type" },
  { value: "latency", label: "Latency (ms)" },
];

const CHECK_OPS: { value: CheckOp; label: string }[] = [
  { value: "equals", label: "=" },
  { value: "not_equals", label: "≠" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "matches", label: "matches regex" },
  { value: "exists", label: "exists" },
  { value: "missing", label: "is missing" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "in_range", label: "in range" },
];

function ChecksEditor({ step: s, set, errors, sample }: { step: RequestStep; set: (p: Partial<RequestStep>) => void; errors: Errors; sample: Sample | null }) {
  const upd = (i: number, patch: Partial<Check>) => set({ checks: s.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="space-y-3">
      <p className="text-small text-text3">
        Assertions on every response. A failed check is always counted; switch on <span className="text-text2">Fails the request</span> to also count the request as failed (it then shows in the error rate).
      </p>
      {s.checks.map((c, i) => {
        const k = CHECK_KINDS.find((x) => x.value === c.kind)!;
        const live = sample?.checks.find((x) => x.id === c.id);
        const error = errors[`step:${s.id}.checks.${c.id}`];
        const noValue = c.op === "exists" || c.op === "missing";
        return (
          <div key={c.id}>
            <div className="flex items-center gap-1.5">
              <input type="checkbox" className="size-3.5" aria-label={`Use check ${i + 1}`} checked={c.enabled} onChange={(x) => upd(i, { enabled: x.target.checked })} />
              <Select aria-label={`Check ${i + 1} subject`} className="w-32! shrink-0" value={c.kind} onChange={(kind) => upd(i, { kind, expr: CHECK_KINDS.find((x) => x.value === kind)!.expr ?? "" })} options={CHECK_KINDS} />
              {k.expr !== undefined && <input className="input w-44! shrink-0 font-mono" placeholder={k.expr} aria-label={`Check ${i + 1} path or name`} value={c.expr} onChange={(x) => upd(i, { expr: x.target.value })} />}
              <Select aria-label={`Check ${i + 1} comparison`} className="w-36! shrink-0" value={c.op} onChange={(op) => upd(i, { op })} options={CHECK_OPS} />
              {noValue ? <span className="flex-1" /> : <input className="input min-w-0 flex-1 font-mono" placeholder={c.op === "in_range" ? "200-299" : "value"} aria-label={`Check ${i + 1} expected value`} value={c.value} onChange={(x) => upd(i, { value: x.target.value })} />}
              <label className="flex shrink-0 items-center gap-1 text-small text-text3" title="When on, a failed check counts the request as failed">
                <input type="checkbox" className="size-3.5" checked={c.fails_request} onChange={(x) => upd(i, { fails_request: x.target.checked })} /> Fails the request
              </label>
              <IconButton icon="x" size="sm" label={`Remove check ${i + 1}`} onClick={() => set({ checks: s.checks.filter((_, j) => j !== i) })} />
            </div>
            {live && (
              <p className={`mt-1 ml-5 font-mono text-small ${live.passed ? "text-success" : "text-danger"}`}>
                {live.passed ? "passed" : "failed"} · got {live.actual} <span className="font-sans text-micro text-text4">last Send once</span>
              </p>
            )}
            {error && <p role="alert" className="mt-1 ml-5 text-small text-danger">{error}</p>}
          </div>
        );
      })}
      <button type="button" className="btn btn-sm" onClick={() => set({ checks: [...s.checks, newCheck()] })}>
        <Icon name="plus" className="size-3" /> Add check
      </button>
      <p className="text-small text-text4">
        The status must also fall in the test's success range (Checks stage). <Kbd>⌘⇧S</Kbd> sends once.
      </p>
    </div>
  );
}
