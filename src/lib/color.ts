// Color math for the theme. Ramps are built in OKLCH, so a stop has the same lightness (and the same contrast against
// the ground) whatever its hue. That's what lets every accent share one set of contrast checks.

export type Rgb = [number, number, number]

/** The stops every ramp has, light to dark. */
export const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const
export type Stop = (typeof STOPS)[number]
export type Ramp = Record<Stop, Rgb>

const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)

function linear(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  ]
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -0.0002 && v <= 1.0002)

/** OKLCH to sRGB bytes. A color outside sRGB loses chroma until it fits, keeping its hue; clipping would shift the hue. */
export function oklch(l: number, c: number, h: number): Rgb {
  let rgb = linear(l, c, h)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = c
    rgb = linear(l, 0, h)
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2
      const next = linear(l, mid, h)
      if (inGamut(next)) {
        rgb = next
        lo = mid
      } else hi = mid
    }
  }
  return rgb.map((v) => Math.round(encode(Math.min(1, Math.max(0, v))) * 255)) as Rgb
}

/**
 * Eleven stops on a lightness spine. `chroma` peaks where the curve is 1, and `hue` is either one hue or one per stop.
 */
export function ramp(lightness: readonly number[], curve: readonly number[], chroma: number, hue: number | readonly number[]): Ramp {
  const out = {} as Ramp
  STOPS.forEach((stop, i) => {
    out[stop] = oklch(lightness[i]!, curve[i]! * chroma, typeof hue === "number" ? hue : hue[i]!)
  })
  return out
}

export const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`

export const rgba = (c: Rgb, alpha: number) => `rgb(${c.join(" ")} / ${alpha})`
