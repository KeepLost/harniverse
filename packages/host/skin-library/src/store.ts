/**
 * Filesystem-backed skin library under one directory:
 *
 * ```
 * <dir>/packs/<id>.json            one native pack per imported skin
 * <dir>/wallpapers/<sha256>.<ext>  one content-addressed image per wallpaper
 * ```
 *
 * Directories are created `0o700` and files `0o600`. Every write goes to a
 * sibling temp file and is renamed over its target, so readers see the old or
 * the new content in full. Mutations run one at a time, so the wallpaper cap
 * is checked and enforced atomically. Listing scans the directories, so a
 * pack file dropped in by hand is picked up and an invalid one is reported
 * instead of failing the scan.
 * @module @deepseek-ai/dsh-host-skin-library/store
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MAX_PACK_BYTES, SKIN_ID_PATTERN, parseSkinPack, serializeSkinPack } from './pack.ts'
import type {
  PutWallpaperResult, SkinDefinition, SkinPackRejection, WallpaperContent, WallpaperEntry, WallpaperMime,
} from './types.ts'
import {
  MAX_WALLPAPERS, MAX_WALLPAPER_BYTES, WALLPAPER_EXTENSIONS, WALLPAPER_HASH_PATTERN, WALLPAPER_MIMES,
  parseWallpaperFileName, sniffWallpaperMime, wallpaperHash,
} from './wallpaper.ts'

/** Imported packs found on disk and the files that were not offered. */
interface StoredPacks {
  /** Valid packs ordered by English name, then id. */
  readonly skins: readonly SkinDefinition[]
  /** Pack files that failed validation, ordered by file name. */
  readonly rejected: readonly SkinPackRejection[]
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Rejection handler: a missing path resolves to `fallback`, any other failure propagates. */
function whenMissing<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (errorCode(error) === 'ENOENT') return fallback
    throw error
  }
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, whenMissing(false))

const removeFile = (path: string): Promise<boolean> => unlink(path).then(() => true, whenMissing(false))

/**
 * Read a file through one open handle, so the size check and the read see the same inode.
 * @returns the bytes, `'too-large'` past `limit`, or `undefined` when the file does not exist.
 */
