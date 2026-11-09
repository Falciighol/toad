// Toad's palette, built on the Saga design system (../saga/design/saga-design-system): one near-colorless ground for
// every accent, a pack of OKLCH ramps per accent, and roles picked from them. The palette lives here, not in CSS, so
// charts and anything drawn in code use exactly the same colors. index.css holds first-paint fallbacks for the default
// accent; re-generate them if a stop below moves.

import { hex, ramp, rgba, type Ramp } from "./color";

export type ResolvedTheme = "dark" | "light";
export type Accent = "violet" | "blue" | "mint" | "lime" | "amber" | "coral";

interface Hue {
  hue: number;
  chroma: number;
}

interface Pack {
  label: string;
  brand: Hue;
  success: Hue;
  danger: Hue;
  warning: Hue;
  info: Hue;
}

const STATUS = {
  success: { hue: 152, chroma: 0.14 },
  danger: { hue: 30, chroma: 0.185 },
  warning: { hue: 78, chroma: 0.15 },
  info: { hue: 232, chroma: 0.13 },
};

/** Each accent moves any status hue within 26° of its own, so a selected row never reads as a status. */
export const ACCENTS: Record<Accent, Pack> = {
  violet: { label: "Violet", brand: { hue: 288, chroma: 0.165 }, ...STATUS },
  blue: { label: "Blue", brand: { hue: 260, chroma: 0.145 }, ...STATUS, info: { hue: 205, chroma: 0.13 } },
  mint: { label: "Mint", brand: { hue: 167, chroma: 0.13 }, ...STATUS, success: { hue: 136, chroma: 0.14 } },
  lime: { label: "Lime", brand: { hue: 125, chroma: 0.165 }, ...STATUS, success: { hue: 158, chroma: 0.13 } },
  amber: { label: "Amber", brand: { hue: 79, chroma: 0.145 }, ...STATUS, warning: { hue: 106, chroma: 0.14 } },
  coral: { label: "Coral", brand: { hue: 34, chroma: 0.17 }, ...STATUS, danger: { hue: 6, chroma: 0.18 } },
};

/** Toad's accent. Mint is the Saga pack closest to Toad's green. */
export const DEFAULT_ACCENT: Accent = "mint";
export const ACCENT_ORDER: Accent[] = ["violet", "blue", "mint", "lime", "amber", "coral"];

// The ground: warm paper at the light end, cool graphite at the dark end. Its chroma fades out through the middle, where
// the hue changes, so the change never shows.
const GROUND_L = [0.985, 0.958, 0.92, 0.865, 0.745, 0.665, 0.495, 0.43, 0.355, 0.215, 0.17];
const GROUND_C = [0.75, 0.85, 0.55, 0.2, 0.05, 0.05, 0.2, 0.5, 0.75, 0.9, 0.85];
const GROUND_HUE = [92, 92, 92, 92, 92, 262, 262, 262, 262, 262, 262];
const GROUND = ramp(GROUND_L, GROUND_C, 0.009, GROUND_HUE);

// Tailwind v4's lightness spine for the colored ramps. White text on 600 passes AA, and so does dark ink on 400.
const COLOR_L = [0.97, 0.932, 0.882, 0.809, 0.707, 0.623, 0.546, 0.488, 0.424, 0.379, 0.282];
const COLOR_C = [0.1, 0.19, 0.36, 0.58, 0.84, 1.0, 0.98, 0.88, 0.76, 0.66, 0.46];
const colorRamp = (h: Hue) => ramp(COLOR_L, COLOR_C, h.chroma, h.hue);

/** The color a picker shows for an accent: its 400 stop, the same in both themes. */
export const accentSwatch = (a: Accent) => hex(colorRamp(ACCENTS[a].brand)[400]);

/**
 * Chart series are the one place hue carries data. None of them is the accent: the accent marks the primary action,
 * selection and the planned load line, so data never borrows it. Series are the first candidates at least 60° from the
 * accent, in order, so they never blur into each other or into it.
 */
const SERIES_CANDIDATES: Hue[] = [
  { hue: 50, chroma: 0.16 },
  { hue: 288, chroma: 0.16 },
  { hue: 232, chroma: 0.13 },
  { hue: 340, chroma: 0.16 },
  { hue: 110, chroma: 0.15 },
  { hue: 185, chroma: 0.12 },
];
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

export interface Palette {
  /** The window, behind the results. */
  bg: string;
  /** Title bar, side panel and footer. */
  chrome: string;
  /** Cards, popovers, menus and dialogs. */
  panel: string;
  /** Hover, and quiet fills such as a segmented control's track. */
  raised: string;
  /** A stronger fill: pressed, open, or hovered inside something already raised. */
  raised2: string;
  /** The chosen segment of a segmented control. */
  seg: string;
  /** Dividers and card edges. */
  line: string;
  /** Control edges: inputs, ghost buttons, popovers. */
  line2: string;
  /** A control's edge on hover. */
  line3: string;
  text: string;
  text2: string;
  text3: string;
  /** Placeholders, counts and faint glyphs. Still passes AA. */
  text4: string;
  /** Fills: the primary button, a switch that's on, focus rings, progress. */
  accent: string;
  accentHover: string;
  /** Accent text and icons. */
  accentInk: string;
  /** Selected rows and the active view. */
  accentSoft: string;
  /** Text and icons drawn on `accent` or `dangerFill`. */
  onAccent: string;
  success: string;
  successSoft: string;
  danger: string;
  dangerSoft: string;
  /** A destructive button. */
  dangerFill: string;
  warning: string;
  warningSoft: string;
  info: string;
  infoSoft: string;
  series1: string;
  series2: string;
  series3: string;
  /** Chart gridlines. */
  grid: string;
  overlay: string;
  shadow: string;
}

