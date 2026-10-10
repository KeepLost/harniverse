/**
 * Wallpaper object URLs. A stored wallpaper is fetched as base64, turned into
 * a Blob, and exposed through an object URL that lives exactly as long as some
 * view holds it: references are counted per hash, the URL is revoked when the
 * last holder lets go (or when the cache is disposed), and a fetch that
 * completes after its last holder left never leaves a URL behind.
 * @module @deepseek-ai/dsh-client-ui-skin/wallpapers
 */
import type { WallpaperContent } from '@deepseek-ai/dsh-api-remotes/client'

/** The `readWallpaper` Remote call as the cache needs it. */
export type ReadWallpaper = (hash: string) => Promise<
  { readonly ok: true; readonly value: WallpaperContent | undefined } | { readonly ok: false }
>

/** Object-URL factory, injectable so specs observe the lifecycle. */
export interface ObjectUrls {
  create(blob: Blob): string
  revoke(url: string): void
}

interface Entry {
  refs: number
  url: Promise<string | undefined>
}

/** Decode standard base64 to bytes; undefined when the text is not base64. */
function decode(base64: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const binary = atob(base64)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    // The Host serves valid base64; a malformed answer is treated as a missing wallpaper.
    return undefined
  }
}

/** Reference-counted wallpaper object URLs. */
export class WallpaperUrlCache {
  private readonly entries = new Map<string, Entry>()
  private disposed = false

  /**
   * @param read - the Host read of one wallpaper's bytes.
   * @param urls - object-URL creation and revocation.
   */
  constructor(private readonly read: ReadWallpaper, private readonly urls: ObjectUrls) {}

  /**
   * Take a reference on a wallpaper and resolve its object URL.
   * @param hash - wallpaper content hash.
   * @returns the URL, or undefined when the wallpaper is missing, unreadable, or the cache is disposed.
   */
  acquire(hash: string): Promise<string | undefined> {
    if (this.disposed) return Promise.resolve(undefined)
    let entry = this.entries.get(hash)
    if (entry === undefined) {
      const created: Entry = { refs: 0, url: Promise.resolve(undefined) }
      created.url = this.load(hash, created)
      this.entries.set(hash, created)
      entry = created
    }
    entry.refs += 1
    return entry.url
  }

  /**
   * Drop one reference; the last one revokes the URL.
   * @param hash - wallpaper content hash passed to {@link acquire}.
   */
  release(hash: string): void {
    const entry = this.entries.get(hash)
    if (entry === undefined) return
    entry.refs -= 1
    if (entry.refs > 0) return
    this.entries.delete(hash)
    this.revokeWhenReady(entry)
  }

  /** Revoke every URL and refuse later acquisitions. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) this.revokeWhenReady(entry)
    this.entries.clear()
  }

  private revokeWhenReady(entry: Entry): void {
    void entry.url.then((url) => { if (url !== undefined) this.urls.revoke(url) })
  }

  private async load(hash: string, entry: Entry): Promise<string | undefined> {
    const result = await this.read(hash)
    // Nobody holds the wallpaper any more (or the cache closed): do not mint a URL nobody will revoke.
    if (this.entries.get(hash) !== entry) return undefined
    if (!result.ok || result.value === undefined) return undefined
    const bytes = decode(result.value.contentBase64)
    return bytes === undefined ? undefined : this.urls.create(new Blob([bytes], { type: result.value.mime }))
  }
}
