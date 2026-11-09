# Shape brief: Test page (Stage rail) + Run analysis

Status: **confirmed 2026-11-06**. This brief contains no code. Layout chosen: **Stage rail**. Mode: **Operate**. Visual world: inherited unchanged (graphite ground, Saga accent packs from `src/lib/theme.ts`, Instrument Sans + Geist Mono, existing `ui.tsx` controls). Build path: code-led.

---

## 1. Job and audience

- **Dev (primary):** has a service running locally or on staging and wants it under load within seconds. They edit one request, press ⌘Enter, read the result, and repeat. A multi-step flow happens when they need login → token → call.
- **Perf/QA (secondary):** keeps a library of multi-step, multi-scenario tests, defines pass/fail thresholds, and digs into a finished run to explain *which endpoint degraded, when, and why*, down to individual requests.
- Mode: **Operate**. Category-fluent users must trust the tool on sight. The world contributes type, palette and density, plus one signature move.

## 2. Outcome and proof

- **Builder success:** a valid test exists, the user has watched one virtual user walk the flow once (Try once) and seen real responses and extracted values, and Start is a keypress away from any stage.
- **Analysis success:** the user can name the worst endpoint, the time window where it went wrong, and open a real failed request together with the iteration that led to it.
- **Product truth to keep visible:** what each latency means (corrected vs raw, from-when), dropped vs failed vs skipped vs cancelled, sample counts behind percentiles, and which hosts the test touches.

## 3. Selected direction: Stage rail

**Structure.** A dedicated test page. The left rail lists five stages: **Flow · Data · Load · Checks · Review**. Each rail item shows its name, a one-line live summary ("4 steps · 1 parallel group", "staging · 2 files", "200 VUs · 5 min", "3 thresholds", "2 hosts to confirm") and an error badge. Each stage gets the full workspace to its right.

**The rail is a map, not a wizard.** Stages are never gates. **Start** and **Try once** live in the page header and work from any stage. Review is a place to check things, not a required step.

**Signature move: the load profile you draw.** In Load, each scenario's profile (VUs or arrival rate over time) is a chart with draggable stage handles, backed by a numeric stage table. Typed entry is first-class, and the chart is never the only input. In the analysis Overview the same chart comes back as *planned* (dashed) with *achieved* drawn over it, so where the run diverged from the plan is the first thing a user reads.

**Raises carried in:**
- *From the gate board:* the live and post-run endpoint board re-sorts by p99 in place, rows keep their identity while moving, and a row that crosses a threshold stays lit until the user opens it.
- *From the type specimen:* a live **Resolved preview** shows the current step exactly as VU 1, iteration 1 would send it, with every template already filled in, and updates as you type.

**Fast path (non-negotiable).** A new test opens on Flow with one request step, the URL field focused, and load defaults shown as a header chip ("50 workers · 30 s"; click to edit in a popover). A one-step, one-scenario test hides the scenario layer, the group and think-time affordances stay in an "Add" menu, and the analysis skips the endpoint board and opens straight into that endpoint's detail. Existing v1 tests open as exactly this.

## 4. Information architecture

```
Header:  Toad   [Tests] [Runs]   ·································   Settings
Tests    library → Test page (Stage rail)  → live Run view → Run analysis
Runs     history → Run analysis; select two → Compare
```

- **Tests library:** name, step/scenario count, environment, last run verdict (pass/fail/none), p95 trend sparkline over recent runs, last run time. New test (blank or **paste cURL**). Duplicate, delete. On launch the app opens the last-open test, not the library.
- **Test page header:** ← Tests · inline test name · save state · **Environment** select · load chip · **Try once** (⌘⇧Enter) · **Start** (⌘Enter). While a run is active the editor is read-only, the header turns into run status with **Stop**, and a banner links to the live view.
- **Live Run view:** today's dashboard plus a live per-endpoint board, a threshold status strip, VUs per scenario, and data-file cursor progress.
- **Run analysis:** the rail flips to analysis sections (see §7).

## 5. The builder, stage by stage

### Flow

The left column is the **step outline**. The center is the **step editor**. The **Resolved preview** docks below the editor in a resizable split.

**Test → Scenarios → steps.**
- A test holds 1..n **scenarios** that run **concurrently**, each with its own load profile. A single scenario is invisible: no tabs, no nesting.
- Scenario kind:
  - **Flow** (sequential): each VU walks the steps in order, then repeats.
  - **Mix** (parallel endpoints): independent requests, each with a **weight %**. Each iteration picks one. This is the "hit these 6 endpoints in proportion" case.