async function readBounded(path: string, limit: number): Promise<Buffer | 'too-large' | undefined> {
  const handle = await open(path, 'r').catch(whenMissing(undefined))
  if (handle === undefined) return undefined
  try {
    return (await handle.stat()).size > limit ? 'too-large' : await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** Read a small file synchronously for the index tap; `undefined` when absent, unreadable, or past `limit`. */
function readSmallFileSync(path: string, limit: number): string | undefined {
  try {
    return statSync(path).size > limit ? undefined : readFileSync(path, 'utf8')
  } catch {
    // Missing or unreadable pack: the browser boots with its default theme instead.
    return undefined
  }
}

/** Write `data` to a private sibling temp file, then rename it over `path`. */
async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temp = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** The skin library's persistent state. */
export class SkinStore {
  private readonly packsDirectory: string
  private readonly wallpapersDirectory: string
  /** Settles when the last queued mutation has; never rejects. */
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * @param directory - absolute library root; created on first write.
   */
  constructor(directory: string) {
    this.packsDirectory = join(directory, 'packs')
    this.wallpapersDirectory = join(directory, 'wallpapers')
  }

  /** Run `task` after every earlier mutation; its failure reaches only its own caller. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task)
    this.tail = run.then(undefined, () => undefined)
    return run
  }

  private packPath(id: string): string {
    return join(this.packsDirectory, `${id}.json`)
  }

  private wallpaperPath(hash: string, mime: WallpaperMime): string {
    return join(this.wallpapersDirectory, `${hash}.${WALLPAPER_EXTENSIONS[mime]}`)
  }

  /**
   * Scan the packs directory. A file is offered when its name is `<id>.json`
   * and its content validates as a pack with that id; any other `.json` file
   * is reported with the reason it was not.
   * @returns the valid packs and the rejected files.
   */
  async listPacks(): Promise<StoredPacks> {
    const skins: SkinDefinition[] = []
    const rejected: SkinPackRejection[] = []
    const entries = await readdir(this.packsDirectory, { withFileTypes: true }).catch(whenMissing([]))
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = entry.name
      try {
        const path = join(this.packsDirectory, file)
        const { size } = await stat(path)
        if (size > MAX_PACK_BYTES) {
          rejected.push({ file, message: `the pack is ${size} bytes; the limit is ${MAX_PACK_BYTES} bytes` })
          continue
        }
        const parsed = parseSkinPack(await readFile(path, 'utf8'))
        if (!parsed.ok) rejected.push({ file, message: parsed.issues.join('; ') })
        else if (file !== `${parsed.skin.id}.json`) rejected.push({ file, message: `the file name must be ${parsed.skin.id}.json to match the pack id` })
        else skins.push(parsed.skin)
      } catch (error) {
        rejected.push({ file, message: `the pack could not be read: ${errorMessage(error)}` })
      }
    }
    skins.sort((a, b) => a.name.en.localeCompare(b.name.en) || a.id.localeCompare(b.id))
    rejected.sort((a, b) => a.file.localeCompare(b.file))
    return { skins, rejected }
  }

  /**
   * Read one imported pack synchronously, for the index tap.
   * @param id - candidate skin id.
   * @returns the pack, or `undefined` when none valid is stored under `id`.
   */
  readPackSync(id: string): SkinDefinition | undefined {
    if (!SKIN_ID_PATTERN.test(id)) return undefined
    const text = readSmallFileSync(this.packPath(id), MAX_PACK_BYTES)
    if (text === undefined) return undefined
    const parsed = parseSkinPack(text)
    return parsed.ok && parsed.skin.id === id ? parsed.skin : undefined
  }

  /**
   * Store a validated pack as `packs/<id>.json`, replacing any file there.
   * @param skin - a skin that `parseSkinPack` produced.
   * @returns whether the id was new or replaced an existing file.
   */
  putPack(skin: SkinDefinition): Promise<'imported' | 'replaced'> {
    return this.serial(async () => {
      const path = this.packPath(skin.id)
      const replaced = await exists(path)
      await writeAtomic(path, serializeSkinPack(skin))
      return replaced ? 'replaced' : 'imported'
    })
  }

  /**
   * Delete one imported pack.
   * @param id - the skin id.
   * @returns whether a pack file was removed.
   */
  removePack(id: string): Promise<boolean> {
    if (!SKIN_ID_PATTERN.test(id)) return Promise.resolve(false)
    return this.serial(() => removeFile(this.packPath(id)))
  }

  /**
   * Scan the wallpapers directory for `<sha256>.<png|jpg|webp>` files.
   * @returns the stored wallpapers, newest first (by file mtime).
   */
  async listWallpapers(): Promise<WallpaperEntry[]> {
    const wallpapers: WallpaperEntry[] = []
    const entries = await readdir(this.wallpapersDirectory, { withFileTypes: true }).catch(whenMissing([]))
    for (const entry of entries) {
      const name = parseWallpaperFileName(entry.name)
      if (name === undefined || !entry.isFile()) continue
      const info = await stat(join(this.wallpapersDirectory, entry.name))
      if (info.size > MAX_WALLPAPER_BYTES) continue
      wallpapers.push({ hash: name.hash, mime: name.mime, bytes: info.size, addedAt: Math.floor(info.mtimeMs) })
    }
    return wallpapers.sort((a, b) => b.addedAt - a.addedAt || a.hash.localeCompare(b.hash))
  }

  /**
   * Store one vetted wallpaper under its content address.
   * @param bytes - the decoded image.
   * @param mime - the kind decided from its signature.
   * @returns `existing` when identical bytes were stored before, `limit-reached` at the cap, otherwise `stored`.
   */
  putWallpaper(bytes: Buffer, mime: WallpaperMime): Promise<PutWallpaperResult> {
    return this.serial<PutWallpaperResult>(async () => {
      const hash = wallpaperHash(bytes)
      const stored = await this.listWallpapers()
      const existing = stored.find(entry => entry.hash === hash)
      if (existing !== undefined) return { status: 'existing', wallpaper: existing }
      if (stored.length >= MAX_WALLPAPERS) return { status: 'rejected', reason: 'limit-reached' }
      const path = this.wallpaperPath(hash, mime)
      await writeAtomic(path, bytes)
      const info = await stat(path)
      return { status: 'stored', wallpaper: { hash, mime, bytes: bytes.length, addedAt: Math.floor(info.mtimeMs) } }
    })
  }

  /**
   * Read one stored wallpaper, verifying that its bytes still hash to the
   * requested address and still carry the signature of the stored kind.
   * @param hash - the content address.
   * @returns the bytes, or `undefined` when none intact is stored under `hash`.
   */
  async readWallpaper(hash: string): Promise<WallpaperContent | undefined> {
    if (!WALLPAPER_HASH_PATTERN.test(hash)) return undefined
    for (const mime of WALLPAPER_MIMES) {
      const bytes = await readBounded(this.wallpaperPath(hash, mime), MAX_WALLPAPER_BYTES)
      if (bytes === undefined) continue
      if (bytes === 'too-large') return undefined
      const intact = wallpaperHash(bytes) === hash && sniffWallpaperMime(bytes) === mime
      return intact ? { mime, contentBase64: bytes.toString('base64') } : undefined
    }
    return undefined
  }

  /**
   * Delete one stored wallpaper.
   * @param hash - the content address.
   * @returns whether a file was removed.
   */
  removeWallpaper(hash: string): Promise<boolean> {
    if (!WALLPAPER_HASH_PATTERN.test(hash)) return Promise.resolve(false)
    return this.serial(async () => {
      let removed = false
      for (const mime of WALLPAPER_MIMES) removed = await removeFile(this.wallpaperPath(hash, mime)) || removed
      return removed
    })
  }
}
