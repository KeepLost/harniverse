/**
 * The `ui-skin` settings section and the theme-preference vocabulary the skin
 * library reads. The browser package mirrors these field names; keep both in
 * step.
 * @module @deepseek-ai/dsh-host-skin-library/settings
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the skin library. */
export const UI_SKIN_NAMESPACE = 'ui-skin'

/** Namespace of the theme plugin whose preference selects a skin. */
export const UI_THEME_NAMESPACE = 'ui-theme'

/** Field of the theme section carrying the selected theme id. */
export const UI_THEME_PREFERENCE_FIELD = 'preference'

/** Theme-id prefix of a registered skin: `skin:<skinId>`. */
export const SKIN_THEME_PREFIX = 'skin:'

/** Glass treatment applied to panels and popovers. */
export const SKIN_MATERIALS = ['off', 'frosted', 'liquid'] as const

/** One glass treatment. */
type SkinMaterial = typeof SKIN_MATERIALS[number]

/** Durable `ui-skin` section. */
export interface UiSkinSettings {
  /** User accent, `#rrggbb`; empty defers to the skin's own accent. */
  accent: string
  /** Content address of the chosen wallpaper; empty means none. */
  wallpaper: string
  /** Wallpaper blur in px. */
  wallpaperBlur: number
  /** Pane and sidebar fill opacity while a backdrop paints behind the frame. */
  panelOpacity: number
  /** Composer fill opacity. */
  composerOpacity: number
  /** Popover fill opacity. */
  popoverOpacity: number
  /** Glass treatment. */
  material: SkinMaterial
}

/** Durable `ui-skin` schema; also the wire envelope the browser scope validates against. */
export const UiSkinSettingsSchema: z<UiSkinSettings> = z.object({
  accent: z.string().pattern(/^(?:#[0-9a-fA-F]{6})?$/).default(''),
  wallpaper: z.string().pattern(/^(?:[0-9a-f]{64})?$/).default(''),
  wallpaperBlur: z.number().step(1).min(0).max(40).default(0),
  panelOpacity: z.number().step(0.01).min(0.4).max(1).default(0.82),
  composerOpacity: z.number().step(0.01).min(0.4).max(1).default(0.9),
  popoverOpacity: z.number().step(0.01).min(0.6).max(1).default(0.96),
  material: z.union([...SKIN_MATERIALS]).default('off'),
})