- Outline item types in a Flow:
  - **Request**.
  - **Parallel group**: members fire together, and the group ends when all members finish (like a page fetching three resources).
  - **Think time**: fixed, uniform(min, max) or normal(mean, sd). Excluded from latency and included in iteration duration.
  - **Setup** section: runs **once per test** before load starts. Its extracted values are shared read-only by all VUs (log in once, share the token).
  - **Per-VU init** section: runs **once per VU** before its first iteration (log in per user).
  - **Teardown** section: runs once at the end.
- **Conditional steps.** Any step, group or think time can carry a **Run if** rule.
  - Each clause checks one thing: a variable exists / is missing; a variable equals, doesn't equal, matches a regex, or compares as a number; or the previous step's status falls in a range or ended ok / failed.
  - Clauses combine with *all* or *any*. Nothing more is allowed: no expressions, no loops.
  - A step whose rule is false is **not taken**. That's a normal path, distinct from *skipped* (a missing dependency), and it never counts as an error.
  - Outline rows with a rule show a branch glyph and the rule in short form ("if `cart.size` > 0").
  - Try once shows which branch each step took.
- Outline rows show the method, name or path (templates highlighted), variables the step **produces** (→ `token`) and **consumes**, and a validation dot. Reordering uses drag plus ⌥↑/⌥↓, ⌘D duplicates, and ↑/↓ moves the selection.

**Step editor.**
- **Request line:** method (GET POST PUT PATCH DELETE HEAD OPTIONS, plus a custom verb), URL with template highlighting and `{{` autocomplete, and a step name.
- **Endpoint identity is the step, not the URL.** `/users/{{id}}` stays one row in analysis.
- **Send once:** sends this step alone with the current environment and earlier variables (from the last Try once, or values you type in) and shows the response inline. This is what makes extractors and checks writable.
- Tabs: **Params · Headers · Cookies · Body · Auth · Extract · Checks · Options**.
  - **Params:** key/value table synced both ways with the URL query. Supports enable toggles, repeated keys, and an encoding preview.
  - **Headers:** key/value table. Test-level default headers appear inherited and dimmed, with "override". Sensitive names are masked as today. Warns on manual `Content-Length`/`Host`.
  - **Cookies:** explicit cookies for this step, plus a jar mode for the step: *use VU jar* (default) / *clear jar before* / *no jar*. After Send once or Try once it shows a read-only view of the jar.
  - **Body:**
    - Kinds: None · JSON · XML · Text · Form (URL-encoded key/value) · Multipart (key/value plus file fields) · GraphQL (query + variables → JSON) · Binary (file) · Raw (custom Content-Type).
    - Content-Type is set automatically and can be overridden. A conflict with a manual header gets a warning.
    - JSON/XML are validated *after* templates are filled with sample values, because `{"n": {{$seq}}}` is invalid before that.
    - Optional gzip request body.
    - Files are read once and cached. A size note shows body × peak RPS as bandwidth.
  - **Auth:** inherit from test · none · bearer · basic · API key (header or query). OAuth and other flows are built from a Setup or Per-VU init step plus Extract, and an **"Add login step"** preset scaffolds that. There is no hidden auth engine.
  - **Extract:**
    - Rows map a variable name to a source: JSONPath, XPath, response header, Set-Cookie, regex on body, status code, or response time.
    - Match: first / random / all (array) / index n.
    - Scope: VU (default) or global (Setup only).
    - On missing: *fail step* / *use default* / *skip rest of iteration*.
    - Each row shows the value it would extract from the last Send once response.
    - Values extracted from auth headers or cookies are automatically marked secret.
  - **Checks:** status (inherits the test success range by default), body contains, JSONPath/XPath equals or exists, header equals or exists, latency < X. Each check has a toggle, "failing this counts the request as failed"; when it's off, the failure is recorded as a *check failure* only.
  - **Options:** timeout override, follow redirects and max hops, max response bytes read, weight (Mix), and a **pre-request values** list (`orderId = {{$uuid}}`) so one generated value can be reused across URL, header and body. Each bare generator occurrence is fresh.
- **No retries.** Retries hide load. A 429 or 503 is recorded with its `Retry-After`, never retried.

**Resolved preview.**
- Shows the exact request (method, final URL, headers, body, cookies) for VU 1 / iteration 1. **↻ resample** draws new generator values and data rows. Copy as cURL.
- An unresolvable value appears in danger color with its reason: "`token` comes from *Login*. Run Try once to fill it."

