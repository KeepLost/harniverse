/**
 * Colour helpers: hex mixing for the derived accent family and the
 * client-side re-check of skin colours. Hosts validate packs before serving
 * them, but a colour reaches CSS here, so the same grammar is enforced again
 * at the point of use.
 * @module @deepseek-ai/dsh-client-ui-skin/color
 */

/** An sRGB colour with 0..255 integer channels. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** How far the hover accent moves toward white (light) or black (dark). */
export const HOVER_SHIFT = 0.2

/** How much accent the soft tint keeps over the surface behind it. */
export const SOFT_ALPHA_PERCENT = 18

/** How much accent a reference chip keeps over the text surface it sits on. */
export const CHIP_ALPHA_PERCENT = 22

const MAX_COLOR_LENGTH = 64
const HEX_FORMS = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?`
const SEPARATOR = String.raw`(?:\s*,\s*|\s+)`
const FUNCTIONAL = new RegExp(
  String.raw`^(?:rgba?|hsla?)\(\s*${NUMBER}${SEPARATOR}${NUMBER}${SEPARATOR}${NUMBER}(?:(?:${SEPARATOR}|\s*/\s*)${NUMBER})?\s*\)$`,
  'i',
)

/**
 * Whether a string is a colour from the skin colour grammar: `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`/`hsl()`/`hsla()` with three or four
 * numeric arguments, or `transparent`. Anything that could carry a URL, a
 * variable, a function call, or a declaration break is refused.
 * @param value - candidate CSS colour text.
 * @returns true when the text is safe to place in a declaration.
 */
export function isSafeColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_COLOR_LENGTH) return false
  return HEX_FORMS.test(value) || FUNCTIONAL.test(value) || value.toLowerCase() === 'transparent'
}

/**
 * Parse a `#rrggbb` colour. The caller has already established the form (see
 * `isHexColor`); a malformed input yields NaN channels rather than a guess.
 * @param hex - lowercase six-digit hex colour.
 * @returns the channels.
 */
export function parseHex(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

/**
 * Format channels as a lowercase `#rrggbb` string.
 * @param rgb - channels, rounded to integers.
 * @returns the hex colour.
 */
export function toHex(rgb: Rgb): string {
  const channel = (value: number): string => Math.round(value).toString(16).padStart(2, '0')
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`
}

/**
 * Linear sRGB-channel mix of two hex colours.
 * @param from - base colour.
 * @param to - colour mixed in.
 * @param weight - share of `to` in the result, 0..1.
 * @returns the mixed `#rrggbb` colour.
 */
export function mixHex(from: string, to: string, weight: number): string {
  const a = parseHex(from)
  const b = parseHex(to)
  return toHex({
    r: a.r + (b.r - a.r) * weight,
    g: a.g + (b.g - a.g) * weight,
    b: a.b + (b.b - a.b) * weight,
  })
}

/**
 * The hover state of an accent. The base palettes move hover away from the
 * resting accent in the direction of emphasis — lighter on light surfaces,
 * darker on dark ones — so the derived hover follows the same direction.
 * @param accent - `#rrggbb` accent.
 * @param scheme - the base palette the accent sits on.
 * @returns the hover colour.
 */
export function accentHover(accent: string, scheme: 'light' | 'dark'): string {
  return mixHex(accent, scheme === 'dark' ? '#000000' : '#ffffff', HOVER_SHIFT)
}

/**
 * The soft (tinted background) state of an accent. It stays translucent so it
 * reads correctly over a flat surface and over a wallpaper alike.
 * @param accent - `#rrggbb` accent.
 * @returns a `color-mix()` value.
 */
export function accentSoft(accent: string): string {
  return `color-mix(in srgb, ${accent} ${String(SOFT_ALPHA_PERCENT)}%, transparent)`
}

/**
 * The chip tint of an accent: the translucent wash behind an inline reference
 * (a `@file` or `/skill` chip), a touch stronger than the soft state because it
 * sits under body text.
 * @param accent - `#rrggbb` accent.
 * @returns a `color-mix()` value.
 */
export function accentChip(accent: string): string {
  return `color-mix(in srgb, ${accent} ${String(CHIP_ALPHA_PERCENT)}%, transparent)`
}
