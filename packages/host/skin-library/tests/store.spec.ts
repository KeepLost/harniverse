/** The filesystem-backed library: layout, permissions, atomic writes, scanning, caps, and removal. */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DREAM_SKIN_FORMAT, MAX_PACK_BYTES, PACK_FORMAT, parseSkinPack } from '../src/pack.ts'
import { SkinStore } from '../src/store.ts'
import type { SkinDefinition } from '../src/types.ts'
import { MAX_WALLPAPER_BYTES, MAX_WALLPAPERS, wallpaperHash } from '../src/wallpaper.ts'

const TOKENS = {
  '--dsw-accent': '#5e6ad2',
  '--dsw-alias-bg-base': '#101014',
  '--dsw-alias-bg-layer-1': '#1b1e28',
  '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.07)',
  '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.13)',
  '--dsw-alias-label-primary': '#f4f5f7',
  '--dsw-alias-label-secondary': '#a5adb8',
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const posix = process.platform !== 'win32'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function library(): Promise<{ dir: string; store: SkinStore }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-skin-store-'))
  const dir = join(root, 'skins')
  return { dir, store: new SkinStore(dir) }
}

function skin(id: string, name = id): SkinDefinition {
  const parsed = parseSkinPack(JSON.stringify({ format: PACK_FORMAT, version: 1, id, name, colorScheme: 'dark', tokens: TOKENS }))
  if (!parsed.ok) throw new Error(parsed.issues.join('; '))
  return parsed.skin
}

function image(seed: number | string): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.from(`seed-${seed}`)])
}

async function dropPack(dir: string, file: string, content: string | Buffer): Promise<void> {
  await mkdir(join(dir, 'packs'), { recursive: true })
  await writeFile(join(dir, 'packs', file), content)
}

