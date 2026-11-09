import type { ErrorCount, ErrorKind, StatusCount, Warning } from "../bindings";
import { fmtInt, fmtPct } from "../lib/format";
import { CardTitle, Icon } from "./ui";

export const ERROR_LABEL: Record<ErrorKind, string> = {
  timeout: "Timeout",
  connect: "Connect",
  dns: "DNS",
  tls: "TLS",
  body_read: "Body read",
  status: "Non-success status",
  redirect: "Redirect",
  check: "Failed check or extraction",
  other: "Other",
};

function statusTone(code: number): { bar: string; label: string } {
  if (code < 300) return { bar: "bg-success", label: "2xx" };
  if (code < 400) return { bar: "bg-info", label: "3xx" };
  if (code < 500) return { bar: "bg-warning", label: "4xx" };
  return { bar: "bg-danger-fill", label: "5xx" };
}

function Rows(props: { rows: { key: string; label: string; count: number; bar: string; tag?: string }[]; total: number; empty: string }) {
  if (props.rows.length === 0) return <p className="text-small text-text4">{props.empty}</p>;
  return (
    <ul className="space-y-2.5">
      {props.rows.map((r) => (
        <li key={r.key} className="text-body">
          <div className="flex justify-between gap-2">
            <span className="font-medium text-text">
              {r.label}
              {r.tag && <span className="ml-1.5 text-small text-text4">{r.tag}</span>}
            </span>
            <span className="tabular font-mono text-small text-text2">
              {fmtInt(r.count)} <span className="text-text4">· {fmtPct(r.count, props.total)}</span>
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised2">
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
    <div className="card p-4">
      <CardTitle className="mb-3">Status codes</CardTitle>
      <Rows rows={rows} total={total} empty="No responses yet." />
    </div>
  );
}

export function ErrorBreakdown({ counts, total }: { counts: ErrorCount[]; total: number }) {
  const rows = [...counts].sort((a, b) => b.count - a.count).map((e) => ({ key: e.kind, label: ERROR_LABEL[e.kind], count: e.count, bar: "bg-danger-fill" }));
  return (
    <div className="card p-4">
      <CardTitle className="mb-3">Errors</CardTitle>
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
        title: "Too few virtual users for the arrival rate",
        body: `At the current latency the rate needs about ${fmtInt(w.needed)} virtual users. Raise Max virtual users to reach it; until then iterations wait, which shows in corrected latency.`,
        toadIssue: false,
      };
    case "dropped_iterations":
      return {
        title: `${fmtInt(w.count)} iterations never started in ${w.scenario}`,
        body: "Every virtual user was busy when they came due, and the scenario ended before one was free. Raise Max virtual users, or treat it as the target's limit.",
        toadIssue: false,
      };
    case "data_exhausted":
      return {
        title: `Data file ${w.file} ran out of rows`,
        body: "Its setting stopped virtual users (or the run) when the rows were used up. Add rows, or let it start over from the first row.",
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
          <div key={`${w.kind}-${JSON.stringify(w)}`} className="flex gap-2.5 rounded-xl bg-warning-soft px-4 py-3">
            <Icon name="alert" className="mt-px size-4 text-warning" />
            <div>
              <div className="text-body font-semibold text-warning">{t.title}</div>
              <div className="mt-0.5 text-small text-text2">{t.body}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
