/**
 * The published view of the skin runtime: one immutable snapshot the rows and
 * the backdrop read through a single `hooks` seat, plus the pure functions that
 * derive from it. Slices keep their identity until their content moves, so a
 * selector over one slice does not re-render on another's change.
 * @module @deepseek-ai/dsh-client-ui-skin/view
 */
import type {
  SkinBackground, SkinDefinition, SkinLibraryLimits, SkinPackRejection, WallpaperEntry,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import { skinThemeId } from './catalog.ts'
import { gradientCss } from './gradient.ts'
import { DEFAULT_SETTINGS, type SkinSettings } from './settings.ts'

/** Ceilings assumed until the first catalog answer reports the Host's own. */
export const DEFAULT_LIMITS: SkinLibraryLimits = Object.freeze({
  maxPackBytes: 256 * 1024,
  maxWallpaperBytes: 8 * 1024 * 1024,
  maxWallpapers: 24,
})

/** What the catalog (`skinLibrary.list`) last said. */
export interface LibraryView {
  /** `loading` until the first answer, `ready` after a success, `error` when the latest read failed (the last good lists stay). */
  status: 'loading' | 'ready' | 'error'
  /** Built-in skins first, then imported packs. */
  skins: readonly SkinDefinition[]
  /** Stored wallpapers, newest first. */
  wallpapers: readonly WallpaperEntry[]
  /** Pack files on disk that failed validation. */
  rejected: readonly SkinPackRejection[]
  /** Host ceilings. */
  limits: SkinLibraryLimits
}

/** Whether this browser can persist skin settings. */
export interface AccessView {
  /** The `ui-skin` scope's sync state. */
  status: 'loading' | 'ready' | 'unavailable'
  /** The Host document accepts writes. */
  writable: boolean
  /** A skin write was refused for lack of authority; latched until the plugin reloads. */
  denied: boolean
}

/** The live theme selection. */
export interface ThemeView {
  /** The persisted preference: `system`, `light`, `dark`, or `skin:<id>`. */
  preference: string
  /** The resolved active theme id (`system` resolved to `light` or `dark`). */
  activeId: string
}

/** Operating-system rendering preferences that override the user's translucency choices. */
export interface EnvironmentView {
  /** `prefers-reduced-transparency: reduce` matches. */
  reducedTransparency: boolean
  /** `prefers-contrast: more` matches. */
  highContrast: boolean
}

/** What paints behind the frame. */
export type BackdropView =
  | { kind: 'none' }
  | { kind: 'wallpaper'; hash: string; blur: number }
  | { kind: 'gradient'; background: SkinBackground }

/** The complete published snapshot. */
export interface SkinView {
  /** Active product language, for choosing a skin's display name. */
  locale: LocaleId
  library: LibraryView
  /** Normalised settings with unsaved edits applied. */
  settings: SkinSettings
  access: AccessView
  theme: ThemeView
  environment: EnvironmentView
  /** The effective backdrop; `none` whenever the environment forces opaque surfaces. */
  backdrop: BackdropView
}

/** The backdrop that paints nothing. */
export const NO_BACKDROP: BackdropView = Object.freeze({ kind: 'none' })

/** The view before any source has answered. */
export const INITIAL_VIEW: SkinView = Object.freeze({
  locale: 'zh',
  library: Object.freeze({
    status: 'loading',
    skins: Object.freeze([]),
    wallpapers: Object.freeze([]),
    rejected: Object.freeze([]),
    limits: DEFAULT_LIMITS,
  }),
  settings: DEFAULT_SETTINGS,
  access: Object.freeze({ status: 'loading', writable: false, denied: false }),
  theme: Object.freeze({ preference: 'system', activeId: 'light' }),
  environment: Object.freeze({ reducedTransparency: false, highContrast: false }),
  backdrop: NO_BACKDROP,
})

/**
 * Whether the controls that persist skin settings are usable.
 * @param access - the access slice.
 * @returns true when the scope is ready, writable, and no write was refused.
 */
export function canWrite(access: AccessView): boolean {
  return access.status === 'ready' && access.writable && !access.denied
}

/**
 * Whether the operating system asks for opaque, high-contrast rendering.
 * @param environment - the environment slice.
 * @returns true when translucency and glass must stay off.
 */
export function isForcedOpaque(environment: EnvironmentView): boolean {
  return environment.reducedTransparency || environment.highContrast
}

/**
 * The catalog skin behind the active theme.
 * @param library - the library slice.
 * @param activeId - resolved active theme id.
 * @returns the skin, or undefined for the built-in light/dark themes.
 */
export function activeSkinOf(library: LibraryView, activeId: string): SkinDefinition | undefined {
  return library.skins.find(skin => skinThemeId(skin.id) === activeId)
}

/** Everything the backdrop derives from. */
export interface BackdropInput {
  settings: SkinSettings
  library: LibraryView
  activeId: string
  environment: EnvironmentView
}

/**
 * Decide what paints behind the frame: the chosen wallpaper if the catalog
 * still holds it, otherwise the active skin's own gradient, otherwise nothing.
 * The operating system's reduced-transparency and high-contrast preferences
 * switch it off entirely, because the surfaces above would be opaque anyway.
 * @param input - settings, library, active theme, and environment.
 * @returns the effective backdrop.
 */
export function resolveBackdrop(input: BackdropInput): BackdropView {
  const { settings, library, environment } = input
  if (isForcedOpaque(environment)) return NO_BACKDROP
  if (settings.wallpaper !== '' && library.wallpapers.some(entry => entry.hash === settings.wallpaper)) {
    return { kind: 'wallpaper', hash: settings.wallpaper, blur: settings.wallpaperBlur }
  }
  const background = activeSkinOf(library, input.activeId)?.background
  if (background !== undefined && gradientCss(background) !== undefined) return { kind: 'gradient', background }
  return NO_BACKDROP
}
