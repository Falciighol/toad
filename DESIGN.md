---
name: Toad
description: A small, fast desktop app for load-testing HTTP APIs, drawn in Saga's near-colorless world with one Mint accent.
colors:
  # Dark theme (primary target). Runtime source: src/lib/theme.ts palette("dark", "mint"); first paint: src/index.css.
  ground-dark: "#111213"
  chrome-dark: "#1d1e20"
  panel-dark: "#1d1e20"
  raised-dark: "rgb(255 255 255 / 0.05)"
  raised2-dark: "rgb(255 255 255 / 0.09)"
  seg-dark: "rgb(255 255 255 / 0.14)"
  line-dark: "rgb(255 255 255 / 0.11)"
  line2-dark: "rgb(255 255 255 / 0.16)"
  line3-dark: "rgb(255 255 255 / 0.26)"
  text-dark: "#f3f1eb"
  text2-dark: "#d3d2d1"
  text3-dark: "#acacac"
  text4-dark: "#939494"
  accent-dark: "#52b692"
  accent-hover-dark: "#91d1b6"
  accent-ink-dark: "#91d1b6"
  accent-soft-dark: "rgb(82 182 146 / 0.14)"
  on-accent-dark: "#0e0f13"
  success-dark: "#a9cd99"
  danger-dark: "#fea697"
  danger-fill-dark: "#f27664"
  warning-dark: "#e0ba80"
  info-dark: "#8ecae9"
  series1-dark: "#e2854e"
  series2-dark: "#9d92ef"
  series3-dark: "#4facd9"
  grid-dark: "rgb(255 255 255 / 0.07)"
  overlay-dark: "rgb(0 0 0 / 0.6)"
  # Light theme. Runtime source: palette("light", "mint").
  ground-light: "#edece7"
  chrome-light: "#fcfaf5"
  panel-light: "#fcfaf5"
  raised-light: "rgb(40 32 16 / 0.05)"
  raised2-light: "rgb(40 32 16 / 0.08)"
  seg-light: "#fcfaf5"
  line-light: "#dcdbd9"
  line2-light: "#c3c3c2"
  line3-light: "#acacac"
  text-light: "#171a1d"
  text2-light: "#3a3c3f"
  text3-light: "#4e5052"
  text4-light: "#616263"
  accent-light: "#008562"
  accent-hover-light: "#007154"
  accent-ink-light: "#007154"
  accent-soft-light: "rgb(0 159 119 / 0.12)"
  on-accent-light: "#ffffff"
  success-light: "#3d6f1f"
  danger-light: "#a92c1f"
  danger-fill-light: "#c43627"
  warning-light: "#7f5700"
  info-light: "#00698e"
  series1-light: "#b05100"
  series2-light: "#6e5cc5"
  series3-light: "#007ba6"
  grid-light: "#e6e4e1"
  overlay-light: "rgb(28 24 16 / 0.32)"
  # Status tints, identical in both themes.
  success-soft: "rgb(94 153 61 / 0.12)"
  danger-soft: "rgb(225 78 61 / 0.12)"
  warning-soft: "rgb(177 123 0 / 0.12)"
  info-soft: "rgb(0 147 198 / 0.12)"
