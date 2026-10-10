/**
 * Skins as themes. Every catalog skin becomes one `ThemeDefinition` with id
 * `skin:<id>`; the registry keeps that set equal to the catalog as the list
 * changes, touching only the themes whose definition actually moved so an
 * unchanged skin (and the active preference naming it) is never torn down.
 * @module @deepseek-ai/dsh-client-ui-skin/catalog
 */
import type { SkinDefinition } from '@deepseek-ai/dsh-api-remotes/client'
import type { ThemeDefinition, ThemeTokens } from '@deepseek-ai/dsh-client-ui-theme/client'
import { accentHover, accentSoft, isSafeColor } from './color.ts'
import { isHexColor } from './settings.ts'

/** Theme-id prefix of every catalog skin. */
export const SKIN_THEME_PREFIX = 'skin:'

/**
 * The theme id a catalog skin registers under.
 * @param skinId - catalog skin id.
 * @returns `skin:<id>`.
 */
export function skinThemeId(skinId: string): string {
  return `${SKIN_THEME_PREFIX}${skinId}`
}

/**
 * A skin's display name in the active product language.
 * @param skin - the catalog skin.
 * @param locale - active locale id.
 * @returns the English name for `en`, the Chinese name otherwise.
 */
export function skinDisplayName(skin: SkinDefinition, locale: string): string {
  return locale === 'en' ? skin.name.en : skin.name.zh
}

/** Token names a skin may set: design-system custom properties only. */
const TOKEN_NAME = /^--dsw-[a-z0-9-]+$/

/**
 * Theme tokens for a skin: its own tokens, plus the accent family completed
 * from the skin's accent. The Host validates packs, but a remote machine's
 * library is only as trusted as that machine, so every entry is re-checked here
 * (a `--dsw-*` name, a value from the colour grammar) before it can reach the
 * document; an entry that fails is left out. A pack may name only `--dsw-accent`;
 * hover and soft then follow it instead of keeping the product blue.
 * @param skin - the catalog skin.
 * @returns the token dictionary.
 */
export function skinTokens(skin: SkinDefinition): ThemeTokens {
  const tokens: Record<string, string> = {}
  for (const [name, value] of Object.entries(skin.tokens)) {
    if (TOKEN_NAME.test(name) && isSafeColor(value)) tokens[name] = value
  }
  const accent = tokens['--dsw-accent'] ?? skin.accent
  if (isHexColor(accent)) {
    tokens['--dsw-accent'] ??= accent
    tokens['--dsw-accent-hover'] ??= accentHover(accent, skin.colorScheme)
    tokens['--dsw-accent-soft'] ??= accentSoft(accent)
  }
  return tokens
}

/**
 * The theme definition of a skin.
 * @param skin - the catalog skin.
 * @returns the definition registered with the theme service.
 */
export function skinDefinition(skin: SkinDefinition): ThemeDefinition {
  return { id: skinThemeId(skin.id), colorScheme: skin.colorScheme, tokens: skinTokens(skin) }
}

function signatureOf(definition: ThemeDefinition): string {
  return JSON.stringify([definition.colorScheme, definition.tokens])
}

/** Registers and retires skin themes so the registered set mirrors the catalog. */
export class SkinThemeRegistry {
  private readonly live = new Map<string, { signature: string; dispose: () => void }>()

  /**
   * @param register - the theme service's `register`; throws for a duplicate or reserved id.
   * @param report - sink for a skin that could not be registered.
   */
  constructor(
    private readonly register: (definition: ThemeDefinition) => () => void,
    private readonly report: (message: string, error: unknown) => void,
  ) {}

  /**
   * Bring the registered skin themes in line with a catalog.
   * @param skins - the catalog's skins.
   */
  sync(skins: readonly SkinDefinition[]): void {
    const wanted = new Map(skins.map(skin => [skinThemeId(skin.id), skinDefinition(skin)]))
    for (const [id, entry] of this.live) {
      const next = wanted.get(id)
      if (next !== undefined && signatureOf(next) === entry.signature) continue
      entry.dispose()
      this.live.delete(id)
    }
    for (const [id, definition] of wanted) {
      if (this.live.has(id)) continue
      try {
        this.live.set(id, { signature: signatureOf(definition), dispose: this.register(definition) })
      } catch (error) {
        // A duplicate or reserved id is another plugin's occupant; the skin stays out of the registry.
        this.report(`skin theme "${id}" was not registered`, error)
      }
    }
  }

  /** Retire every skin theme this registry registered. */
  dispose(): void {
    for (const entry of this.live.values()) entry.dispose()
    this.live.clear()
  }
}
