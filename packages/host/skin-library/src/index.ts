/**
 * The skin library Remote: the catalog of built-in skins and imported skin
 * packs, the content-addressed wallpaper store, the `ui-skin` settings
 * section, and the pre-plugin skin bootstrap. Every call runs on the machine
 * the client targets, so a remote host serves its own library.
 *
 * @module @deepseek-ai/dsh-host-skin-library
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { injectBootSkin, readThemePreference, skinIdOfPreference } from './boot.ts'
import { BUILTIN_SKINS, builtinSkin } from './palette.ts'
import { MAX_PACK_BYTES, parseSkinPack } from './pack.ts'
import { UI_SKIN_NAMESPACE, UiSkinSettingsSchema } from './settings.ts'
import { SkinStore } from './store.ts'
import type {
  ImportPackResult, PutWallpaperResult, SkinDefinition, SkinLibraryLimits, SkinLibrarySnapshot, WallpaperContent,
} from './types.ts'
import { MAX_WALLPAPERS, MAX_WALLPAPER_BYTES, decodeWallpaper } from './wallpaper.ts'

export type * from './types.ts'

/** Plugin configuration. */
export interface Config {
  /** Absolute library directory holding `packs/` and `wallpapers/`; created on first write. */
  dir: string
}

const SKIN_SETTINGS_NAMESPACE = settingsNamespace(UI_SKIN_NAMESPACE)

const LIMITS: SkinLibraryLimits = {
  maxPackBytes: MAX_PACK_BYTES,
  maxWallpaperBytes: MAX_WALLPAPER_BYTES,
  maxWallpapers: MAX_WALLPAPERS,
}

/** Remote-only service holding the skin catalog and wallpapers on the serving machine. */
export class SkinLibrary extends TypertRemoteService {
  static Config: z<Config> = z.object({
    dir: z.string().required(),
  })

  private readonly store: SkinStore

  constructor(ctx: Context, config: Config) {
    super(ctx, 'skinLibrary')
    if (!isAbsolute(config.dir)) {
      throw new TypeError(`skin-library dir must be absolute, got ${JSON.stringify(config.dir)}`)
    }
    this.store = new SkinStore(config.dir)
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(SKIN_SETTINGS_NAMESPACE, UiSkinSettingsSchema)
    })
    ctx.inject(['webServer'], (httpCtx) => {
      httpCtx.effect(
        () => httpCtx.webServer.tapIndex(html => this.bootstrap(html)),
        'skin-library: initial skin bootstrap',
      )
    })
  }

  /** Embed the active skin's colour tokens when the stored theme preference names a resolvable skin. */
  private bootstrap(html: string): string {
    const id = skinIdOfPreference(readThemePreference(this.ctx))
    if (id === undefined) return html
    const skin: SkinDefinition | undefined = builtinSkin(id) ?? this.store.readPackSync(id)
    return skin === undefined ? html : injectBootSkin(html, skin)
  }

  /**
   * Read the catalog. Packs are scanned from disk on every call, so a pack
   * file dropped into the library by hand appears without a restart and an
   * invalid one is reported in `rejected`.
   * @returns built-in skins, imported packs, wallpapers, rejected pack files, and the limits.
   */
  @Remote({ exportName: 'list', requiredCapability: 'harniverse.observe' })
  async list(): Promise<SkinLibrarySnapshot> {
    const [packs, wallpapers] = await Promise.all([this.store.listPacks(), this.store.listWallpapers()])
    return { skins: [...BUILTIN_SKINS, ...packs.skins], wallpapers, rejected: packs.rejected, limits: LIMITS }
  }

  /**
   * Read one stored wallpaper.
   * @param hash - the wallpaper's content address (lowercase hex SHA-256).
   * @returns its kind and base64 bytes, or `undefined` when none intact is stored under `hash`.
   */
  @Remote({ exportName: 'readWallpaper', requiredCapability: 'harniverse.observe' })
  async readWallpaper(hash: string): Promise<WallpaperContent | undefined> {
    return await this.store.readWallpaper(hash)
  }

  /**
   * Validate and store a skin pack, replacing the pack that holds the same id.
   * @param text - the pack document: native `harniverse.skin` v1 or dsh-dream-skin v1.
   * @returns `imported`/`replaced` with the normalized skin, or `rejected` with the reasons.
   */
  @Remote({ exportName: 'importPack', requiredCapability: 'harniverse.administer' })
  async importPack(text: string): Promise<ImportPackResult> {
    const parsed = parseSkinPack(text)
    if (!parsed.ok) return { status: 'rejected', issues: parsed.issues }
    return { status: await this.store.putPack(parsed.skin), skin: parsed.skin }
  }

  /**
   * Delete an imported pack. Built-in skins cannot be removed.
   * @param id - the skin id.
   * @returns whether a pack file was removed.
   */
  @Remote({ exportName: 'removePack', requiredCapability: 'harniverse.administer' })
  async removePack(id: string): Promise<boolean> {
    return await this.store.removePack(id)
  }

  /**
   * Store a wallpaper under its content address. The type is decided from the
   * file signature (PNG, JPEG, or WebP), not from anything the caller declares.
   * @param contentBase64 - the image, canonical padded base64.
   * @returns `stored`, `existing` for identical bytes, or `rejected` with the reason.
   */
  @Remote({ exportName: 'putWallpaper', requiredCapability: 'harniverse.administer' })
  async putWallpaper(contentBase64: string): Promise<PutWallpaperResult> {
    const decoded = decodeWallpaper(contentBase64)
    if (!decoded.ok) return { status: 'rejected', reason: decoded.reason }
    return await this.store.putWallpaper(decoded.bytes, decoded.mime)
  }

  /**
   * Delete a stored wallpaper. A `ui-skin.wallpaper` setting that names it is
   * left as is; the client renders no wallpaper when `readWallpaper` finds none.
   * @param hash - the wallpaper's content address.
   * @returns whether a file was removed.
   */
  @Remote({ exportName: 'removeWallpaper', requiredCapability: 'harniverse.administer' })
  async removeWallpaper(hash: string): Promise<boolean> {
    return await this.store.removeWallpaper(hash)
  }
}

export default SkinLibrary
