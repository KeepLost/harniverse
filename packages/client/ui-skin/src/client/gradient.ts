/**
 * Structured skin background to CSS gradients. The builder takes numbers and
 * colours only: every number is checked finite and clamped, every colour passes
 * the skin colour grammar, and a layer that fails either test is dropped whole
 * instead of being repaired, so no pack text other than validated tokens ever
 * reaches a declaration.
 * @module @deepseek-ai/dsh-client-ui-skin/gradient
 */
import type { SkinBackground, SkinGradientLayer, SkinGradientStop } from '@deepseek-ai/dsh-api-remotes/client'
import { isSafeColor } from './color.ts'

/** Radial sizes are percentages of the larger viewport side, 1..150. */
const RADIAL_SIZE = { min: 1, max: 150 } as const

/** Round to two decimals and print without exponent noise. */
function number(value: number): string {
  return String(Number(value.toFixed(2)))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Stops as `<colour> <position>%` text, or undefined when fewer than two stops
 * survive or any stop is invalid (a gradient with one stop is not a gradient).
 */
function stopsOf(stops: readonly SkinGradientStop[]): string | undefined {
  if (stops.length < 2) return undefined
  const parts: string[] = []
  for (const [color, position] of stops) {
    if (!isSafeColor(color) || !Number.isFinite(position)) return undefined
    parts.push(`${color} ${number(clamp(position, 0, 100))}%`)
  }
  return parts.join(', ')
}

function layerOf(layer: SkinGradientLayer): string | undefined {
  const stops = stopsOf(layer.stops)
  if (stops === undefined) return undefined
  if (layer.type === 'linear') {
    if (!Number.isFinite(layer.angle)) return undefined
    return `linear-gradient(${number(((layer.angle % 360) + 360) % 360)}deg, ${stops})`
  }
  const [x, y] = layer.at
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(layer.size)) return undefined
  const size = clamp(layer.size, RADIAL_SIZE.min, RADIAL_SIZE.max)
  return `radial-gradient(circle ${number(size)}vmax at ${number(clamp(x, 0, 100))}% ${number(clamp(y, 0, 100))}%, ${stops})`
}

/**
 * Convert a skin background to a `background-image` value.
 * @param background - the validated structured gradient.
 * @returns the comma-joined gradients (first layer on top), or undefined when no layer is usable.
 */
export function gradientCss(background: SkinBackground): string | undefined {
  const layers = background.layers.flatMap((layer) => {
    const css = layerOf(layer)
    return css === undefined ? [] : [css]
  })
  return layers.length === 0 ? undefined : layers.join(', ')
}