typography:
  display:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: "26px"
    fontFeature: "tnum"
  title:
    fontFamily: "Instrument Sans Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
  body:
    fontFamily: "Instrument Sans Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  label:
    fontFamily: "Instrument Sans Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  micro:
    fontFamily: "Instrument Sans Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "14px"
  mono-value:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
    fontFeature: "tnum"
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "2.5": "10px"
  "3": "12px"
  "4": "16px"
  "7": "28px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent-dark}"
    textColor: "{colors.on-accent-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover-dark}"
    textColor: "{colors.on-accent-dark}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text2-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.raised-dark}"
    textColor: "{colors.text-dark}"
  button-subtle:
    backgroundColor: "transparent"
    textColor: "{colors.text2-dark}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "32px"
  button-small:
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "26px"
  button-danger:
    backgroundColor: "{colors.danger-fill-dark}"
    textColor: "{colors.on-accent-dark}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "32px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text2-dark}"
    rounded: "{rounded.lg}"
    size: "28px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.text-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  card:
    backgroundColor: "{colors.panel-dark}"
    rounded: "{rounded.xl}"
    padding: "16px"
  floating:
    backgroundColor: "{colors.panel-dark}"
    rounded: "{rounded.xl}"
    padding: "4px"
  stat:
    backgroundColor: "{colors.panel-dark}"
    textColor: "{colors.text-dark}"
    typography: "{typography.display}"
    rounded: "{rounded.xl}"
    padding: "12px 16px"
  pill-neutral:
    backgroundColor: "{colors.raised2-dark}"
    textColor: "{colors.text3-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  pill-accent:
    backgroundColor: "{colors.accent-soft-dark}"
    textColor: "{colors.accent-ink-dark}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  pill-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-dark}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  segmented-track:
    backgroundColor: "{colors.raised2-dark}"
    rounded: "{rounded.lg}"
    padding: "3px"
  segmented-option-selected:
    backgroundColor: "{colors.seg-dark}"
    textColor: "{colors.text-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "26px"
  tab:
    textColor: "{colors.text3-dark}"
    typography: "{typography.body}"
    height: "34px"
  tab-active:
    textColor: "{colors.text-dark}"
  rail-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
  rail-item-active:
    backgroundColor: "{colors.accent-soft-dark}"
    textColor: "{colors.text-dark}"
  outline-item-selected:
    backgroundColor: "{colors.accent-soft-dark}"
    rounded: "{rounded.lg}"
    padding: "6px 8px"
  template-variable:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info-dark}"
    typography: "{typography.mono-value}"
    rounded: "{rounded.xs}"
  template-generator:
    backgroundColor: "{colors.raised2-dark}"
    textColor: "{colors.text2-dark}"
    rounded: "{rounded.xs}"
  template-pending:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning-dark}"
    rounded: "{rounded.xs}"
  template-unknown:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-dark}"
    rounded: "{rounded.xs}"
  kbd:
    textColor: "{colors.text3-dark}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
---

# Design System: Toad

## Overview

**Creative North Star: "The Bench Instrument"**

Toad is a measuring instrument that sits next to the editor: a near-colorless ground, a chrome-coloured rail and header, hairline cards, and literal values set in mono so they read like readouts. Color is rationed. One accent (Mint by default) marks what you can act on and what you have chosen; status hues mean status; chart series are the only place hue carries data. Everything else is ground, line and text in four steps.

The world is Saga's: a near-black workspace under graphite chrome in dark, warm paper in light, built at runtime from OKLCH ramps in `src/lib/theme.ts` so charts and CSS share one palette. The accent is a per-machine preference across six packs (Violet, Blue, Mint, Lime, Amber, Coral); every rule here is written against roles, not hues, so it holds for any pack. Density is desktop-tool density: 13px body, 32px controls, 12px card radii, and no decoration that isn't carrying information. The signature is the drawn load profile: the plan is a line you drag, and the same chart later lays the achieved run over it.

The system refuses the category default of one long form beside a dashboard, and it refuses decorative color: no gradients, no tinted card backgrounds, no colored rail bars.

**Key Characteristics:**
- A near-black (dark) or deep-paper (light) workspace, with the chrome (header, rail, Flow outline, docked preview, footer) one clear step lighter, so every section reads as its own region before a hairline is needed.
- One accent, used only for the primary action, selection, focus and the planned-load line.
- Instrument Sans for interface text; Geist Mono with tabular figures for every literal value, URL, method and number.
- Five type sizes; hierarchy comes from weight and text tone, not more sizes.
- Flat panels with hairline edges; shadow only on things that float.
- Drawn, single-weight SVG icons; no glyphs standing in for icons.

## Colors

A colorless, two-theme ground with one accent and a disciplined set of meaning-bearing hues.

