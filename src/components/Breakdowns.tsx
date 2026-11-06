import type { ErrorCount, ErrorKind, StatusCount, Warning } from "../bindings";
import { fmtInt, fmtPct } from "../lib/format";

const ERROR_LABEL: Record<ErrorKind, string> = {
  timeout: "Timeout",
  connect: "Connect",
  dns: "DNS",
  tls: "TLS",
  body_read: "Body read",
  status: "Non-success status",
  redirect: "Redirect",
  other: "Other",
};

function statusTone(code: number): { bar: string; label: string } {
  if (code < 300) return { bar: "bg-good", label: "2xx" };
  if (code < 400) return { bar: "bg-[var(--c-series-1)]", label: "3xx" };
  if (code < 500) return { bar: "bg-warning", label: "4xx" };
  return { bar: "bg-critical", label: "5xx" };
}

function Rows(props: { rows: { key: string; label: string; count: number; bar: string; tag?: string }[]; total: number; empty: string }) {
  if (props.rows.length === 0) return <p className="text-xs text-ink-3">{props.empty}</p>;
  return (
    <ul className="space-y-1.5">
      {props.rows.map((r) => (
        <li key={r.key} className="text-xs">
          <div className="flex justify-between gap-2">
            <span className="font-medium text-ink">
              {r.label}
              {r.tag && <span className="ml-1.5 text-ink-3">{r.tag}</span>}
            </span>
            <span className="tabular text-ink-2">
              {fmtInt(r.count)} <span className="text-ink-3">· {fmtPct(r.count, props.total)}</span>
            </span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className={`h-full rounded-full ${r.bar}`} style={{ width: `${Math.max(1, (r.count / Math.max(1, props.total)) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StatusBreakdown({ counts }: { counts: StatusCount[] }) {
  const total = counts.reduce((s, c) => s + c.count, 0);
  const rows = [...counts]
    .sort((a, b) => b.count - a.count)
    .map((c) => ({ key: String(c.code), label: String(c.code), count: c.count, bar: statusTone(c.code).bar, tag: statusTone(c.code).label }));
  return (
    <div className="card p-3">
      <h3 className="mb-2 text-xs font-semibold text-ink-2">Status codes</h3>
      <Rows rows={rows} total={total} empty="No responses yet." />
    </div>
  );
}

export function ErrorBreakdown({ counts, total }: { counts: ErrorCount[]; total: number }) {
  const rows = [...counts].sort((a, b) => b.count - a.count).map((e) => ({ key: e.kind, label: ERROR_LABEL[e.kind], count: e.count, bar: "bg-critical" }));
  return (
    <div className="card p-3">
      <h3 className="mb-2 text-xs font-semibold text-ink-2">Errors</h3>
      <Rows rows={rows} total={total} empty="No errors." />
    </div>
  );
}

export function warningText(w: Warning): { title: string; body: string; toadIssue: boolean } {
  switch (w.kind) {
    case "toad_bottleneck":
      return {
        title: "Toad may be the bottleneck",
        body: "Achieved RPS is well below the target while server latency stays flat. Use a release build, close other heavy apps, or run Toad on a bigger machine.",
        toadIssue: true,
      };
    case "fd_limit":
      return {
        title: "Out of file descriptors",
        body: "The OS refused new sockets (EMFILE). Lower concurrency or raise the open-file limit (ulimit -n).",
        toadIssue: true,
      };
    case "scheduler_lag":
      return {
        title: "Toad's scheduler is lagging",
        body: "Snapshots arrived more than 50 ms late, so the machine running Toad is saturated. Results may understate what the server can handle.",
        toadIssue: true,
      };
    case "concurrency_too_low":
      return {
        title: "Concurrency too low for the RPS target",
        body: `At the current latency the target needs about ${fmtInt(w.needed)} workers. Raise concurrency to reach it.`,
        toadIssue: false,
      };
  }
}

export function Warnings({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-1.5" role="alert">
      {warnings.map((w) => {
        const t = warningText(w);
        return (
          <div key={w.kind} className="flex gap-2 rounded-lg border border-warning/60 bg-warning/10 px-3 py-2 text-xs">
            <span aria-hidden className="text-base leading-none">⚠</span>
            <div>
              <div className="font-semibold text-ink">{t.title}</div>
              <div className="text-ink-2">{t.body}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
