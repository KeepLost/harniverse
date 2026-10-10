/**
 * The skin runtime: the one apply-world object that mirrors every source the
 * skin surfaces depend on — the catalog, the `ui-skin` settings scope, the
 * theme service, the product language, and the operating-system rendering
 * preferences — into a single published view, keeps the registered skin themes
 * and the override layer consistent with it, and owns the verbs the rows call.
 * Components never see this class; they receive the view through a `hooks`
 * seat and the verbs as plain callbacks.
 * @module @deepseek-ai/dsh-client-ui-skin/controller
 */
import type {
  ImportPackResult, PutWallpaperResult, SkinLibrarySnapshot, WallpaperContent,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, shallowEqual, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { ThemeDefinition, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { SkinThemeRegistry, skinThemeId } from './catalog.ts'
import type { EnvironmentSource } from './environment.ts'
import { computeOverrides, OVERRIDE_SOURCE } from './overrides.ts'
import type { OperationOutcome, PackOutcome, WallpaperOutcome } from './outcomes.ts'
import { exportPack } from './pack.ts'
import { normalizeSettings, type SkinSettings } from './settings.ts'
import {
  activeSkinOf, canWrite, INITIAL_VIEW, resolveBackdrop, type LibraryView, type SkinView,
} from './view.ts'
import { WallpaperUrlCache, type ObjectUrls } from './wallpapers.ts'
import { SettingsWriter } from './writer.ts'

/** One Remote call's answer, as the generated `RemoteResult` shapes it. */
export type RemoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The `skinLibrary` Remote namespace as this package calls it. */
export interface SkinLibraryRemote {
  list(): Promise<RemoteOutcome<SkinLibrarySnapshot>>
  readWallpaper(hash: string): Promise<RemoteOutcome<WallpaperContent | undefined>>
  importPack(text: string): Promise<RemoteOutcome<ImportPackResult>>
  removePack(id: string): Promise<RemoteOutcome<boolean>>
  putWallpaper(contentBase64: string): Promise<RemoteOutcome<PutWallpaperResult>>
  removeWallpaper(hash: string): Promise<RemoteOutcome<boolean>>
}

/** The theme service as the runtime drives it. */
export interface ThemeFace {
  getTheme(): { readonly preference: string; readonly active: { readonly id: string } }
  setTheme(id: string): void
  register(definition: ThemeDefinition): () => void
  overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void
}

/** The locale service as the runtime reads it. */
export interface LocaleFace {
  getLocale(): { readonly active: LocaleId }
}

/** Everything the runtime reaches outside itself. */
export interface SkinDeps {
  theme: ThemeFace
  remote: SkinLibraryRemote
  /** The `ui-skin` settings scope. */
  scope: SettingsScope<SkinSettings>
  locale: LocaleFace
  environment: EnvironmentSource
  urls: ObjectUrls
  readBase64: (file: Blob) => Promise<string>
  readText: (file: Blob) => Promise<string>
  download: (fileName: string, text: string) => void
  /** Sink for failures the user does not need to see (a failed catalog read, an unregisterable skin). */
  warn: (message: string, error: unknown) => void
}

/** Remote failures that mean the principal lacks the required capability. */
const DENIED_CODES: ReadonlySet<string> = new Set(['forbidden', 'authorization-denied', 'unauthorized'])
const DENIED_MESSAGE = /lacks harniverse\./

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keep the previous slice object when the next one is shallow-equal, so selectors on it do not wake. */
function keep<T extends object>(previous: T, next: T): T {
  return shallowEqual(previous, next) ? previous : next
}

/** The skin runtime; see the module comment. */
export class SkinController {
  /** The published view (a bare observable the renderer binds to a selector hook). */
  readonly view: SnapshotStore<SkinView> = createSnapshotStore<SkinView>(INITIAL_VIEW)

  private library: LibraryView = INITIAL_VIEW.library
  private denied = false
  private disposed = false
  private generation = 0
  private appliedLayer = '{}'
  private disposeLayer: (() => void) | undefined
  private readonly stops: Array<() => void> = []
  private readonly registry: SkinThemeRegistry
  private readonly writer: SettingsWriter
  private readonly wallpapers: WallpaperUrlCache

  /**
   * @param deps - the services and browser capabilities the runtime reaches.
   */
  constructor(private readonly deps: SkinDeps) {
    this.registry = new SkinThemeRegistry(definition => deps.theme.register(definition), deps.warn)
    this.writer = new SettingsWriter(deps.scope, () => { this.sync() })
    this.wallpapers = new WallpaperUrlCache(hash => deps.remote.readWallpaper(hash), deps.urls)
  }

  /**
   * Begin mirroring: subscribe to the settings scope and the environment,
   * publish the first view, and read the catalog.
   * @returns settlement of the first catalog read.
   */
  start(): Promise<void> {
    this.stops.push(
      this.deps.scope.subscribe(() => { this.sync() }),
      this.deps.environment.subscribe(() => { this.sync() }),
    )
    this.sync()
    return this.refresh()
  }

  /** Stop mirroring and release everything the runtime registered or minted. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    for (const stop of this.stops.splice(0)) stop()
    this.writer.dispose()
    this.registry.dispose()
    this.disposeLayer?.()
    this.disposeLayer = undefined
    this.wallpapers.dispose()
  }

  /**
   * Recompute the published view from every source and bring the override
   * layer in line with it. Cheap when nothing moved: unchanged slices keep
   * their identity, an unchanged view is not republished, and an unchanged
   * layer is not re-applied (which is also what ends the echo of our own
   * `theme/change`).
   */
  sync(): void {
    if (this.disposed) return
    const previous = this.view.getSnapshot()
    const theme = this.deps.theme.getTheme()
    const scope = this.deps.scope.getSnapshot()
    const settings = keep(previous.settings, normalizeSettings({ ...scope.value, ...this.writer.overlay() }))
    const access = keep(previous.access, { status: scope.status, writable: scope.writable, denied: this.denied })
    const themeView = keep(previous.theme, { preference: theme.preference, activeId: theme.active.id })
    const environment = keep(previous.environment, this.deps.environment.snapshot())
    const backdrop = keep(previous.backdrop, resolveBackdrop({
      settings, library: this.library, activeId: themeView.activeId, environment,
    }))
    const next: SkinView = {
      locale: this.deps.locale.getLocale().active,
      library: this.library,
      settings,
      access,
      theme: themeView,
      environment,
      backdrop,
    }
    if (!shallowEqual(previous, next)) this.view.set(next)
    this.applyLayer(computeOverrides({ settings, backdropActive: backdrop.kind !== 'none' }))
  }

  /**
   * Re-read the catalog and re-register its skin themes. A newer read
   * supersedes an older one still in flight; a failed read keeps the last good
   * catalog and logs.
   * @returns settlement of this read.
   */
  readonly refresh = async (): Promise<void> => {
    const generation = ++this.generation
    const result = await this.deps.remote.list()
    if (generation !== this.generation) return
    if (!result.ok) {
      this.deps.warn('skin library could not be read', result.error)
      this.library = { ...this.library, status: 'error' }
    } else {
      const { skins, wallpapers, rejected, limits } = result.value
      this.library = { status: 'ready', skins, wallpapers, rejected, limits }
      this.registry.sync(skins)
    }
    this.sync()
  }

  /**
   * Select a theme (`system`, `light`, `dark`, or `skin:<id>`).
   * @param id - theme id or preference.
   */
  readonly setTheme = (id: string): void => {
    try {
      this.deps.theme.setTheme(id)
    } catch (error) {
      // The id is not registered (a skin that just left the catalog); the selection stays as it was.
      this.deps.warn(`theme "${id}" could not be selected`, error)
    }
  }

  /**
   * Edit one setting: the edit shows at once and is written once the input rests.
   * @param field - settings field.
   * @param value - its next value.
   */
  readonly setSetting = <F extends keyof SkinSettings>(field: F, value: SkinSettings[F]): void => {
    if (!canWrite(this.view.getSnapshot().access)) return
    this.writer.stage(field, value)
  }

  /**
   * Upload a wallpaper and select it.
   * @param file - the picked image.
   * @returns the outcome; `rejected` carries the Host's (or the local size) reason.
   */
  readonly uploadWallpaper = async (file: Blob): Promise<WallpaperOutcome> => {
    if (file.size > this.library.limits.maxWallpaperBytes) return { status: 'rejected', reason: 'too-large' }
    let content: string
    try {
      content = await this.deps.readBase64(file)
    } catch (error) {
      return { status: 'failed', message: messageOf(error) }
    }
    const result = await this.deps.remote.putWallpaper(content)
    if (!result.ok) return this.failed(result.error)
    if (result.value.status === 'rejected') return { status: 'rejected', reason: result.value.reason }
    const { hash } = result.value.wallpaper
    await this.refresh()
    this.setSetting('wallpaper', hash)
    return { status: 'ok', hash }
  }

  /**
   * Delete a stored wallpaper; clears the selection when it was the chosen one.
   * @param hash - wallpaper content hash.
   * @returns the outcome.
   */
  readonly removeWallpaper = async (hash: string): Promise<OperationOutcome> => {
    const result = await this.deps.remote.removeWallpaper(hash)
    if (!result.ok) return this.failed(result.error)
    if (this.view.getSnapshot().settings.wallpaper === hash) this.setSetting('wallpaper', '')
    await this.refresh()
    return { status: 'ok' }
  }

  /**
   * Import a skin pack file.
   * @param file - the picked `.json` pack.
   * @returns the outcome; `rejected` carries the Host's typed issues.
   */
  readonly importPack = async (file: Blob): Promise<PackOutcome> => {
    if (file.size > this.library.limits.maxPackBytes) return { status: 'too-large' }
    let text: string
    try {
      text = await this.deps.readText(file)
    } catch (error) {
      return { status: 'failed', message: messageOf(error) }
    }
    const result = await this.deps.remote.importPack(text)
    if (!result.ok) return this.failed(result.error)
    if (result.value.status === 'rejected') return { status: 'rejected', issues: result.value.issues }
    await this.refresh()
    return { status: result.value.status, skin: result.value.skin }
  }

  /**
   * Delete an imported pack; leaves the skin first when it was the selected theme.
   * @param id - catalog skin id.
   * @returns the outcome.
   */
  readonly removePack = async (id: string): Promise<OperationOutcome> => {
    const result = await this.deps.remote.removePack(id)
    if (!result.ok) return this.failed(result.error)
    // Explicit: the theme service keeps a preference whose theme is gone, so a deleted pack would otherwise stay selected.
    if (this.deps.theme.getTheme().preference === skinThemeId(id)) this.setTheme('system')
    await this.refresh()
    return { status: 'ok' }
  }

  /**
   * Download the active skin as a pack file.
   * @returns false when the active theme is not a catalog skin (nothing to export).
   */
  readonly exportActive = (): boolean => {
    const view = this.view.getSnapshot()
    const skin = activeSkinOf(view.library, view.theme.activeId)
    if (skin === undefined) return false
    const { fileName, text } = exportPack(skin)
    this.deps.download(fileName, text)
    return true
  }

  /**
   * Take a reference on a wallpaper's object URL.
   * @param hash - wallpaper content hash.
   * @returns the URL, or undefined when it cannot be shown.
   */
  readonly acquireWallpaper = (hash: string): Promise<string | undefined> => this.wallpapers.acquire(hash)

  /**
   * Drop a reference taken by {@link acquireWallpaper}.
   * @param hash - wallpaper content hash.
   */
  readonly releaseWallpaper = (hash: string): void => { this.wallpapers.release(hash) }

  /** Turn a failed Remote call into an outcome, latching a refusal for lack of authority. */
  private failed(error: { readonly code: string; readonly message: string }): { status: 'failed'; message: string } {
    if (DENIED_CODES.has(error.code) || DENIED_MESSAGE.test(error.message)) {
      this.denied = true
      this.sync()
    }
    return { status: 'failed', message: error.message }
  }

  /** Apply the override layer unless it is the one already applied. */
  private applyLayer(layer: ThemeTokenOverrides): void {
    const key = JSON.stringify(layer)
    if (key === this.appliedLayer) return
    // Recorded before the call: overrideTokens emits `theme/change` synchronously, which re-enters sync().
    this.appliedLayer = key
    if (Object.keys(layer).length === 0) {
      this.disposeLayer?.()
      this.disposeLayer = undefined
      return
    }
    this.disposeLayer = this.deps.theme.overrideTokens(OVERRIDE_SOURCE, layer)
  }
}
