/**
 * Mini-preview styling of a skin card, built from the skin's own tokens. The
 * result is a set of component-local custom properties; every colour is
 * re-checked against the skin colour grammar before it is handed to CSS.
 * @module @deepseek-ai/dsh-client-ui-skin/preview
 */
import type { CSSProperties } from 'react'
import type { SkinDefinition } from '@deepseek-ai/dsh-api-remotes/client'
import { isSafeColor } from './color.ts'
import { gradientCss } from './gradient.ts'

/** Which skin token paints which part of the preview. */
const PREVIEW_TOKENS = [
  ['--dsh-skin-pv-bg', '--dsw-alias-bg-base'],
  ['--dsh-skin-pv-side', '--dsw-alias-bg-layer-1'],
  ['--dsh-skin-pv-text', '--dsw-alias-label-primary'],
  ['--dsh-skin-pv-muted', '--dsw-alias-label-secondary'],
  ['--dsh-skin-pv-border', '--dsw-alias-border-l2'],
  ['--dsh-skin-pv-accent', '--dsw-accent'],
] as const

/**
 * Custom properties that paint a card's mini preview.
 * @param skin - the catalog skin.
 * @returns the `--dsh-skin-pv-*` properties of every part with a usable colour, plus the gradient image
 * when the skin has a usable background.
 */
export function previewStyle(skin: SkinDefinition): CSSProperties {
  const style: Record<string, string> = {}
  for (const [property, token] of PREVIEW_TOKENS) {
    const value = skin.tokens[token]
    if (isSafeColor(value)) style[property] = value
  }
  const image = skin.background === undefined ? undefined : gradientCss(skin.background)
  if (image !== undefined) style['--dsh-skin-pv-image'] = image
  return style
}