describe('packs', () => {
  it('lists nothing before the first write and creates nothing on read', async () => {
    const { dir, store } = await library()
    expect(await store.listPacks()).toEqual({ skins: [], rejected: [] })
    expect(await store.listWallpapers()).toEqual([])
    expect(await store.readWallpaper('a'.repeat(64))).toBeUndefined()
    expect(await store.removePack('nothing')).toBe(false)
    expect(await store.removeWallpaper('a'.repeat(64))).toBe(false)
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes a private native pack atomically and replaces it on re-import', async () => {
    const { dir, store } = await library()
    const first = skin('my-skin', 'First')
    expect(await store.putPack(first)).toBe('imported')
    const path = join(dir, 'packs', 'my-skin.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ format: PACK_FORMAT, version: 1, id: 'my-skin', name: { en: 'First' } })
    if (posix) {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir, 'packs'))).mode & 0o777).toBe(0o700)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
    }
    expect(await store.putPack(skin('my-skin', 'Second'))).toBe('replaced')
    expect((await store.listPacks()).skins.map(item => item.name.en)).toEqual(['Second'])
    // No temp files remain after successful writes.
    expect(await readdir(join(dir, 'packs'))).toEqual(['my-skin.json'])
  })

  it('lists packs ordered by English name, then id', async () => {
    const { store } = await library()
    await store.putPack(skin('zeta', 'Alpha'))
    await store.putPack(skin('beta', 'Beta'))
    await store.putPack(skin('alpha', 'Alpha'))
    expect((await store.listPacks()).skins.map(item => item.id)).toEqual(['alpha', 'zeta', 'beta'])
  })

  it('picks up hand-dropped native and dream-skin packs and reports the invalid ones', async () => {
    const { dir, store } = await library()
    await dropPack(dir, 'handmade.json', JSON.stringify({ format: PACK_FORMAT, version: 1, id: 'handmade', name: 'Hand Made', colorScheme: 'light', tokens: TOKENS }))
    await dropPack(dir, 'aurora-test.json', JSON.stringify({
      format: DREAM_SKIN_FORMAT,
      version: 1,
      manifest: { id: 'Aurora-Test', name: 'Aurora Test', colorScheme: 'dark', tokens: { ...TOKENS, '--dsw-accent': undefined, '--dsw-alias-brand-primary': '#34d399' } },
    }))
    await dropPack(dir, 'broken.json', '{ not json')
    await dropPack(dir, 'evil.json', JSON.stringify({ format: PACK_FORMAT, version: 1, id: 'evil', name: 'Evil', colorScheme: 'dark', tokens: { ...TOKENS, '--dsw-accent': 'url(https://example.com/x)' } }))
    await dropPack(dir, 'wrong-name.json', JSON.stringify({ format: PACK_FORMAT, version: 1, id: 'other-id', name: 'Other', colorScheme: 'dark', tokens: TOKENS }))
    await dropPack(dir, 'abyss.json', JSON.stringify({ format: PACK_FORMAT, version: 1, id: 'abyss', name: 'Fake', colorScheme: 'dark', tokens: TOKENS }))
    await dropPack(dir, 'huge.json', 'x'.repeat(MAX_PACK_BYTES + 1))
    await dropPack(dir, 'notes.txt', 'ignored: not a .json file')
    await dropPack(dir, '.hidden.tmp', 'ignored: a leftover temp file')
    await mkdir(join(dir, 'packs', 'folder.json'))
    if (posix) await symlink(join(dir, 'packs', 'handmade.json'), join(dir, 'packs', 'link.json'))

    const listing = await store.listPacks()
    expect(listing.skins.map(item => item.id)).toEqual(['aurora-test', 'handmade'])
    expect(listing.skins[0]!.tokens['--dsw-accent']).toBe('#34d399')
    expect(listing.rejected.map(item => item.file)).toEqual(['abyss.json', 'broken.json', 'evil.json', 'huge.json', 'wrong-name.json'])
    const reasons = Object.fromEntries(listing.rejected.map(item => [item.file, item.message]))
    expect(reasons['abyss.json']).toContain('built-in skin')
    expect(reasons['broken.json']).toContain('not valid JSON')
    expect(reasons['evil.json']).toContain('--dsw-accent')
    expect(reasons['huge.json']).toContain('the limit is 262144 bytes')
    expect(reasons['wrong-name.json']).toBe('the file name must be other-id.json to match the pack id')
  })

  it('removes a pack by id and reports whether anything was removed', async () => {
    const { dir, store } = await library()
    await store.putPack(skin('gone'))
    expect(await store.removePack('gone')).toBe(true)
    expect(await store.removePack('gone')).toBe(false)
    expect(await store.removePack('../escape')).toBe(false)
    expect(await store.removePack('Bad Id')).toBe(false)
    expect((await store.listPacks()).skins).toEqual([])
    expect(await readdir(join(dir, 'packs'))).toEqual([])
  })

  it('reads one pack synchronously for the boot tap and refuses anything not a valid pack of that id', async () => {
    const { dir, store } = await library()
    await store.putPack(skin('boot-me'))
    expect(store.readPackSync('boot-me')).toMatchObject({ id: 'boot-me', source: 'pack' })
    expect(store.readPackSync('missing')).toBeUndefined()
    expect(store.readPackSync('../packs/boot-me')).toBeUndefined()
    expect(store.readPackSync('Boot-Me')).toBeUndefined()
    await dropPack(dir, 'garbage.json', 'garbage')
    expect(store.readPackSync('garbage')).toBeUndefined()
    await dropPack(dir, 'liar.json', JSON.stringify({ format: PACK_FORMAT, version: 1, id: 'someone-else', name: 'Liar', colorScheme: 'dark', tokens: TOKENS }))
    expect(store.readPackSync('liar')).toBeUndefined()
    await dropPack(dir, 'huge.json', 'x'.repeat(MAX_PACK_BYTES + 1))
    expect(store.readPackSync('huge')).toBeUndefined()
    await mkdir(join(dir, 'packs', 'folder.json'))
    expect(store.readPackSync('folder')).toBeUndefined()
  })
})