### Primary
- **Mint** (accent, `accent-dark` / `accent-light`): the fill of the primary action (Start), switches that are on, checkbox and range accent, the focus ring, the caret, the active tab underline, and the planned-load line in the profile chart. Mint is the default of six accent packs; its 400 stop is the dark fill and its 600 stop the light fill.
- **Mint Ink** (`accent-ink-*`): accent text and icons, such as the active rail item's icon and accent pills.
- **Mint Wash** (`accent-soft-*`): selection fill. The active rail item, the selected outline step, picked history rows and text selection all sit on this wash. Selected outline steps and picked rows add a 1px inset accent ring.

### Secondary
- **Status hues**: success (`success-*`), danger (`danger-*`, with `danger-fill-*` for destructive buttons and error dots), warning (`warning-*`) and info (`info-*`). Ink is the 300 stop in dark and 700 in light; soft tints (`*-soft`) are the 500 stop at 12%. An accent pack moves any status hue within 26° of its own so a selection never reads as a status (Mint pushes success to hue 136).
- **Info** carries template meaning: variables and resolved values are info on info-soft, and GET is info in the method column.

### Tertiary
- **Chart series** (`series1..3`): orange, violet and blue for Mint. They are the first candidates from a fixed list (hues 50, 288, 232, 340, 110, 185) at least 60° from the accent, so data never borrows the accent and never blurs into it. They color latency percentiles, Compare's A/B lines, per-scenario load profiles and inline latency bars and sparklines.

### Neutral
- **Ground** (`ground-*`): the workspace (the step editor, stage pages, run content). Near-black graphite (`#111213`) in dark, never pure `#000`; a deeper warm paper in light, a step below the chrome.
- **Chrome** (`chrome-*`): header, rail, footer, the Flow outline and the docked Resolved preview. Graphite in dark and the brightest paper in light: always one visible step above the workspace, equal to `panel`.
- **Panel** (`panel-*`): cards, popovers, menus, dialogs.
- **Raised / Raised 2** (`raised*-*`): hover fills and quiet tracks; raised2 is the segmented track, count badges, neutral pills and generator tokens.
- **Seg** (`seg-*`): the chosen segment of a segmented control.
- **Lines** (`line`, `line2`, `line3`): dividers and card edges; control edges; control edges on hover.
- **Text 1 to 4** (`text*-*`): primary, secondary, tertiary, and faint (placeholders, counts, axis ticks, reference lines). Text 4 still passes AA.
- **Grid** (`grid-*`) for chart gridlines; **Overlay** (`overlay-*`) behind dialogs.

### Named Rules
**The One Voice Rule.** The accent marks exactly four things: the primary action, selection, focus, and the planned load. A screen at rest shows it on Start and on whatever is selected, nowhere else.

**The No Side Bar Rule.** The active rail item is a full accent-wash fill with an accent-ink icon. It never carries a colored side stripe.

**The Data Never Borrows Rule.** Chart series are never the accent. Plans are the dashed accent line; achieved load over a plan is drawn in `text`; targets and reference lines are neutral `text4`, dashed.

**The Section Step Rule.** Sections separate by tone first and hairline second. Chrome sits one step above the workspace in both themes (graphite over near-black, bright paper over deep paper), dividers are at least `line`, and control edges at least `line2`. Never set chrome back to the workspace tone; a region the eye can't find without hunting for a 1px line is a contrast bug.

**The Token Tone Rule.** In templates and resolved previews: variables and resolved values are info, generators are neutral raised2, pending tokens are warning, unknown or invalid tokens are danger. Secrets render as masked dots, never colored.

## Typography

**Body Font:** Instrument Sans Variable (with ui-sans-serif, system-ui, -apple-system, Segoe UI)
**Label/Mono Font:** Geist Mono (with ui-monospace, SF Mono, Menlo, Consolas)

**Character:** A crisp grotesque for the interface and a precise mono for anything the user typed or the engine measured, so values read as values at a glance.

### Hierarchy
- **Display** (Geist Mono 500, 20px, 26px line-height, tabular): metric values in stat cards. The largest text in the app is a number.
- **Title** (600, 15px, 20px): page and section titles, the inline test name, the app wordmark.
- **Body** (400 or 500, 13px, 18px): default interface text, buttons (500; primary 600), tabs, inputs, menu items.
- **Label** (500, 12px, 16px): field labels, card titles (text3), pills, hints and errors (400), small buttons.
- **Micro** (11px, 14px): counts, Kbd, chart legends, axis ticks, outline secondary lines. List group headings in the Flow outline, Review and run warnings use micro 600 uppercase with wide tracking; this is a group heading for a list, never a label above another heading.

