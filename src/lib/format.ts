// Display formatting. Latencies arrive in microseconds.

export function fmtLatency(us: number | null | undefined): string {
  if (us === null || us === undefined || !Number.isFinite(us)) return "–";
  if (us < 1000) return `${Math.round(us)} µs`;
  const ms = us / 1000;
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export const fmtInt = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US");

export const fmtRps = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "–" : n >= 100 ? fmtInt(n) : n.toFixed(1);

export function fmtPct(part: number, whole: number): string {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  return p > 0 && p < 0.1 ? "<0.1%" : `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Signed delta and percentage, e.g. "+12.3 ms (+8%)". */
export function fmtDelta(a: number, b: number, fmt: (n: number) => string): string {
  const d = b - a;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  const pct = a ? ` (${sign}${Math.abs((d / a) * 100).toFixed(1)}%)` : "";
  return `${sign}${fmt(Math.abs(d))}${pct}`;
}