**Template language.** It's declarative, not a scripting DSL.
- `{{name}}` reads environment, data or extracted variables. `{{users.email}}` reads a data-file column.
- Generators start with `$`: `$uuid`, `$randomInt(a,b)`, `$randomFloat`, `$pick(a,b,c)`, `$seq` (atomic across the test), `$email`, `$name`, `$word`, `$timestamp` / `$isoDate` (at send time), `$base64(…)`, `$urlencode(…)`.
- Built-ins: `vu.id`, `iteration`, `scenario`, `run.id`.
- `\{{` escapes a literal.
- Autocomplete lists only names that are valid *at this step*. Using a variable from a later step is a static error.

### Data

- **Environments:** a variable table with one column per environment (local, staging, …). Each variable has a *secret* flag (masked in the UI, redacted in history, samples and exports). The active environment is chosen in the page header. `baseUrl` is a convention, not magic. Switching environment re-runs the host safety check.
- **Data files:**
  - Import CSV or JSON. Files are *copied into the test's folder* so tests are portable and can't break when the original moves.
  - Preview the first 20 rows. Detects header row, delimiter, BOM and quoting. Columns can be marked secret.
  - Distribution: *sequential shared cursor* · *random* · *unique per VU* · *per iteration*.
  - On exhaustion: *wrap* · *stop VU* · *stop run*.
  - "Unique per VU" with fewer rows than peak VUs is a static error that states both numbers.
  - Size limit with a clear error.
- **Cookie jar policy** (test level): per-VU jar (default) · shared jar · off. Optionally clear the jar each iteration. Pre-seeded cookies (domain, path, name, value, secure). Domain, path, secure and expiry are honored.
- **Test defaults:** base URL, default headers, default auth, User-Agent, timeout, success status range.

### Load

- One profile editor per scenario, all drawn on one shared time axis as colored series plus a total. **This is the signature move.**
- Executor per scenario:
  - **VUs, constant**: N VUs looping. This is today's closed model.
  - **VUs, staged**: ramp / hold / ramp-down stages.
  - **Arrival rate, constant or staged**: iterations per second (open model), with a **max VUs** cap.
  - **Fixed iterations**: K total, shared. This is today's request-count stop.
- **Rate units are explicit.** For a Flow, the rate is *iterations/s*, and the derived **≈ requests/s** (rate × steps) is shown next to it. Never mix the two silently.
- Per scenario: start offset, graceful stop (how long in-flight iterations may finish), and default think time.
- **Client certificates (mTLS):**
  - PEM cert + key or PKCS#12, set per test or per host pattern.
  - Copied into the test folder, like data files.
  - The passphrase is a secret variable, stored in plain text like every other secret (say so beside the field).
  - Expiry and mismatch errors appear at validation time and on Send once.
- **Proxy:**
  - HTTP, HTTPS or SOCKS5, with optional credentials (secret) and a no-proxy list.
  - The target-host safety check still applies to every target, and the proxy host itself must be loopback or confirmed.
  - Through an HTTP proxy, the proxy resolves the target, so **DNS pinning can't be enforced**. Review states this plainly.
  - Analysis marks proxied runs, because their latency includes the proxy hop.
- Connections: keep-alive on/off, pool *shared* vs *per-VU* (per-VU is closer to real users), HTTP/1.1-only vs allow HTTP/2, allow invalid certs, and per-test **host overrides** (map `api.local` → `127.0.0.1`), which feed the existing DNS pinning.
- **Estimate panel** (extends `estimate.ts`): total requests, peak RPS, peak VUs, bytes in/out, sockets needed vs the OS limit, and Settings ceilings, which apply to the **sum** across scenarios.

### Checks (thresholds)

- Rows are built as *metric × scope × aggregate × comparator × value*:
  - Metrics: p50/p90/p95/p99/max latency, error rate, check-pass rate, achieved RPS, dropped iterations.
  - Scope: test / scenario / step.
- Each row has **Abort run when crossed**, with *evaluate after N s* to skip warm-up.
- A test-level option excludes ramp-up or warm-up from verdict statistics. That data is still shown, marked as excluded.
- The verdict (pass/fail per threshold) heads the analysis and drives headless exit codes.

### Review

- **Hosts this test touches:** every resolved host across all steps and the active environment, each marked loopback, private, confirmed or unconfirmed, with a Confirm action.
- Hosts that come from variables or data can't be known in advance. They are listed as "*decided at runtime*", and a runtime request to an unconfirmed host is **blocked and counted** (new outcome: *blocked*). Toad never shows a prompt mid-run.
- **All validation issues**, grouped by stage, with jump links.
- **Try once** result: a waterfall of one VU iteration (Setup → Init → steps). Each bar opens its request and response, extracted values and check results.
- The estimate, and Start.

## 6. Run semantics the UI must show