### Named Rules
**The Five Sizes Rule.** Exactly five sizes (11, 12, 13, 15, 20). Hierarchy comes from weight (400/500/600) and text tone (text to text4), not from new sizes.

**The Literal Is Mono Rule.** Every literal value, URL, header, HTTP method, variable name and number is Geist Mono with tabular figures. Error rates show one decimal, or two when one decimal would hide which side of an in-scope bound the value is on. Verdict values carry their unit.

## Layout

A desktop window (default 1320×860, minimum 980×640) with fixed chrome and scrolling content. The app header is a 44px chrome bar (wordmark, Tests/Runs segmented, Settings); the test page adds a 48px header row (back, inline name, Saving/Saved, environment, load chip, Try once, Start). A 28px chrome footer carries the safety line.

The test page is a stage rail: a 208px chrome rail of stages (Flow, Data, Load, Checks, Review), each with an icon, name and one-line summary, collapsing to a 56px icon rail at 1200px and below, where error counts become a 6px danger dot. Flow splits into a 288px chrome outline and a fluid step editor, with the Resolved preview docked beneath the editor. Library and Runs pages center a 1024px column with 32px side and 28px top padding.

Spacing runs on a 4px base. Controls are 32px tall (small 26px, icon buttons 28 or 24px). Cards pad 16px (stats 12×16). Rows pad 6 to 8px vertically. Common gaps are 6, 8, 12 and 16px.

## Elevation & Depth

Flat by default, with tonal layering. Panels separate from the ground by fill and a hairline, never by shadow. Only things that float (popovers, menus, dialogs, toasts, chart tooltips) carry the pop shadow, which pairs a soft drop with a 1px outline. Dialogs dim the window with the overlay and a 4px backdrop blur.

