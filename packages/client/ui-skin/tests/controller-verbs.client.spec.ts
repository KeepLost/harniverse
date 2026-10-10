import { describe, expect, it, vi } from 'vitest'
import { WRITE_DELAY_MS } from '../src/client/writer.ts'
import { fail, makeBench, ok, ready } from './controller-bench.client.ts'
import { GRADIENT, HASH_A, HASH_B, skin, snapshot, wallpaper } from './fixtures.client.ts'

const file = (size: number, name = 'pic.png'): File => Object.defineProperty(new File([], name), 'size', { value: size })

async function started(options: Parameters<typeof makeBench>[0] = {}) {
  const b = makeBench(options)
  await b.controller.start()
  ready(b)
  return b
}

describe('SkinController wallpaper verbs', () => {
  it('refuses an oversized image before sending any bytes', async () => {
    const b = await started()
    const outcome = await b.controller.uploadWallpaper(file(8 * 1024 * 1024 + 1))
    expect(outcome).toEqual({ status: 'rejected', reason: 'too-large' })
    expect(b.deps.readBase64).not.toHaveBeenCalled()
    expect(b.remote.putWallpaper).not.toHaveBeenCalled()
  })

  it('reports a file that cannot be read', async () => {
    const b = await started()
    b.deps.readBase64.mockRejectedValueOnce(new Error('disk gone'))
    expect(await b.controller.uploadWallpaper(file(10))).toEqual({ status: 'failed', message: 'disk gone' })
    b.deps.readBase64.mockRejectedValueOnce('odd failure')
    expect(await b.controller.uploadWallpaper(file(10))).toEqual({ status: 'failed', message: 'odd failure' })
  })

  it('passes the Host rejection reason through', async () => {
    const b = await started()
    b.remote.putWallpaper.mockResolvedValueOnce(ok({ status: 'rejected' as const, reason: 'unsupported-type' as const }))
    expect(await b.controller.uploadWallpaper(file(10))).toEqual({ status: 'rejected', reason: 'unsupported-type' })
    expect(b.remote.putWallpaper).toHaveBeenCalledWith('AAAA')
  })

  it('stores, refreshes the catalog, and selects the new wallpaper', async () => {
    const b = await started()
    const stored = wallpaper('d'.repeat(64))
    b.remote.putWallpaper.mockResolvedValueOnce(ok({ status: 'stored' as const, wallpaper: stored }))
    b.remote.list.mockResolvedValueOnce(ok(snapshot({ wallpapers: [stored, wallpaper(HASH_A)] })))
    expect(await b.controller.uploadWallpaper(file(10))).toEqual({ status: 'ok', hash: stored.hash })
    expect(b.controller.view.getSnapshot().settings.wallpaper).toBe(stored.hash)
    expect(b.controller.view.getSnapshot().backdrop).toMatchObject({ kind: 'wallpaper', hash: stored.hash })
  })

  it('surfaces a failed upload and latches a refusal for lack of authority', async () => {
    const b = await started()
    b.remote.putWallpaper.mockResolvedValueOnce(fail('boom'))
    expect(await b.controller.uploadWallpaper(file(10))).toEqual({ status: 'failed', message: 'boom' })
    expect(b.controller.view.getSnapshot().access.denied).toBe(false)
    b.remote.putWallpaper.mockResolvedValueOnce(fail('authenticated principal lacks harniverse.administer'))
    await b.controller.uploadWallpaper(file(10))
    expect(b.controller.view.getSnapshot().access.denied).toBe(true)
    b.controller.setSetting('accent', '#abcdef')
    expect(b.controller.view.getSnapshot().settings.accent).toBe('')
  })

  it('recognises a refusal by its code as well', async () => {
    const b = await started()
    b.remote.removeWallpaper.mockResolvedValueOnce(fail('no', 'forbidden'))
    expect(await b.controller.removeWallpaper(HASH_A)).toEqual({ status: 'failed', message: 'no' })
    expect(b.controller.view.getSnapshot().access.denied).toBe(true)
  })

  it('deletes a wallpaper, clearing the selection only when it was the chosen one', async () => {
    const b = await started()
    ready(b, { wallpaper: HASH_A })
    b.remote.list.mockResolvedValue(ok(snapshot({ wallpapers: [wallpaper(HASH_B)] })))
    expect(await b.controller.removeWallpaper(HASH_B)).toEqual({ status: 'ok' })
    expect(b.controller.view.getSnapshot().settings.wallpaper).toBe(HASH_A)
    expect(await b.controller.removeWallpaper(HASH_A)).toEqual({ status: 'ok' })
    expect(b.controller.view.getSnapshot().settings.wallpaper).toBe('')
    expect(b.remote.removeWallpaper).toHaveBeenNthCalledWith(2, HASH_A)
    expect(b.controller.view.getSnapshot().library.wallpapers.map(w => w.hash)).toEqual([HASH_B])
  })

  it('writes a chosen wallpaper once the input rests', async () => {
    vi.useFakeTimers()
    try {
      const b = await started()
      b.controller.setSetting('wallpaper', HASH_B)
      expect(b.controller.view.getSnapshot().settings.wallpaper).toBe(HASH_B)
      await vi.advanceTimersByTimeAsync(WRITE_DELAY_MS)
      expect(b.scope.set).toHaveBeenCalledExactlyOnceWith('wallpaper', HASH_B)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SkinController pack verbs', () => {
  it('refuses an oversized pack before reading it', async () => {
    const b = await started()
    expect(await b.controller.importPack(file(256 * 1024 + 1, 'big.json'))).toEqual({ status: 'too-large' })
    expect(b.deps.readText).not.toHaveBeenCalled()
  })

  it('reports an unreadable file and a failed call', async () => {
    const b = await started()
    b.deps.readText.mockRejectedValueOnce(new Error('disk gone'))
    expect(await b.controller.importPack(file(10))).toEqual({ status: 'failed', message: 'disk gone' })
    b.remote.importPack.mockResolvedValueOnce(fail('host down'))
    expect(await b.controller.importPack(file(10))).toEqual({ status: 'failed', message: 'host down' })
  })

  it('hands the Host issues back verbatim', async () => {
    const b = await started()
    b.remote.importPack.mockResolvedValueOnce(ok({ status: 'rejected' as const, issues: ['tokens: bad', 'id: taken'] }))
    expect(await b.controller.importPack(file(10))).toEqual({ status: 'rejected', issues: ['tokens: bad', 'id: taken'] })
    expect(b.remote.importPack).toHaveBeenCalledWith('{"pack":true}')
  })

  it('refreshes the catalog after an import or a replacement', async () => {
    const b = await started()
    const imported = skin('mine', { source: 'pack' })
    b.remote.importPack.mockResolvedValueOnce(ok({ status: 'imported' as const, skin: imported }))
    b.remote.list.mockResolvedValueOnce(ok(snapshot({ skins: [...snapshot().skins, imported] })))
    expect(await b.controller.importPack(file(10))).toEqual({ status: 'imported', skin: imported })
    expect(b.theme.registered.has('skin:mine')).toBe(true)
    b.remote.importPack.mockResolvedValueOnce(ok({ status: 'replaced' as const, skin: imported }))
    expect(await b.controller.importPack(file(10))).toEqual({ status: 'replaced', skin: imported })
  })

  it('removes a pack and falls back to system when it was the selected skin', async () => {
    const b = await started()
    b.theme.setTheme('skin:abyss')
    b.remote.list.mockResolvedValueOnce(ok(snapshot({ skins: [skin('ivory')] })))
    expect(await b.controller.removePack('abyss')).toEqual({ status: 'ok' })
    expect(b.theme.preference).toBe('system')
    expect(b.theme.registered.has('skin:abyss')).toBe(false)
  })

  it('leaves the selection alone when another skin is removed, and reports a failed removal', async () => {
    const b = await started()
    b.theme.setTheme('skin:abyss')
    expect(await b.controller.removePack('ivory')).toEqual({ status: 'ok' })
    expect(b.theme.preference).toBe('skin:abyss')
    b.remote.removePack.mockResolvedValueOnce(fail('nope'))
    expect(await b.controller.removePack('ivory')).toEqual({ status: 'failed', message: 'nope' })
  })

  it('exports the active catalog skin and nothing for light or dark', async () => {
    const b = await started()
    expect(b.controller.exportActive()).toBe(false)
    expect(b.deps.download).not.toHaveBeenCalled()
    b.theme.setTheme('skin:abyss')
    expect(b.controller.exportActive()).toBe(true)
    const [fileName, text] = b.deps.download.mock.calls[0] as unknown as [string, string]
    expect(fileName).toBe('abyss-copy.json')
    expect(JSON.parse(text)).toMatchObject({ format: 'harniverse.skin', version: 1, id: 'abyss-copy', background: GRADIENT })
  })
})

describe('SkinController wallpaper URLs', () => {
  it('hands out and revokes object URLs through acquire and release', async () => {
    const b = await started()
    b.remote.readWallpaper.mockResolvedValue(ok({ mime: 'image/webp', contentBase64: 'AAAA' }))
    expect(await b.controller.acquireWallpaper(HASH_A)).toBe('blob:wp')
    b.controller.releaseWallpaper(HASH_A)
    await Promise.resolve()
    await Promise.resolve()
    expect(b.deps.urls.revoke).toHaveBeenCalledWith('blob:wp')
  })
})