| Outcome | Meaning | In latency stats? |
|---|---|---|
| ok | completed, inside the success range, checks passed | yes |
| failed (status / check / transport kind) | completed or errored | status and check failures: yes. Transport errors: no (as today) |
| **not taken** | its Run if rule was false (a normal path, not an error) | no |
| **skipped** | not sent because an upstream extraction it needs failed (policy) | no |
| **dropped** | arrival-rate iteration not started because max VUs was reached | no |
| **blocked** | target host unconfirmed at runtime | no |
| **build error** | template produced an invalid request (e.g. bad JSON) | no |
| cancelled | aborted by stop / graceful-stop timeout | no |

- Coordinated-omission correction applies to the **first step of an arrival-rate iteration**. Later steps measure from the previous step's completion. Say this in the latency tooltip.
- **Iteration duration** and per-group duration (the max of the group's members) are metrics in their own right.
- A **Setup failure** aborts before any load, with its request and response attached.

## 7. Run analysis

The rail flips to: **Overview · Endpoints · Timeline · Errors · Samples · Config**.

- **Overview:**
  - A verdict strip with the thresholds (pass/fail, crossed at t = ?).
  - Headline totals with all seven outcome classes.
  - **Planned vs achieved profile** (the signature echo).
  - Throughput and latency over time, annotated with stage boundaries, warnings (bottleneck, FD, scheduler lag, concurrency too low), threshold crossings and abort points.
  - Toad's own warnings stay visually separate from target findings.
- **Endpoints (the board):**
  - One row per step, grouped by scenario, with parallel groups indented.
  - Columns: requests, RPS, error %, check-fail %, skipped, p50/p95/p99/max, TTFB p95, bytes, p95 sparkline.
  - Sortable, defaulting to p99 descending. Threshold breaches stay lit until the row is opened.
  - Conditional steps show a taken / not-taken count.
  - Rows for steps that never ran say why: "0 requests — skipped after *Login* extraction failed ×1,204".
  - Toggle: *group by URL template* when two steps share a URL.
- **Endpoint detail** (opens from a row, in the same pane, with breadcrumb back):
  - Latency over time (p50/p95/p99, corrected vs raw).
  - Distribution: a log-scaled histogram plus the percentile spectrum.
  - Timing breakdown: connect/TLS (new vs reused connection), TTFB, download. See the engineering constraints in §10.
  - Status codes over time (stacked).
  - Error kinds over time.
  - Extraction and check failures by rule.
  - Response size distribution, wire vs decoded.
  - Delta vs the previous run of this test.
  - This endpoint's samples.
- **Timeline:**
  - Synchronized charts with a **time brush**. Dragging a window (e.g. 2:14–2:20) recomputes the endpoint board, the distribution and the error tables for that window.
  - Any brushed window can be sent to Samples as a filter.
- **Errors:** grouped by kind × endpoint × status or normalized message, with count, first/last seen, a sparkline, and → samples.
- **Samples (the request inspector):**
  - Filters: endpoint, branch taken, capture reason (failure / slowest / random), status, error kind, time window, VU.
  - The detail view has three columns:
    - **Request:** final URL, headers, body (pretty-printed for JSON/XML/form), cookies sent.
    - **Response:** status, headers, body truncated at the cap with its true size shown, Set-Cookie, redirect chain.
    - **Context:** timestamp, VU, iteration, timings, variables in scope, extracted values, check results.
  - **Follow this iteration** shows the whole VU iteration trace as a mini waterfall, so a 401 on `/orders` is visibly caused by a 429 on `/login` two steps earlier.
  - Copy as cURL. **Send again** goes through the same safety checks.
- **Config:** the exact redacted config snapshot, the environment used, data-file name, row count and hash, Toad version, host machine (OS, cores), and settings in effect.
- **Compare:** extended to per-endpoint deltas, matched by step id. Unmatched steps are listed, not dropped.

**Sampling policy (defaults, editable in Settings):**
- Per endpoint: every failure up to 200 per error kind, the 50 slowest (kept in a heap), and a 100-request reservoir sample.
- In Flow scenarios a sampled request keeps its **whole iteration trace**.
- Bodies are capped at 64 KB each, and each run's samples are capped at 50 MB total. When a cap is hit, the UI says "samples truncated at …".
- Redaction applies: sensitive headers, secret variables and columns, extracted secrets, and cookie values. Settings → "Don't store bodies" covers PII-sensitive targets.

## 8. States and ranges

- **Ranges:** 1–30 steps per scenario (design for 8), 1–5 scenarios, 0–20 extractors per step, data files up to ~100k rows, runs from 10 s to 24 h, 1–10k VUs.
  - Long runs downsample series (1 s buckets up to 10 min, then 5 s / 30 s) and say so.
  - Percentiles from fewer than 100 samples are marked low-confidence.
- **Builder states:**
  - New/blank (URL focused).
  - Imported from cURL (with what was dropped, e.g. unsupported flags).
  - Invalid: inline field errors plus rail badges. Errors appear after the first Start or Try once attempt or on blur, never while typing the first character.
  - Try once running, with a per-step result.
  - Send once loading or error.
  - Data file missing or corrupt.
  - Unconfirmed hosts.
  - Read-only while running.
  - Unsaved / saved (see open decisions).
- **Run states:** ramping, running, stopping (grace countdown), done, stopped, failed in setup, aborted by threshold (names the threshold and the time).
- **Analysis states:**
  - Single endpoint (board skipped).
  - Samples disabled or truncated.
  - Brushed window with no data.
  - Endpoints that never ran.
  - Old v1 runs (no per-step data: only the overall series, with a note).

## 9. Interaction and layout intent

- **Proportions** (desktop only, min window 1024 px):
  - Rail ≈ 200 px.
  - Flow: outline ≈ 280 px, editor fills the rest, Resolved preview docked below (resizable, collapsible).
  - Below 1200 px the rail collapses to icon + badge with labels in tooltips, and the preview becomes a toggle.
- **Keyboard:** ⌘1–5 switch stage, ⌘Enter Start, ⌘⇧Enter Try once, ⌘. / Esc Stop (existing rules), ⌘D duplicate step, ⌥↑/↓ reorder, `{{` autocomplete. All of these work without a mouse, including profile stages via the stage table.
- **Motion:** 150–250 ms state changes only. Board rows re-rank with identity-preserving movement, and under reduced motion they reorder instantly and keep the lit state.
- **Overlays:** the load chip popover, autocomplete and menus escape scroll containers (popover API or portal). Modals are reserved for destructive confirms and host confirmation, as today.
- **Reuse:** `Field`, `Section`, `Segmented`, `Icon`, `Kbd`, the `.input` and `.btn` vocabulary, and the existing chart components in `Charts.tsx`, extended rather than forked.

## 10. Constraints and open decisions

**Engineering constraints the builder must not hand-wave:**
- **Model migration.** `TestConfig` becomes v2: scenarios, steps, data, environments, thresholds. v1 tests and runs **must** load, as a single-step scenario and an "overall only" run. `bindings.ts` is regenerated through tauri-specta.
- **Per-step metrics memory.** Three HDR histograms × steps × shards (4 per core) is too heavy as-is: 20 steps × 40 shards × ~200 KB × 3 ≈ 480 MB. Per-step histograms need a timeout-bounded range, 2 significant figures where acceptable, or per-step shard pooling. Brushable windows need per-bucket histograms per step, stored compressed.
- **Timing phases.** reqwest doesn't expose DNS/connect/TLS timings. A connection-level instrumented connector is needed; until then show TTFB, download, and new-vs-reused connection only. Never fake the phases.
- **Storage.** Samples go in a separate per-run file, not inside `runs/<id>.json`. History pruning removes both files.
- **Safety.** Every step's host and every redirect and runtime host goes through the existing check-and-pin path.
- **Headless.** `headless_run` gains threshold exit codes. Loopback-only stays.

**Decisions (confirmed):**
1. **Autosave.**
   - Every edit writes to the test file, debounced. The header shows *Saving… / Saved*, with ⌘Z / ⌘⇧Z undo for the session.
   - A blank new test is only written to disk after its first real edit.
   - Runs keep snapshotting the exact config they ran with.
   - Explicit Save and the "Unsaved test" option in the test picker go away. Duplicate makes a copy and opens it.
2. **Multiple concurrent scenarios ship in the first release.** A single-scenario test still hides the scenario layer.
3. **Import is cURL only.** HAR, OpenAPI and Postman are out until revisited.
4. **Client certificates (mTLS) and proxy are in scope.** See Load.
5. **Conditional steps are in scope.** Declarative *Run if* rules only, with no loops (see Flow).
6. **Sampling defaults** as proposed: per endpoint, 200 failures per error kind, the 50 slowest and a 100-request random sample. Bodies capped at 64 KB, 50 MB per run. All editable in Settings.

**Anti-goals:**
- Making the single-request path slower than today.
- A node-graph canvas.
- A scripting language, loops, or expressions beyond Run if clauses.
- Silent retries.
- Percentiles without sample counts.
- Mixing iterations/s and requests/s.
- Showing a request-phase breakdown the engine didn't measure.
