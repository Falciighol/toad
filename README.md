# Toad

A small, fast desktop app for load-testing HTTP APIs. Configure a request, set the
load, press Start, and watch throughput, latency percentiles and errors update live.

> **Only test APIs you own or are explicitly authorized to test.** Load testing
> systems without permission can be illegal and can take down services other people
> depend on. Toad asks for confirmation before sending traffic to anything that is
> not a loopback address.

![Live dashboard during a 200-worker run against the mock server](docs/dashboard.jpg)

## Layout

```
Cargo.toml                 workspace
crates/toad-core/          engine, limiter, metrics, models, export, safety (no Tauri)
  examples/mock_server.rs  configurable axum mock API
  tests/engine_it.rs       engine ↔ mock-server integration tests
src-tauri/                 thin Tauri app: commands, events, storage, state
  capabilities/default.json
src/                       React + TypeScript UI
  bindings.ts              GENERATED from Rust by tauri-specta (do not edit)
  lib/api.ts               typed wrappers + event listeners
```

## Setup

Requirements: Rust 1.85+, Node 20+, pnpm 10+, and the
[Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
(Xcode command-line tools on macOS; WebView2 + MSVC build tools on Windows;
`webkit2gtk-4.1`, `libayatana-appindicator3` etc. on Linux).

```bash
pnpm install
pnpm tauri dev          # run the app in development
pnpm tauri build        # release bundle for the host OS (src-tauri/../target/release/bundle)
```

Try it against the bundled mock server:

```bash
cargo run --release --example mock_server -- --port 8787 --delay-ms 20 --jitter-ms 5 --error-rate 0.01
```

Mock flags: `--port`, `--delay-ms`, `--jitter-ms`, `--error-rate` (0–1), `--body-bytes`,
`--seed`. Routes: any path → 200 (or 500 at the error rate), `/status/{code}`,
`/redirect/{n}`.

## Checks

```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm typecheck && pnpm test
# Perf acceptance (release, local mock): ≥ 5k RPS with 200 workers
cargo test --release -p toad-core --test engine_it -- --ignored --nocapture
```

Headless runs (loopback targets only) for smoke tests or CI:
`cargo run --release -p toad-core --example headless_run -- config.json [--snapshots s.json] [--summary r.json]`.

UI development without the Rust backend: `pnpm dev`, then open
`http://localhost:1420/replay.html`. It mocks Tauri IPC and replays a recorded engine
run from `src/dev/fixtures/`. This page is not part of the production bundle.

`cargo test` also fails if `src/bindings.ts` is out of date. Regenerate with
`TOAD_WRITE_BINDINGS=1 cargo test -p toad bindings` (debug builds of the app also
rewrite it on startup).

## How it measures

**What runs.** A test holds one or more *scenarios*, and they run at the same time. A
scenario is either a **flow** (each virtual user walks the steps in order, then starts
again) or a **mix** (each iteration picks one step by weight). Around them, **setup**
runs once before the test, **per-user init** runs once per virtual user before its first
iteration (log in per user, for example), and **teardown** runs once at the end. Setup
and teardown requests appear in the analysis but are not part of the run's totals or
its verdict.

**Load model.** Each scenario chooses how its load is generated, and the Load stage
draws it as a profile over time:

- **Virtual users** (closed model). N virtual users each run an iteration, wait for
  every response, then run the next. The value is constant or follows linear stages
  (ramp up, hold, ramp down). If the target slows down, the request rate drops with it.
- **Arrival rate** (open model). Iterations start on a schedule, constant or staged,
  counted per second, minute or hour (durations take seconds, minutes or hours too),
  whatever the target's speed. A shared lock-free scheduler (GCRA, a token bucket of
  size 1) gives every iteration an *intended start time*. The first request of the
  iteration is measured **from that scheduled time**, which corrects for coordinated
  omission: if the server stalls, the backlog shows up in the numbers instead of
  silently disappearing. Later steps in the iteration are measured from their own send.
  Each iteration needs a free virtual user, up to the scenario's *max VUs*. When none
  is free, the iteration is **dropped**, counted, and reported with a warning. It is not
  queued. If max VUs can't reach the rate at the current service time, Toad shows a
  "concurrency too low" hint with the number it would need.
- **Fixed iterations.** N virtual users share a fixed number of iterations, with a time
  limit.

Scenarios can start at an offset. When a scenario ends, its in-flight iterations get
the scenario's *graceful stop* period, and then whatever is still running is cancelled.

**Latency.**

- **Latency** is send start → full body read, or scheduled start → full body read for
  the first request of an open-model iteration. Raw *service time* (actual send → last
  byte) and TTFB are recorded alongside. Where the two latencies differ, the run labels
  which one a number shows ("from scheduled start").
- The body is always drained, so connections return to the pool. Transport errors
  (timeouts, connect/DNS/TLS failures) are counted but not added to latency histograms.
  Responses with a non-success status are added.
- **Think time** (a fixed, uniform or normally distributed pause after each step) is
  not counted in any latency.

**What counts as a failure.** Success is the test's status range (default 200–399). A **check** (status, body, JSONPath, XPath, header or latency assertion)
either fails the request or is counted only as a check failure. Each check chooses
which. Errors are classified as timeout, connect, DNS, TLS, body read, redirect (over
the hop limit, or to an unconfirmed host), non-success status (by code), failed
check, or other. Some requests are never sent, and are counted separately rather than
as errors:

- **Skipped:** a value the request needs is missing, because an earlier extraction
  failed.
- **Not taken:** its *Run if* rule was false. This is a normal path.
- **Blocked:** its host isn't loopback and wasn't confirmed.
- **Cancelled:** it was still in flight when the run stopped.

