/**
 * The override layer: the user's accent, and the translucent surfaces and glass
 * materials that make a backdrop visible, expressed as one `ctx.theme`
 * token-override layer. Pure over (settings, backdrop on/off), so every branch
 * is testable without a DOM.
 *
 * Contracts that keep the result well-formed:
 *  - a surface token is rebound to a `color-mix()` over the alias it replaces,
 *    never over itself (a self-reference is a cycle and resolves to nothing);
 *  - without a backdrop nothing about surfaces or materials is overridden, so
 *    the product keeps its opaque panes;
 *  - the accent family is overridden as a unit so hover and soft states never
 *    keep the previous accent's hue.
 * @module @deepseek-ai/dsh-client-ui-skin/overrides
 */
import type { ThemeTokenModes, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { accentHover, accentSoft } from './color.ts'
import { isHexColor, type SkinSettings } from './settings.ts'

/** Layer source passed to `ctx.theme.overrideTokens`. */
export const OVERRIDE_SOURCE = 'ui-skin'

/** `backdrop-filter` value of each glass material (the `off` material sets none). */
export const MATERIAL_FILTERS = {
  frosted: 'blur(16px) saturate(1.4)',
  liquid: 'blur(28px) saturate(1.8) brightness(1.05)',
} as const satisfies Record<'frosted' | 'liquid', string>

/** What the override layer is computed from. */
export interface OverrideInput {
  /** Normalised user settings. */
  settings: SkinSettings
  /** Whether a wallpaper or a skin gradient currently paints behind the frame and may show through. */
  backdropActive: boolean
}

/** A value that is the same in both palette modes. */
function both(value: string): ThemeTokenModes {
  return { light: value, dark: value }
}

/** Percentage text of an opacity: 0.82 becomes `82%`. */
function percent(opacity: number): string {
  return `${String(Number((opacity * 100).toFixed(2)))}%`
}

/** A surface rebound to `alias` at the given opacity over whatever paints behind. */
function translucent(alias: string, opacity: number): ThemeTokenModes {
  return both(`color-mix(in srgb, var(${alias}) ${percent(opacity)}, transparent)`)
}

/**
 * Compute the override layer.
 * @param input - settings and whether a backdrop is active.
 * @returns token overrides; empty when there is nothing to override (no accent, no backdrop).
 */
export function computeOverrides(input: OverrideInput): ThemeTokenOverrides {
  const { settings, backdropActive } = input
  const layer: ThemeTokenOverrides = {}
  if (isHexColor(settings.accent)) {
    layer['--dsw-accent'] = both(settings.accent)
    layer['--dsw-accent-hover'] = {
      light: accentHover(settings.accent, 'light'),
      dark: accentHover(settings.accent, 'dark'),
    }
    layer['--dsw-accent-soft'] = both(accentSoft(settings.accent))
  }
  if (!backdropActive) return layer
  layer['--dsw-surface-pane'] = translucent('--dsw-alias-bg-base', settings.panelOpacity)
  layer['--dsw-surface-sidebar'] = translucent('--dsw-specific-sidebar-fill', settings.panelOpacity)
  layer['--dsw-surface-composer'] = translucent('--dsw-specific-input-major', settings.composerOpacity)
  layer['--dsw-surface-popover'] = translucent('--dsw-specific-menu', settings.popoverOpacity)
  if (settings.material !== 'off') {
    const filter = both(MATERIAL_FILTERS[settings.material])
    layer['--dsw-material-panel-filter'] = filter
    layer['--dsw-material-composer-filter'] = filter
    layer['--dsw-material-popover-filter'] = filter
  }
  return layer
}