### Shadow Vocabulary
- **Pop, dark** (`box-shadow: 0 18px 48px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(255 255 255 / 0.06)`): floating surfaces in dark.
- **Pop, light** (`box-shadow: 0 18px 48px rgb(40 30 10 / 0.16), 0 0 0 1px rgb(0 0 0 / 0.05)`): floating surfaces in light.
- **Segment lift** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.12)`): the chosen segment of a segmented control only.
- **Selection ring** (`box-shadow: inset 0 0 0 1px var(--accent)`): selected outline steps and picked rows, on the accent wash.

### Named Rules
**The Only Floaters Cast Rule.** A card on the window has a hairline and no shadow. If it does not float above other content, it does not get the pop shadow.

## Shapes

Gently rounded and consistent. Cards and floating surfaces use 12px; controls, rows, rail items and menu items use 8px; segments 6px; Kbd 4px; inline template tokens 2px; pills, switches, count badges and dots are fully round. Edges are 1px hairlines; empty states use a dashed line2 border on a 12px card. Fields wear the 2px accent focus ring at a 2px offset around the whole field. Icons are drawn on a 24-unit grid with 2px round strokes in currentColor.

## Components

### Buttons
Quiet by default, with one loud one.
- **Shape:** gently curved (8px), 32px tall, 12px horizontal padding, 6px icon gap.
- **Default (ghost):** transparent with a line2 edge and text2 label at 500; hover brightens the edge to line3, fills raised and lifts the label to text.
- **Subtle:** the same with no edge until hovered; used for icon buttons and menu triggers.
- **Primary:** accent fill, on-accent label at 600, no edge; hover moves to accent-hover. Reserved for Start and the single primary action of a dialog.
- **Danger:** danger-fill with on-accent label; quiet destructive actions use danger ink on a subtle button.
- **Small:** 26px tall, 10px padding, 12px label. Disabled at 45% opacity.

### Chips
- **Pill:** fully round, 12px label at 500, 2×8px padding, optional 12px icon first. Tones: neutral (raised2 / text3), accent, success, info, warning, danger (danger is also 600). Pills state a condition; they are not buttons.
- **Kbd:** micro mono at 500, text3, line2 edge, 4px radius.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** panel.
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px line.
- **Internal Padding:** 16px; chart cards title in label/text3 with 12px below, plot 176px tall.

### Inputs / Fields
- **Style:** transparent fill, 1px line2 edge, 8px radius, 32px tall, 10px padding, body text; placeholders text4. Selects draw their own chevron. Number inputs are mono, tabular, with a text4 unit suffix.
- **Focus:** the shared 2px accent outline at 2px offset; hover edge line3.
- **Error / Disabled:** invalid fields take a danger edge and danger focus ring, with a 12px danger message below; disabled at 45%.
- **Labels:** 12px at 500 in text2, 6px above; optional fields add a quiet "Optional" in text4; required fields carry no marker.

### Navigation
- **Stage rail:** chrome column, 8px-radius items with icon, body-weight name and a micro text3 summary. Hover fills raised; active fills accent-soft with an accent-ink icon. Below 1200px it collapses to icons with a danger dot for issues.
- **Tabs:** underlined, 34px, body at 500, 16px gaps; inactive text3, active text with a 2px accent underline. Counts sit after the label as round raised2 mono badges; a 6px dot marks errors (danger-fill) or set state (accent).
- **Segmented:** a raised2 track with 3px inset; the chosen option sits on seg with the segment lift. Used for two to four choices (Tests/Runs, Sequence/Mix).

### Template tokens and Resolved preview
Template text is mono; tokens are inline 2px-radius tints following the Token Tone Rule. The Resolved preview docks beneath the step editor and shows the request as it will be sent, with pending tokens and their explanation in warning.

### Charts
- Axes: text4, 11px mono, no tick or axis lines; horizontal grid in `grid`. Axes start at 0 and step on round 1/2/2.5/5×10ⁿ values with a little headroom, and every tick on an axis shares one precision.
- Tooltip: a floating panel (12px, line2 edge, pop shadow) in 12px mono.
- Any chart with more than one line carries a legend of short line swatches (dashed for plans and targets).
- Vertical marker labels (stage boundaries, threshold crossings) step down in three rows so neighbours never overprint.

### Load profile (signature)
The plan is an editable area-and-line in the accent (12% area, 2px line) with draggable 5px handles (6.5px while dragging) that also move by arrow keys (Shift for 10). During and after a run, the same chart shows the plan dashed in the accent and the achieved load as a solid `text` line, with a dashed `now` marker. With several scenarios, each scenario's profile takes a series color instead of the accent.

### Endpoint board
A table that re-sorts by p99; a row whose threshold is breached holds a danger-soft fill until it is opened. HTTP methods are mono micro at 600, toned by verb (GET info, POST success, PUT/PATCH warning, DELETE danger).

## Do's and Don'ts

### Do:
- **Do** take every color from the runtime palette roles (`--bg`, `--panel`, `--line2`, `--accent-soft`); never hard-code a hex in a component, so all six accents and both themes keep working.
- **Do** set every literal value, URL, method and number in Geist Mono with tabular figures, and give verdict values their unit.
- **Do** mark selection with the accent wash (plus a 1px inset accent ring on list rows) and keep Start the only accent-filled button on screen.
- **Do** draw plans as dashed accent, achieved-over-plan as solid `text`, and targets or references as dashed `text4`.
- **Do** put round 1/2/2.5/5×10ⁿ ticks with one precision on every chart axis, and a legend on every chart with more than one line.
- **Do** use the drawn SVG icon set in `ui.tsx` for every icon, including arrows used as icons.

### Don't:
- **Don't** use the accent for chart series, status, decoration, or a colored side bar on the active rail item.
- **Don't** add a shadow to a card that sits on the window; shadow belongs only to floating surfaces.
- **Don't** introduce a sixth type size; reach for weight or text tone instead.
- **Don't** use Unicode glyphs as stand-ins for icons. Arrows inside prose and native dialog text are fine.
- **Don't** let a status hue sit within 26° of the accent, or a series within 60°; the palette builder enforces this, so don't override it.
- **Don't** put a small uppercase label above a heading; uppercase micro is only the heading of a list group.
