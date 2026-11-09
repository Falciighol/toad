---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

# Test page + run analysis

Mode: Operate. Scope: the dedicated test page (Stage rail: Flow · Data · Load · Checks · Review), the tests library, the live run view and the run analysis (Overview · Endpoints · Timeline · Errors · Samples · Config). Full brief: docs/design/test-builder-shape.md (confirmed 2026-11-06).

Audience: backend devs re-running a test within seconds; perf/QA engineers building multi-scenario tests and explaining results.

## Direction contract

THESIS: Building a load test is a sequence of stages you can jump between, never a wizard; the load profile is drawn, and the same drawing judges the run. Refuses the category default of one long form beside a dashboard.

OWN-WORLD: Toad's incumbent Saga world: near-black (dark) / warm paper (light) ground, chrome-coloured rail, Mint accent only for primary action, selection and the plan line; Instrument Sans for UI, Geist Mono for every literal value, URL and number; hairline cards, 12px radii, 5-step type scale.

STORY: A dev sees their request, presses ⌘Enter, and reads which endpoint is slow; a perf engineer shapes stages, sets thresholds, then opens the exact failed request and the iteration that caused it.

FIRST VIEWPORT: Header (back, inline name, Saving/Saved, environment, load chip, Try once, Start). 200px rail with stage summaries and error badges. Flow: 280px step outline left, step editor right with the Resolved preview docked below.

FORM: Stage rail, position 6 on the ordered list, seed 166c683a. Signature: the draggable load-profile chart, echoed as planned-vs-achieved in Overview; raises: endpoint board re-sorts by p99 and holds breached rows lit; live resolved-template readout.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
