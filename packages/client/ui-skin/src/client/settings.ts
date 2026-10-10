/**
 * The `ui-skin` settings namespace as the browser sees it. The Host owns the
 * schema (packages/host/skin-library); a client package may not value-import a
 * host package, so the field names, ranges, and defaults are mirrored here and
 * every value read from the document passes {@link normalizeSettings} before
 * the rest of the package trusts it.
 * @module @deepseek-ai/dsh-client-ui-skin/settings
 */

/** Settings namespace owned by the skin library on the Host. */
export const SKIN_SETTINGS_NAMESPACE = 'ui-skin'

/** Backdrop materials a user can pick. */
export const MATERIALS = ['off', 'frosted', 'liquid'] as const

/** One backdrop material: no glass effect, light blur, or heavy blur with a brightness lift. */
export type SkinMaterial = typeof MATERIALS[number]

/** Durable skin preferences, field-for-field with the Host `ui-skin` section. */
export interface SkinSettings {
  /** User accent as `#rrggbb`; empty means the active theme's own accent. */
  accent: string
  /** Lowercase hex SHA-256 of the chosen wallpaper; empty means none. */
  wallpaper: string
  /** Wallpaper blur radius in px. */
  wallpaperBlur: number
  /** Pane and sidebar fill opacity while a backdrop shows (0..1). */
  panelOpacity: number
  /** Composer card fill opacity while a backdrop shows (0..1). */
  composerOpacity: number
  /** Menu and popover fill opacity while a backdrop shows (0..1). */
  popoverOpacity: number
  /** Glass material over the backdrop. */
  material: SkinMaterial
}

/** Inclusive numeric bounds of one numeric field. */
export interface NumericRange {
  min: number
  max: number
}

/** Bounds of every numeric field, matching the Host schema. */
export const RANGES = {
  wallpaperBlur: { min: 0, max: 40 },
  panelOpacity: { min: 0.4, max: 1 },
  composerOpacity: { min: 0.4, max: 1 },
  popoverOpacity: { min: 0.6, max: 1 },
} as const satisfies Record<string, NumericRange>

/** Settings when the document carries no override. */
export const DEFAULT_SETTINGS: SkinSettings = Object.freeze({
  accent: '',
  wallpaper: '',
  wallpaperBlur: 0,
  panelOpacity: 0.82,
  composerOpacity: 0.9,
  popoverOpacity: 0.96,
  material: 'off',
})

const HEX_COLOR = /^#[0-9a-f]{6}$/
const WALLPAPER_HASH = /^[0-9a-f]{64}$/

/**
 * Whether a value is a lowercase `#rrggbb` colour (the only accent grammar).
 * @param value - candidate value.
 * @returns true for a six-digit lowercase hex colour.
 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

/**
 * Whether a value is a wallpaper content hash (64 lowercase hex digits).
 * @param value - candidate value.
 * @returns true for a SHA-256 hex digest.
 */
export function isWallpaperHash(value: unknown): value is string {
  return typeof value === 'string' && WALLPAPER_HASH.test(value)
}

/** One numeric field clamped into its range; a non-number falls back to the default. */
function clampField(value: unknown, range: NumericRange, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, value))
}

/**
 * Turn whatever the settings scope delivered into a complete, in-range section.
 * An invalid field falls back to its default and an out-of-range number is
 * clamped, so the override layer never emits a value the Host would refuse.
 * @param raw - the scope's accepted section, or undefined before the first Host view.
 * @returns a complete settings object.
 */
export function normalizeSettings(raw: Partial<Record<keyof SkinSettings, unknown>> | undefined): SkinSettings {
  const source = raw ?? {}
  return {
    accent: isHexColor(source.accent) ? source.accent : DEFAULT_SETTINGS.accent,
    wallpaper: isWallpaperHash(source.wallpaper) ? source.wallpaper : DEFAULT_SETTINGS.wallpaper,
    wallpaperBlur: Math.round(clampField(source.wallpaperBlur, RANGES.wallpaperBlur, DEFAULT_SETTINGS.wallpaperBlur)),
    panelOpacity: clampField(source.panelOpacity, RANGES.panelOpacity, DEFAULT_SETTINGS.panelOpacity),
    composerOpacity: clampField(source.composerOpacity, RANGES.composerOpacity, DEFAULT_SETTINGS.composerOpacity),
    popoverOpacity: clampField(source.popoverOpacity, RANGES.popoverOpacity, DEFAULT_SETTINGS.popoverOpacity),
    material: MATERIALS.find(material => material === source.material) ?? DEFAULT_SETTINGS.material,
  }
}

/**
 * The write verb the rows receive: stage one field's next value.
 * @param field - settings field.
 * @param value - its next value.
 */
export type SetSetting = <F extends keyof SkinSettings>(field: F, value: SkinSettings[F]) => void
