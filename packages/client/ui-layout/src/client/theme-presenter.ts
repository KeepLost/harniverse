/**
 * Global theme DOM applier: projects the resolved ThemeSnapshot onto the
 * document — `html { color-scheme }` for native UA chrome (scrollbars, form
 * controls), `body[data-ds-dark-theme]` for the token palette, the active
 * theme's alias-token overrides as inline CSS variables on body, the content
 * font-size axis (`--dsw-content-font-size`; the stylesheet derives the px
 * delta), and one presenter-owned `meta[name="theme-color"]` for surrounding
 * browser UI. Pure DOM writes, no React involvement; the presenter only ever
 * retracts what it wrote itself (plus the token names a Host bootstrap handed
 * over through {@link BOOT_TOKENS_ATTRIBUTE}), so foreign attributes, metadata,
 * and inline styles survive.
 */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Body attribute selecting the dark base palette in the token stylesheets. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * Body attribute a Host bootstrap script sets to the space-separated names of
 * the inline variables it wrote before the plugins loaded. The presenter's
 * first apply adopts them into its retraction set and removes the attribute,
 * so a bootstrap token the next theme does not set does not outlive the switch.
 */
export const BOOT_TOKENS_ATTRIBUTE = 'data-ds-boot-tokens'

/** Body variable carrying the user's content font size in px. */
export const CONTENT_FONT_SIZE_VARIABLE = '--dsw-content-font-size'

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  /** Token names this presenter wrote in the last apply (its retraction set). */
  private appliedTokens: string[] = []
  /** The single metadata node this presenter inserts and removes. */
  private readonly themeColorMeta: HTMLMetaElement

  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
  }

  /**
   * Project a snapshot onto the document: set root `color-scheme` and the body
   * palette attribute from `active.colorScheme` (never the id — `system` is
   * resolved upstream), publish the content font-size axis, then replace the
   * previously applied token variables with `active.tokens`. A `pending`
   * snapshot leaves the palette untouched while a bootstrap paint
   * ({@link BOOT_TOKENS_ATTRIBUTE}) stands, so the preferred theme stays on
   * screen until it registers. Browser theme-color metadata follows the
   * computed body background after those writes, so the rendered palette
   * remains the color authority.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot: ThemeSnapshot): void {
    const body = document.body
    body.style.setProperty(CONTENT_FONT_SIZE_VARIABLE, `${snapshot.fontSize}px`)
    if (snapshot.pending === true && body.hasAttribute(BOOT_TOKENS_ATTRIBUTE)) {
      this.publishThemeColor(body)
      return
    }
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    this.adoptBootTokens(body)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.publishThemeColor(body)
  }

  /** Point the owned theme-color metadata at the rendered body background. */
  private publishThemeColor(body: HTMLElement): void {
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  /** Take over the variables a Host bootstrap wrote, once, so they retract like the presenter's own. */
  private adoptBootTokens(body: HTMLElement): void {
    const handed = body.getAttribute(BOOT_TOKENS_ATTRIBUTE)
    if (handed === null) return
    body.removeAttribute(BOOT_TOKENS_ATTRIBUTE)
    for (const name of handed.split(' ')) {
      if (name.startsWith('--') && !this.appliedTokens.includes(name)) this.appliedTokens.push(name)
    }
  }

  /** Retract root color-scheme, the palette attribute, token variables, the font-size axis, and the owned metadata node. */
  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    body.style.removeProperty(CONTENT_FONT_SIZE_VARIABLE)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    this.themeColorMeta.remove()
  }
}