**Values between steps.** Steps **extract** values from responses with JSONPath,
XPath, a header, a regex or a cookie. Later steps use them as `{{name}}`, alongside
environment variables, data-file columns (`{{users.email}}`), built-ins (`vu.id`,
`iteration`) and generators (`{{$uuid}}`). Templates are parsed once per run.
Rendering one with no placeholders is a copy. Each virtual user gets its own **cookie
jar** by default. Redirects are followed manually, so cookies and host checks apply on
every hop.

**Verdict.** **Thresholds** (p50/p90/p95/p99/max, error rate, check pass rate, RPS or
dropped iterations, for the whole test, one scenario or one step) decide pass or fail.
A threshold can abort the run the moment it is crossed, after an optional delay. The
**warm-up** seconds are excluded from the verdict but still shown in every chart, and
marked as excluded.

**Metrics.**

- **Collection.** Virtual users record into lock-striped shards, 4 per CPU core,
  picked by user id, so a shard's lock is effectively private. Whole-run histograms
  are HDR in µs with 3 significant figures. Each request step also gets a smaller
  histogram set (2 significant figures, ±1%), so per-endpoint numbers don't multiply
  memory: a 20-step test costs about 30 MB instead of about 500 MB.
- **Aggregation.** An aggregator merges the shards every 250 ms into interval,
  per-second, cumulative and verdict views, and emits one `run://snapshot` event.
- **Saved with the run.** A per-second series, per scenario and per endpoint, is
  saved with the run. In the Timeline, brushing a time window merges per-second log
  buckets (×1.3 apart) to estimate that window's percentiles, accurate to about ±15%,
  and the UI says so.

**Samples.** For the analysis, a run keeps real requests and responses per endpoint:
every failure (up to 200 per error kind), the 50 slowest, and a uniform random 100.
Bodies are capped at 64 KB each and 50 MB per run. All of these limits are in
Settings. Toad decides whether to keep a request when its response headers arrive, so
bodies are only buffered when they might be kept. Each sample records the virtual
user, iteration and time, and the values the iteration had extracted so far.

**Toad's own limits.** The **bottleneck warning** appears when achieved RPS stays
under 90% of target for 3 s while service time stays flat and max VUs would suffice.
This check applies to open-model scenarios of single-request iterations. Toad also
warns when the OS runs out of file descriptors, when its own scheduler lags by more
than 50 ms, and when a data file runs out of rows.

**Stop** (button, ⌘/Ctrl+., or Esc when no input or dialog has focus) halts new
iterations, waits up to 2 s for in-flight requests, then cancels the rest. Partial
results are kept.

## OS limits

Each in-flight request holds a socket. Toad raises its soft open-file limit to the
hard limit at startup on macOS and Linux. If you still see the "out of file
descriptors" banner:

- **macOS:** `ulimit -n 65536` in the shell that launches Toad, or
  `sudo launchctl limit maxfiles 65536 200000` system-wide.
- **Linux:** raise `nofile` in `/etc/security/limits.conf` or your systemd unit.
  For very high rates, also widen `net.ipv4.ip_local_port_range` and enable
  `net.ipv4.tcp_tw_reuse`.
- **Windows:** there is no per-process descriptor limit to raise. Ephemeral ports
  can run out at high connection churn (`netsh int ipv4 set dynamicport tcp ...`).

Keep-alive is on and the pool is sized to the concurrency, so connections are reused
and churn is low unless the server closes connections. With `https://` targets that
negotiate HTTP/2, all workers multiplex over a few connections. That is expected.

## Safety and privacy

- Before every run the target is resolved and checked. Anything that isn't loopback
  (`localhost`, `127.0.0.0/8`, `::1`) needs a confirmation, which is remembered per
  host until you quit. Private ranges (10/8, 172.16/12, 192.168/16, IPv6 ULA) also
  need confirmation unless **Settings → Treat private networks as local** is on. The
  backend repeats the check, and the run is pinned to the addresses that were
  checked, so DNS rebinding can't redirect it. Redirects to other hosts are only
  followed if those hosts are loopback or already confirmed.
- Hard ceilings: concurrency defaults to 1000 and RPS to 20,000. You can change both
  in Settings.
- **Secrets are stored in plain text.** Saved tests live as JSON in the app data
  folder, and Toad does not use the OS keychain. In the UI, bearer tokens and
  `Authorization`, `Proxy-Authorization`, `Cookie` and `X-API-Key` values are masked.
  By default they are written to run history as `[redacted]` and stripped from
  exports. Both behaviors can be changed in Settings.
- The webview has no direct filesystem access. Exports are written by Rust, and only
  to a path you picked in the save dialog.

Data location (`dev.toad.desktop`): `~/Library/Application Support/dev.toad.desktop`
(macOS), `%APPDATA%\dev.toad.desktop` (Windows), `~/.local/share/dev.toad.desktop`
(Linux). The folder contains `tests/*.json`, `runs/*.json` (+ `runs/index.json`
cache) and `settings.json`. Toad keeps the last 100 runs by default.

## Keyboard

| Shortcut | Action |
|---|---|
| ⌘/Ctrl + Enter | Start |
| ⌘/Ctrl + . | Stop |
| Esc | Stop, when no input or dialog has focus |

## Non-goals

Cloud sync, accounts, distributed load (one machine generates all of it), keychain
storage, code signing and notarization, auto-update, HTTP/3, WebSocket and gRPC.

There is also no general-purpose scripting language. Chaining is declarative:
extractions, templates, checks and *Run if* rules cover login flows, per-user data and
conditional steps, but there are no loops and no user code. Import is from cURL only.
There are no HAR, Postman or OpenAPI importers.

(v1 also ruled out auth flows beyond static headers and bearer tokens. v2 lifts that
with step chaining, per-user init and cookie jars.)
