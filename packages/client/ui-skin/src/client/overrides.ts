/**
 * The override layer: the user's accent, and the translucent surfaces and glass
 * materials that make a backdrop visible, expressed as one `ctx.theme`
 * token-override layer. Pure over (settings, backdrop on/off), so every branch
 * is testable without a DOM.
 *
 * Contracts that keep the result well-formed:
 *  - a surface token is rebound to a `color-mix()` over the alias it replaces,
 *    never over itself (a self-reference is a cycle and resolves to nothing);
 *  - the dialog and composer surfaces are mixed over an opaque companion, so
 *    an opacity of 1 is a solid surface even when the skin bakes alpha into an
 *    alias (the composer over the raised layer, whose wash alias could not
 *    carry a visible range); every companion read falls back to the alias
 *    itself where the engine lacks relative colour syntax (see ui-theme
 *    `skin-seams.css`);
 *  - without a backdrop nothing about surfaces or materials is overridden, so
 *    the product keeps its default panes — except while the system forces
 *    opaque rendering, when the pane, sidebar, popover, and dialog surfaces are
 *    bound to the opaque companions of their aliases;
 *  - the accent family is overridden as a unit so hover and soft states never
 *    keep the previous accent's hue.
 * @module @deepseek-ai/dsh-client-ui-skin/overrides
 */
import type { ThemeTokenModes, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { accentChip, accentHover, accentSoft } from './color.ts'
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
  /** Whether the system asks for reduced transparency or more contrast; it wins over `backdropActive`. */
  forcedOpaque: boolean
}

/** Alias the dialog seam replaces, and the opaque companion ui-theme declares for it. */
const DIALOG_ALIAS = '--dsw-alias-bg-layer-2'
const OPAQUE_DIALOG = '--dsw-opaque-dialog'

/**
 * The composer mixes over the opaque raised layer, not over its wash alias: a
 * white 8% wash mixed over transparent only ever moves between 3% and 8% of
 * paint, so its slider could change nothing on the dark skins. Over the raised
 * layer, 100% is a solid card in every skin and the low end stays a wash.
 */
const OPAQUE_COMPOSER = '--dsw-opaque-composer'

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

/** `var()` read of an opaque companion, falling back to the alias where the companion is undeclared. */
function opaqueRead(companion: string, alias: string): string {
  return `var(${companion}, var(${alias}))`
}

/** A surface bound to the opaque companion of the alias it replaces. */
function solid(companion: string, alias: string): ThemeTokenModes {
  return both(opaqueRead(companion, alias))
}

/** The dialog surface at `opacity` over the opaque companion of its alias. */
function dialogSurface(opacity: number): ThemeTokenModes {
  return both(`color-mix(in srgb, ${opaqueRead(OPAQUE_DIALOG, DIALOG_ALIAS)} ${percent(opacity)}, transparent)`)
}

/** The composer card at `opacity` over the opaque raised layer. */
function composerSurface(opacity: number): ThemeTokenModes {
  return both(`color-mix(in srgb, ${opaqueRead(OPAQUE_COMPOSER, DIALOG_ALIAS)} ${percent(opacity)}, transparent)`)
}

/**
 * Compute the override layer.
 * @param input - settings, whether a backdrop is active, and whether the system forces opaque rendering.
 * @returns token overrides; empty when there is nothing to override (no accent, no backdrop, no forced opacity).
 */
export function computeOverrides(input: OverrideInput): ThemeTokenOverrides {
  const { settings, backdropActive, forcedOpaque } = input
  const layer: ThemeTokenOverrides = {}
  if (isHexColor(settings.accent)) {
    layer['--dsw-accent'] = both(settings.accent)
    layer['--dsw-accent-hover'] = {
      light: accentHover(settings.accent, 'light'),
      dark: accentHover(settings.accent, 'dark'),
    }
    layer['--dsw-accent-soft'] = both(accentSoft(settings.accent))
    layer['--dsw-accent-chip'] = both(accentChip(settings.accent))
  }
  if (forcedOpaque) {
    // The composer is left on its alias: it is a wash over the (now opaque) pane, and dropping its alpha would paint a white card.
    layer['--dsw-surface-pane'] = solid('--dsw-opaque-pane', '--dsw-alias-bg-base')
    layer['--dsw-surface-sidebar'] = solid('--dsw-opaque-sidebar', '--dsw-specific-sidebar-fill')
    layer['--dsw-surface-popover'] = solid('--dsw-opaque-popover', '--dsw-specific-menu')
    layer['--dsw-surface-dialog'] = solid(OPAQUE_DIALOG, DIALOG_ALIAS)
    return layer
  }
  if (!backdropActive) return layer
  layer['--dsw-surface-pane'] = translucent('--dsw-alias-bg-base', settings.panelOpacity)
  layer['--dsw-surface-sidebar'] = translucent('--dsw-specific-sidebar-fill', settings.panelOpacity)
  layer['--dsw-surface-composer'] = composerSurface(settings.composerOpacity)
  layer['--dsw-surface-bubble'] = translucent('--dsw-specific-bubble', settings.bubbleOpacity)
  layer['--dsw-surface-popover'] = translucent('--dsw-specific-menu', settings.popoverOpacity)
  layer['--dsw-surface-dialog'] = dialogSurface(settings.dialogOpacity)
  if (settings.material !== 'off') {
    const filter = both(MATERIAL_FILTERS[settings.material])
    layer['--dsw-material-panel-filter'] = filter
    layer['--dsw-material-composer-filter'] = filter
    layer['--dsw-material-popover-filter'] = filter
    layer['--dsw-material-dialog-filter'] = filter
    // With glass behind the composer, its docking seat clears the way: the
    // conversation paints a blurred plate over the seat instead of the pane
    // fill, so the wallpaper shows through and the card is the only layer.
    layer['--dsw-surface-composer-seat'] = both('transparent')
  }
  return layer
}
