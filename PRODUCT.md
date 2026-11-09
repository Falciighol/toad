# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Rendered in a Tauri 2 desktop webview on macOS, Windows and Linux. Desktop window sizes only; there is no mobile target.)

## Users

Dev-first, with depth for performance work.

- **Primary: backend developers testing their own APIs.** They test locally or against staging before they ship. Runs are quick and ad hoc, and they tweak a request and run it again many times in one sitting. A test should be runnable within seconds of opening the app.
- **Secondary: performance / QA engineers.** They keep a library of multi-step scenarios, run them on purpose, and inspect and compare results so they can write findings up for others.

## Product Purpose

Toad is a small, fast desktop app for load-testing HTTP APIs. You configure requests, set the load, press Start, and watch throughput, latency percentiles and errors update live. Afterwards you inspect, compare and export what happened. A run succeeds when the user trusts the numbers and can explain the result: which endpoint degraded, when, and why.

## Positioning

- Toad measures honestly. When an RPS cap is set, latency is measured from the scheduled send time (corrected for coordinated omission), and raw service time is recorded alongside. HDR histograms aggregate every 250 ms. Toad separates its own bottlenecks from the target's (a bottleneck warning, the FD limit, scheduler lag, "concurrency too low").
- Toad is safe by default. Every target is resolved and checked, non-loopback hosts need confirmation, runs are pinned to the checked addresses (so DNS rebinding can't redirect them), and redirects are host-gated. There are hard concurrency and RPS ceilings.
- It's a native desktop tool: local, no account, no cloud, and the Rust engine handles ≥ 5k RPS at 200 workers on a laptop.

## Operating Context

- People run it next to their editor and a local or staging service. The bundled `mock_server` example is the default practice target.
- Saved tests are JSON files in the app data folder. Run history keeps the last 100 runs by default (JSON, with a per-second series). Runs can be exported to JSON or CSV.
- Shortcuts: ⌘/Ctrl+Enter starts a run. ⌘/Ctrl+. or Esc stops it.
- `replay.html` replays a recorded run from fixtures, for UI work without the Rust backend.

## Capabilities and Constraints

Current (v1): one request per test (method, URL, headers, JSON/text body, bearer token); closed model or RPS cap; linear ramp-up; duration or request-count stop; timeout; success status range; follow redirects; allow invalid certs. Live dashboard, run summary, history, two-run compare, settings.

Confirmed direction (next):

- **Multi-endpoint tests**, run sequentially or in parallel.
- **Chaining.** Each virtual user runs the flow in order. Steps extract values (JSONPath, header, regex, cookie) into variables that later steps use. This replaces the v1 non-goal "auth flows beyond static headers and bearer tokens".
- **Per-virtual-user cookie jar.**
- **Conditional steps** (declarative Run if rules, no loops), multiple concurrent scenarios, client certificates (mTLS) and HTTP/SOCKS proxy.
- **Autosave** for tests. Import is from cURL only.
- **Dynamic values** from built-in generators, CSV/JSON data files, named environments, and response extraction. They're usable in URL, query params, headers, cookies and bodies.
- **Richer body types**, including XML and forms.
- **Per-endpoint analysis.** Aggregates and timelines per endpoint, plus a stored sample of real requests and responses (all failures, the slowest N, and a random slice) that the user can open and read.

Still non-goals unless revisited: cloud sync, accounts, distributed load, keychain storage, HTTP/3, WebSocket, gRPC. A general-purpose scripting DSL also stays out: value templating and extraction are declarative.

Terminology in use: *test*, *run*, *workers* (concurrency), *RPS cap*, *ramp-up*, *corrected vs raw latency*, *TTFB*, *success range*, *in flight*, *cancelled*.

## Brand Commitments

- The name is Toad. The app icon (`app-icon.svg`) is a green rounded square with two eyes and a latency-trace mouth.
- The legal/safety footer stays: "Only test APIs you own or are explicitly authorized to test."
- Voice: plain, precise, engineering-honest. Copy explains what is measured and how (see the README's "How it measures").

## Evidence on Hand

- `docs/dashboard.jpg` and `docs/summary.jpg` are real screenshots of a 200-worker run against the mock server.
- `src/dev/fixtures/` holds a recorded config, snapshots and a summary from a real engine run.
- There are no users, testimonials or published benchmarks beyond the README's perf acceptance target. Don't fabricate any.

## Product Principles

1. **Numbers you can trust.** Never show a metric whose method is unclear. Say what was measured, from when, and what was excluded.
2. **Fast path first.** A single-request test stays as quick to set up as it is today. Multi-step depth is added on top and never put in the way.
3. **Explain, don't just display.** Analysis should answer "what happened and where", down to the actual requests.
4. **Safe by default.** Safety checks extend to every endpoint and host a test touches, including the hosts that redirects and chained steps reach.
5. **Local and honest about secrets.** Secrets are stored in plain text, are masked in the UI, and are redacted in history and exports by default.