const status = (r: Ramp, ink: 300 | 700) => ({ ink: hex(r[ink]), soft: rgba(r[500], 0.12) });

export function palette(theme: ResolvedTheme, accent: Accent = DEFAULT_ACCENT): Palette {
  const pack = ACCENTS[accent];
  const brand = colorRamp(pack.brand);
  const s = (stop: keyof Ramp) => hex(GROUND[stop]);
  const dark = theme === "dark";
  const ink = dark ? 300 : 700;
  const [success, danger, warning, info] = [pack.success, pack.danger, pack.warning, pack.info].map((h) => status(colorRamp(h), ink));
  const fill = (r: Ramp) => hex(r[dark ? 400 : 600]);
  const tint = dark ? "255 255 255" : "40 32 16";
  const [series1, series2, series3] = SERIES_CANDIDATES.filter((h) => hueGap(h.hue, pack.brand.hue) >= 60).map((h) => fill(colorRamp(h)));

  return {
    bg: dark ? "#000000" : s(100),
    chrome: dark ? "#000000" : s(50),
    panel: dark ? "#0e0e10" : s(50),
    raised: `rgb(${tint} / ${dark ? 0.04 : 0.05})`,
    raised2: `rgb(${tint} / 0.08)`,
    seg: dark ? "rgb(255 255 255 / 0.12)" : s(50),
    line: dark ? "rgb(255 255 255 / 0.06)" : s(200),
    line2: dark ? "rgb(255 255 255 / 0.1)" : s(300),
    line3: dark ? "rgb(255 255 255 / 0.16)" : s(400),
    text: dark ? s(100) : s(900),
    text2: dark ? s(300) : s(800),
    text3: dark ? s(400) : s(700),
    text4: dark ? s(500) : s(600),
    accent: fill(brand),
    accentHover: hex(brand[dark ? 300 : 700]),
    accentInk: hex(brand[ink]),
    accentSoft: rgba(brand[dark ? 400 : 500], dark ? 0.14 : 0.12),
    onAccent: dark ? s(950) : "#ffffff",
    success: success!.ink,
    successSoft: success!.soft,
    danger: danger!.ink,
    dangerSoft: danger!.soft,
    dangerFill: fill(colorRamp(pack.danger)),
    warning: warning!.ink,
    warningSoft: warning!.soft,
    info: info!.ink,
    infoSoft: info!.soft,
    series1: series1!,
    series2: series2!,
    series3: series3!,
    grid: dark ? "rgb(255 255 255 / 0.06)" : s(200),
    overlay: dark ? "rgb(0 0 0 / 0.6)" : "rgb(28 24 16 / 0.32)",
    shadow: dark
      ? "0 18px 48px rgb(0 0 0 / 0.5), 0 0 0 1px rgb(255 255 255 / 0.04)"
      : "0 18px 48px rgb(40 30 10 / 0.16), 0 0 0 1px rgb(0 0 0 / 0.05)",
  };
}

/** `accentHover` → `--accent-hover`. */
export const varName = (key: string) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export function applyPalette(p: Palette, theme: ResolvedTheme) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(p)) root.style.setProperty(varName(key), value);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

// The accent is an appearance preference of this machine, not a test setting, so it lives in localStorage rather than
// in the Rust-side Settings. It applies the moment it's picked, as in Saga.
const ACCENT_KEY = "toad.accent";
const isAccent = (v: unknown): v is Accent => typeof v === "string" && v in ACCENTS;

function storedAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return isAccent(v) ? v : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

let currentAccent: Accent = DEFAULT_ACCENT;
let reapply: () => void = () => {};
const listeners = new Set<() => void>();

export const getAccent = () => currentAccent;

export function setAccent(accent: Accent) {
  if (accent === currentAccent) return;
  currentAccent = accent;
  try {
    localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    // Storage can be unavailable; the choice still holds for this session.
  }
  reapply();
  for (const l of listeners) l();
}

/** For useSyncExternalStore. */
export function subscribeAccent(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Applies the stored accent and follows the OS light/dark setting, like the rest of Toad. Returns a function that stops following it. */
export function followSystemTheme(): () => void {
  currentAccent = storedAccent();
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const theme: ResolvedTheme = mq.matches ? "dark" : "light";
    applyPalette(palette(theme, currentAccent), theme);
  };
  reapply = apply;
  apply();
  mq.addEventListener("change", apply);
  return () => {
    mq.removeEventListener("change", apply);
    reapply = () => {};
  };
}
