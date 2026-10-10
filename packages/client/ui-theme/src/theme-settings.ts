/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Built-in preferences the product always offers; registered themes add more ids. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** One built-in preference. */
export type BuiltinThemePreference = typeof THEME_PREFERENCES[number]

/**
 * Persistable preference grammar: a built-in preference or a namespaced
 * registered theme id (`<namespace>:<name>`, for example `skin:abyss`).
 * Unnamespaced third-party ids stay session-only.
 */
export const THEME_PREFERENCE_PATTERN = /^(?:light|dark|system|[a-z][a-z0-9]*:[a-z0-9][a-z0-9-]{0,63})$/

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the conversation content font size. */
export const FONT_SIZE_FIELD = 'fontSize'

/**
 * Theme preference persisted in the user-settings document: a built-in
 * preference or the namespaced id of a registered theme. A stored id whose
 * theme is not registered renders as `system` and is kept, so the theme
 * resumes when its owner registers it again.
 */
export type ThemePreference = string

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: BuiltinThemePreference = 'system'

/** Content font-size tiers offered by the product font-size row (px). */
export const CONTENT_FONT_SIZES = [14, 16, 18] as const

/** Content font size persisted by the product font-size row (px). */
export type ContentFontSize = typeof CONTENT_FONT_SIZES[number]

/** Content font size when the user-settings document has no override (px). */
export const DEFAULT_CONTENT_FONT_SIZE: ContentFontSize = 16

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected preference ({@link THEME_PREFERENCE_PATTERN}). */
  preference: ThemePreference
  /** Conversation content font size in px (schema-bounded to {@link CONTENT_FONT_SIZES}). */
  fontSize: number
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.string().pattern(THEME_PREFERENCE_PATTERN).default(DEFAULT_PREFERENCE),
  [FONT_SIZE_FIELD]: z.number().step(2).min(14).max(18).default(DEFAULT_CONTENT_FONT_SIZE),
})

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value matches {@link THEME_PREFERENCE_PATTERN}.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCE_PATTERN.test(value)
}

/**
 * Narrow one wire or registry value to a font-size tier.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is one of the offered content font sizes.
 */
export function isContentFontSize(value: unknown): value is ContentFontSize {
  return CONTENT_FONT_SIZES.some(size => size === value)
}
