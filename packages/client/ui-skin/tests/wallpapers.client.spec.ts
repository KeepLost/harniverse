import { describe, expect, it, vi } from 'vitest'
import type { WallpaperContent } from '@deepseek-ai/dsh-api-remotes/client'
import { WallpaperUrlCache, type ReadWallpaper } from '../src/client/wallpapers.ts'

const PNG: WallpaperContent = { mime: 'image/png', contentBase64: btoa('\u0089PNG') }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function bench(read: ReadWallpaper) {
  let counter = 0
  const created: Blob[] = []
  const urls = {
    create: vi.fn((blob: Blob) => {
      created.push(blob)
      counter += 1
      return `blob:wallpaper-${String(counter)}`
    }),
    revoke: vi.fn(),
  }
  return { cache: new WallpaperUrlCache(read, urls), urls, created }
}

const found: ReadWallpaper = () => Promise.resolve({ ok: true, value: PNG })

describe('WallpaperUrlCache', () => {
  it('turns the stored bytes into one typed object URL shared by every holder', async () => {
    const read = vi.fn(found)
    const b = bench(read)
    const [first, second] = await Promise.all([b.cache.acquire('h'), b.cache.acquire('h')])
    expect(first).toBe('blob:wallpaper-1')
    expect(second).toBe(first)
    expect(read).toHaveBeenCalledOnce()
    expect(b.created[0]?.type).toBe('image/png')
    expect(b.created[0]?.size).toBe(4)
  })

  it('revokes only when the last holder releases', async () => {
    const b = bench(found)
    await b.cache.acquire('h')
    await b.cache.acquire('h')
    b.cache.release('h')
    await Promise.resolve()
    expect(b.urls.revoke).not.toHaveBeenCalled()
    b.cache.release('h')
    await vi.waitFor(() => { expect(b.urls.revoke).toHaveBeenCalledExactlyOnceWith('blob:wallpaper-1') })
    b.cache.release('h')
    b.cache.release('never-acquired')
    expect(b.urls.revoke).toHaveBeenCalledOnce()
  })

  it('mints a fresh URL when a wallpaper is acquired again after its holders left', async () => {
    const b = bench(found)
    await b.cache.acquire('h')
    b.cache.release('h')
    expect(await b.cache.acquire('h')).toBe('blob:wallpaper-2')
  })

  it('answers undefined for a missing, refused, or malformed wallpaper', async () => {
    expect(await bench(() => Promise.resolve({ ok: true, value: undefined })).cache.acquire('h')).toBeUndefined()
    expect(await bench(() => Promise.resolve({ ok: false })).cache.acquire('h')).toBeUndefined()
    const malformed = bench(() => Promise.resolve({ ok: true, value: { mime: 'image/png', contentBase64: '!!!' } }))
    expect(await malformed.cache.acquire('h')).toBeUndefined()
    expect(malformed.urls.create).not.toHaveBeenCalled()
    // Releasing an entry that holds no URL revokes nothing.
    malformed.cache.release('h')
    await Promise.resolve()
    expect(malformed.urls.revoke).not.toHaveBeenCalled()
  })

  it('never mints a URL for a fetch whose last holder already left', async () => {
    const pending = deferred<Awaited<ReturnType<ReadWallpaper>>>()
    const b = bench(() => pending.promise)
    const url = b.cache.acquire('h')
    b.cache.release('h')
    pending.resolve({ ok: true, value: PNG })
    expect(await url).toBeUndefined()
    expect(b.urls.create).not.toHaveBeenCalled()
  })

  it('revokes every live URL on dispose and refuses later acquisitions', async () => {
    const pending = deferred<Awaited<ReturnType<ReadWallpaper>>>()
    let calls = 0
    const b = bench(() => {
      calls += 1
      return calls === 1 ? Promise.resolve({ ok: true, value: PNG }) : pending.promise
    })
    await b.cache.acquire('live')
    const late = b.cache.acquire('late')
    b.cache.dispose()
    await vi.waitFor(() => { expect(b.urls.revoke).toHaveBeenCalledExactlyOnceWith('blob:wallpaper-1') })
    pending.resolve({ ok: true, value: PNG })
    expect(await late).toBeUndefined()
    expect(await b.cache.acquire('after')).toBeUndefined()
    expect(b.urls.create).toHaveBeenCalledOnce()
  })
})
