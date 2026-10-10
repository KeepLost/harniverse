/**
 * Skin plugin, browser half. Registers every catalog skin as a theme
 * (`skin:<id>`), keeps one token-override layer for the user's accent and the
 * translucent surfaces and glass materials over a backdrop, contributes the
 * shell backdrop, and registers the five Appearance rows — skin gallery,
 * accent, wallpaper, material, packs — over the typed `skinLibrary` Remote and
 * the `ui-skin` settings namespace. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.theme Context merge and the `settings.appearance.item` SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the `shell.backdrop` SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { AccentRow } from './AccentRow.tsx'
import { Backdrop } from './Backdrop.tsx'
import { SkinController, type SkinLibraryRemote } from './controller.ts'
import { downloadText } from './download.ts'
import { browserEnvironment } from './environment.ts'
import { readAsBase64, readAsText } from './files.ts'
import { en, NS, zh, type SkinKey } from './locales.ts'
import { MaterialRow } from './MaterialRow.tsx'
import { PacksRow } from './PacksRow.tsx'
import { SKIN_SETTINGS_NAMESPACE, type SkinSettings } from './settings.ts'
import { SkinGallery } from './SkinGallery.tsx'
import { WallpaperRow } from './WallpaperRow.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Appearance skin rows' copy. */
    'settings.skin': SkinKey
  }
}

export type { AccentRowInjected, AccentRowProps } from './AccentRow.tsx'
export type { BackdropInjected, BackdropProps } from './Backdrop.tsx'
export type { MaterialRowInjected, MaterialRowProps } from './MaterialRow.tsx'
export type { PacksRowInjected, PacksRowProps } from './PacksRow.tsx'
export type { SkinGalleryInjected, SkinGalleryProps } from './SkinGallery.tsx'
export type { WallpaperRowInjected, WallpaperRowProps } from './WallpaperRow.tsx'
export type { SkinHooks } from './faces.ts'
export type { OperationOutcome, PackOutcome, WallpaperOutcome } from './outcomes.ts'
export type { SkinKey } from './locales.ts'
export type { SkinMaterial, SkinSettings } from './settings.ts'
export type { AccessView, BackdropView, EnvironmentView, LibraryView, SkinView, ThemeView } from './view.ts'

/**
 * Required services: the slot registry and locale seat, the theme service the
 * skins register into, the Remote mount and its `skinLibrary` namespace (a host
 * without the library never activates this plugin), and the settings scope.
 */
export const inject = ['slots', 'locale', 'theme', 'remote', 'remote.skinLibrary', 'settingsScope']

/**
 * Client plugin body: mirror the catalog and settings into the theme service,
 * then register the backdrop and the Appearance rows.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skin: dictionaries')

  // Resolved by name so a stub composition providing the same service answers identically; typed
  // against the generated contract, so drift between the Host method set and SkinLibraryRemote fails here.
  const remote: SkinLibraryRemote = ctx.get('remote.skinLibrary') as ClientContext['remote']['skinLibrary']
  const controller = new SkinController({
    theme: ctx.theme,
    remote,
    scope: ctx.settingsScope.bind<SkinSettings>({ namespace: SKIN_SETTINGS_NAMESPACE }),
    locale: ctx.locale,
    environment: browserEnvironment(),
    urls: { create: blob => URL.createObjectURL(blob), revoke: (url) => { URL.revokeObjectURL(url) } },
    readBase64: readAsBase64,
    readText: readAsText,
    download: downloadText,
    warn: (message, error) => { console.warn(`[ui-skin] ${message}:`, error) },
  })
  ctx.effect(() => {
    const stops = [
      ctx.on('theme/change', () => { controller.sync() }),
      ctx.on('locale/change', () => { controller.sync() }),
      // A new connection generation may target another machine's library.
      ctx.on('connection/reset', () => { void controller.refresh() }),
    ]
    void controller.start()
    return () => {
      for (const stop of stops) stop()
      controller.dispose()
    }
  }, 'ui-skin: runtime')

  const hooks = { skin: controller.view }
  const wallpapers = { acquireWallpaper: controller.acquireWallpaper, releaseWallpaper: controller.releaseWallpaper }

  // The layer is contributed only while something paints behind the frame: an occupied slot mounts the
  // frame's backdrop wrapper, and a default skin must leave the frame's DOM exactly as it was.
  ctx.slots.inject('shell.backdrop', () => {
    let entry: (() => void) | undefined
    const sync = (): void => {
      const paints = controller.view.getSnapshot().backdrop.kind !== 'none'
      if (paints === (entry !== undefined)) return
      if (paints) {
        entry = ctx.slots.register({
          name: 'shell.backdrop',
          id: 'skin',
          order: 0,
          inject: () => ({ hooks, ...wallpapers }),
        }, Backdrop)
      } else {
        (entry as () => void)()
        entry = undefined
      }
    }
    const stop = controller.view.subscribe(sync)
    sync()
    return () => {
      stop()
      entry?.()
    }
  })

  // The five rows install and roll back together with the Appearance section's declaration.
  ctx.slots.inject('settings.appearance.item', function* () {
    yield ctx.slots.register({
      name: 'settings.appearance.item',
      id: 'skins',
      order: 30,
      locale: NS,
      inject: () => ({ hooks, setTheme: controller.setTheme, refresh: controller.refresh }),
    }, SkinGallery)
    yield ctx.slots.register({
      name: 'settings.appearance.item',
      id: 'accent',
      order: 40,
      locale: NS,
      inject: () => ({ hooks, setSetting: controller.setSetting }),
    }, AccentRow)
    yield ctx.slots.register({
      name: 'settings.appearance.item',
      id: 'wallpaper',
      order: 50,
      locale: NS,
      inject: () => ({
        hooks,
        setSetting: controller.setSetting,
        uploadWallpaper: controller.uploadWallpaper,
        removeWallpaper: controller.removeWallpaper,
        ...wallpapers,
      }),
    }, WallpaperRow)
    yield ctx.slots.register({
      name: 'settings.appearance.item',
      id: 'material',
      order: 60,
      locale: NS,
      inject: () => ({ hooks, setSetting: controller.setSetting }),
    }, MaterialRow)
    yield ctx.slots.register({
      name: 'settings.appearance.item',
      id: 'packs',
      order: 70,
      locale: NS,
      inject: () => ({
        hooks,
        importPack: controller.importPack,
        removePack: controller.removePack,
        exportActive: controller.exportActive,
      }),
    }, PacksRow)
  })
}