describe('wallpapers', () => {
  it('stores bytes under their content address with private permissions', async () => {
    const { dir, store } = await library()
    const bytes = image('one')
    const hash = wallpaperHash(bytes)
    const result = await store.putWallpaper(bytes, 'image/png')
    expect(result).toMatchObject({ status: 'stored', wallpaper: { hash, mime: 'image/png', bytes: bytes.length } })
    const path = join(dir, 'wallpapers', `${hash}.png`)
    expect(await readFile(path)).toEqual(bytes)
    if (posix) {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir, 'wallpapers'))).mode & 0o777).toBe(0o700)
    }
    expect(await readdir(join(dir, 'wallpapers'))).toEqual([`${hash}.png`])
    expect(await store.readWallpaper(hash)).toEqual({ mime: 'image/png', contentBase64: bytes.toString('base64') })
  })

  it('answers identical bytes with the existing entry and keeps its first-upload time', async () => {
    const { dir, store } = await library()
    const bytes = image('same')
    const first = await store.putWallpaper(bytes, 'image/png')
    if (first.status !== 'stored') throw new Error('expected stored')
    const past = new Date(1_700_000_000_000)
    await utimes(join(dir, 'wallpapers', `${first.wallpaper.hash}.png`), past, past)
    const again = await store.putWallpaper(bytes, 'image/png')
    expect(again).toEqual({ status: 'existing', wallpaper: { ...first.wallpaper, addedAt: 1_700_000_000_000 } })
    expect(await store.listWallpapers()).toHaveLength(1)
  })

  it('takes addedAt from the file mtime and lists newest first', async () => {
    const { dir, store } = await library()
    const stamps: Array<[string, number]> = []
    for (const [seed, seconds] of [['a', 1_700_000_100], ['b', 1_700_000_300], ['c', 1_700_000_200]] as const) {
      const bytes = image(seed)
      await store.putWallpaper(bytes, 'image/png')
      await utimes(join(dir, 'wallpapers', `${wallpaperHash(bytes)}.png`), seconds, seconds)
      stamps.push([wallpaperHash(bytes), seconds * 1000])
    }
    const listed = await store.listWallpapers()
    expect(listed.map(entry => entry.addedAt)).toEqual([1_700_000_300_000, 1_700_000_200_000, 1_700_000_100_000])
    expect(listed.map(entry => entry.hash)).toEqual([stamps[1]![0], stamps[2]![0], stamps[0]![0]])
  })

  it('orders equal times by hash', async () => {
    const { dir, store } = await library()
    const hashes: string[] = []
    for (const seed of ['x', 'y', 'z']) {
      const bytes = image(seed)
      await store.putWallpaper(bytes, 'image/png')
      await utimes(join(dir, 'wallpapers', `${wallpaperHash(bytes)}.png`), 1_700_000_000, 1_700_000_000)
      hashes.push(wallpaperHash(bytes))
    }
    expect((await store.listWallpapers()).map(entry => entry.hash)).toEqual([...hashes].sort())
  })

  it('enforces the wallpaper cap, even for concurrent uploads, and frees a slot on removal', async () => {
    const { store } = await library()
    const results = await Promise.all(Array.from({ length: MAX_WALLPAPERS + 6 }, (_, index) => store.putWallpaper(image(index), 'image/png')))
    expect(results.filter(result => result.status === 'stored')).toHaveLength(MAX_WALLPAPERS)
    expect(results.filter(result => result.status === 'rejected')).toEqual(
      Array.from({ length: 6 }, () => ({ status: 'rejected', reason: 'limit-reached' })),
    )
    const stored = (await store.listWallpapers()).map(entry => entry.hash)
    expect(stored).toHaveLength(MAX_WALLPAPERS)
    // At the cap an identical upload is still answered, a new one is refused.
    expect(await store.putWallpaper(image(0), 'image/png')).toMatchObject({ status: 'existing' })
    expect(await store.putWallpaper(image('brand-new'), 'image/png')).toEqual({ status: 'rejected', reason: 'limit-reached' })
    expect(await store.removeWallpaper(stored[0]!)).toBe(true)
    expect(await store.putWallpaper(image('brand-new'), 'image/png')).toMatchObject({ status: 'stored' })
  })

  it('stores each kind under its extension and removes whichever exists', async () => {
    const { dir, store } = await library()
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
    await store.putWallpaper(jpeg, 'image/jpeg')
    await store.putWallpaper(webp, 'image/webp')
    expect((await readdir(join(dir, 'wallpapers'))).map(name => name.split('.')[1]).sort()).toEqual(['jpg', 'webp'])
    expect((await store.listWallpapers()).map(entry => entry.mime).sort()).toEqual(['image/jpeg', 'image/webp'])
    expect(await store.readWallpaper(wallpaperHash(jpeg))).toMatchObject({ mime: 'image/jpeg' })
    expect(await store.readWallpaper(wallpaperHash(webp))).toMatchObject({ mime: 'image/webp' })
    expect(await store.removeWallpaper(wallpaperHash(jpeg))).toBe(true)
    expect(await store.removeWallpaper(wallpaperHash(jpeg))).toBe(false)
    expect(await store.removeWallpaper('NOT-A-HASH')).toBe(false)
    expect(await store.removeWallpaper(wallpaperHash(webp))).toBe(true)
    expect(await readdir(join(dir, 'wallpapers'))).toEqual([])
  })

  it('refuses to read a wallpaper whose bytes no longer match their address or kind', async () => {
    const { dir, store } = await library()
    const bytes = image('tamper')
    const hash = wallpaperHash(bytes)
    await store.putWallpaper(bytes, 'image/png')
    expect(await store.readWallpaper(hash)).toBeDefined()
    await writeFile(join(dir, 'wallpapers', `${hash}.png`), image('different'))
    expect(await store.readWallpaper(hash)).toBeUndefined()

    const notAnImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const svgHash = wallpaperHash(notAnImage)
    await writeFile(join(dir, 'wallpapers', `${svgHash}.png`), notAnImage)
    expect(await store.readWallpaper(svgHash)).toBeUndefined()

    const huge = 'b'.repeat(64)
    await writeFile(join(dir, 'wallpapers', `${huge}.png`), '')
    await truncate(join(dir, 'wallpapers', `${huge}.png`), MAX_WALLPAPER_BYTES + 1)
    expect(await store.readWallpaper(huge)).toBeUndefined()
  })

  it('rejects malformed and unknown addresses without touching the disk', async () => {
    const { store } = await library()
    for (const hash of ['', 'abc', 'A'.repeat(64), `../${'a'.repeat(61)}`, `${'a'.repeat(64)}.png`]) {
      expect(await store.readWallpaper(hash), hash).toBeUndefined()
    }
    expect(await store.readWallpaper('c'.repeat(64))).toBeUndefined()
  })

  it('ignores files that are not stored wallpapers when scanning', async () => {
    const { dir, store } = await library()
    const bytes = image('real')
    await store.putWallpaper(bytes, 'image/png')
    const wallpapers = join(dir, 'wallpapers')
    await writeFile(join(wallpapers, 'README.txt'), 'hello')
    await writeFile(join(wallpapers, `${'d'.repeat(64)}.gif`), 'GIF89a')
    await writeFile(join(wallpapers, `.${wallpaperHash(bytes)}.png.tmp`), 'partial')
    await mkdir(join(wallpapers, `${'e'.repeat(64)}.png`))
    const oversize = join(wallpapers, `${'f'.repeat(64)}.png`)
    await writeFile(oversize, '')
    await truncate(oversize, MAX_WALLPAPER_BYTES + 1)
    expect((await store.listWallpapers()).map(entry => entry.hash)).toEqual([wallpaperHash(bytes)])
  })
})

describe('failures', () => {
  it('surfaces a failed write, leaves no temp file, and keeps later writes working', async () => {
    const { dir, store } = await library()
    await mkdir(join(dir, 'packs', 'blocked.json'), { recursive: true })
    await expect(store.putPack(skin('blocked'))).rejects.toThrow()
    expect((await readdir(join(dir, 'packs'))).sort()).toEqual(['blocked.json'])
    expect(await store.putPack(skin('after'))).toBe('imported')
    await expect(store.removePack('blocked')).rejects.toThrow()
    expect(await store.removePack('after')).toBe(true)
  })

  it('surfaces a library root that is not a directory', async () => {
    const { dir, store } = await library()
    await writeFile(dir, 'a file where the library should be')
    await expect(store.putPack(skin('nowhere'))).rejects.toThrow()
    await expect(store.listPacks()).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(store.listWallpapers()).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(store.putWallpaper(image('x'), 'image/png')).rejects.toThrow()
  })
})
