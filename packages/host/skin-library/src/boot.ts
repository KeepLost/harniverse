/**
 * Browser bootstrap for the active skin. The `ui-theme.preference` setting
 * names a skin as `skin:<id>`; the index tap resolves it and embeds one inline
 * classic script that paints the skin's colour tokens before the client
 * plugins load and hands the written names to the client presenter. Everything else a skin does (accent override, wash,
 * wallpaper, material) is applied by the client after load.
 * @module @deepseek-ai/dsh-host-skin-library/boot
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SKIN_ID_PATTERN, SKINNABLE_TOKENS, isSkinColor } from './pack.ts'
import { SKIN_THEME_PREFIX, UI_THEME_NAMESPACE, UI_THEME_PREFERENCE_FIELD } from './settings.ts'
import type { SkinDefinition } from './types.ts'

const THEME_NAMESPACE = settingsNamespace(UI_THEME_NAMESPACE)

/**
 * Body attribute naming the inline variables the script wrote, so the client
 * theme presenter can retract them when the user leaves the skin (the
 * presenter owns the same literal in ui-layout).
 */
const BOOT_TOKENS_ATTRIBUTE = 'data-ds-boot-tokens'

/** Characters that could end a script element or a JS string early. */
const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g

/**
 * Read the stored theme preference from the Host settings service.
 * @param ctx - Host context that may carry the optional settings service.
 * @returns the raw preference value, or `undefined` without a settings service or theme section.
 */
export function readThemePreference(ctx: Context): unknown {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const section = settings.get(THEME_NAMESPACE)
  if (typeof section !== 'object' || section === null) return undefined
  return (section as Readonly<Record<string, unknown>>)[UI_THEME_PREFERENCE_FIELD]
}

/**
 * Extract the skin id from a theme preference.
 * @param preference - raw `ui-theme.preference` value.
 * @returns the id of a `skin:<id>` preference, or `undefined` for any other value.
 */
export function skinIdOfPreference(preference: unknown): string | undefined {
  if (typeof preference !== 'string' || !preference.startsWith(SKIN_THEME_PREFIX)) return undefined
  const id = preference.slice(SKIN_THEME_PREFIX.length)
  return SKIN_ID_PATTERN.test(id) ? id : undefined
}

/**
 * Serialize a value as JSON that is safe inside an inline script: `<`, `>`,
 * `&`, U+2028, and U+2029 become `\uXXXX` escapes, which JSON and JavaScript
 * both decode to the same character.
 * @param value - JSON-serializable value.
 * @returns the escaped JSON text.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(SCRIPT_UNSAFE, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The skin's tokens that are allowlisted and still pass the colour grammar, in allowlist order. */
function bootTokens(skin: SkinDefinition): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const name of SKINNABLE_TOKENS) {
    const value = skin.tokens[name]
    if (isSkinColor(value)) tokens[name] = value
  }
  return tokens
}

/** Build the inline bootstrap for one skin; the output depends only on the skin. */
function bootScript(skin: SkinDefinition): string {
  const payload = embedJson({ dark: skin.colorScheme === 'dark', tokens: bootTokens(skin) })
  return `<script>(() => {
  const skin = ${payload}
  document.documentElement.style.colorScheme = skin.dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', skin.dark)
  for (const [name, value] of Object.entries(skin.tokens)) document.body.style.setProperty(name, value)
  document.body.setAttribute(${embedJson(BOOT_TOKENS_ATTRIBUTE)}, Object.keys(skin.tokens).join(' '))
})()</script>`
}

/**
 * Insert the skin bootstrap immediately before the last closing body tag, so
 * it runs after the theme plugin's own bootstrap. Body-less fragments receive
 * it at the end, where the HTML parser has already synthesized a body. Token
 * values are re-validated here; one that fails the colour grammar is omitted.
 * @param html - Raw application index HTML.
 * @param skin - The skin the stored preference selects.
 * @returns HTML containing the skin bootstrap.
 */
export function injectBootSkin(html: string, skin: SkinDefinition): string {
  const script = bootScript(skin)
  let at = -1
  for (const match of html.matchAll(/<\/body\s*>/gi)) at = match.index
  return at === -1 ? `${html}${script}` : `${html.slice(0, at)}${script}${html.slice(at)}`
}
