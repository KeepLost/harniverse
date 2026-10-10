/**
 * Host-rendered theme bootstrap for the browser's pre-plugin interval. Each
 * index response embeds the current durable preference and content font size;
 * the browser resolves `system` (and any registered theme id, which only its
 * owner can paint, so the interval shows the system palette), then writes the
 * same DOM fields ui-layout's ThemePresenter owns after the client plugin
 * tree activates.
 */

import { DEFAULT_CONTENT_FONT_SIZE, DEFAULT_PREFERENCE, type ThemePreference } from './theme-settings.ts'

/** Build the inline script for one schema-validated durable theme section. */
function bootThemeScript(preference: string, fontSize: number): string {
  return `<script>(() => {
  const preference = ${JSON.stringify(preference).replaceAll('<', '\\u003c')}
  const explicit = preference === 'light' || preference === 'dark'
  const systemDark = !explicit
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsw-content-font-size', ${JSON.stringify(`${fontSize}px`)})
})()</script>`
}

/**
 * Insert the theme bootstrap immediately after the opening body tag, before
 * the shell mount and module script. Body-less fragments receive it at the
 * end, where the HTML parser has already synthesized a body.
 * @param html - Raw application index HTML.
 * @param preference - Current Host-backed preference.
 * @param fontSize - Current Host-backed content font size in px.
 * @returns HTML containing the theme bootstrap.
 */
export function injectBootTheme(
  html: string,
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSize: number = DEFAULT_CONTENT_FONT_SIZE,
): string {
  const script = bootThemeScript(preference, fontSize)
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (body === null) return `${html}${script}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}
