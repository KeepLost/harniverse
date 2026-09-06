/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the conversation content font size. */
export const FONT_SIZE_FIELD = 'fontSize'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Content font-size tiers offered by the product font-size row (px). */
export const CONTENT_FONT_SIZES = [14, 16, 18] as const

/** Content font size persisted by the product font-size row (px). */
export type ContentFontSize = typeof CONTENT_FONT_SIZES[number]

/** Content font size when the user-settings document has no override (px). */
export const DEFAULT_CONTENT_FONT_SIZE: ContentFontSize = 16

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Conversation content font size in px (schema-bounded to {@link CONTENT_FONT_SIZES}). */
  fontSize: number
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [FONT_SIZE_FIELD]: z.number().step(2).min(14).max(18).default(DEFAULT_CONTENT_FONT_SIZE),
})

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}

/**
 * Narrow one wire or registry value to a font-size tier.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is one of the offered content font sizes.
 */
export function isContentFontSize(value: unknown): value is ContentFontSize {
  return CONTENT_FONT_SIZES.some(size => size === value)
}
