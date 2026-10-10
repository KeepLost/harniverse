/** Wallpaper intake: signature sniffing, strict base64, size ceilings, and content addressing. */

import { describe, expect, it } from 'vitest'
import {
  MAX_WALLPAPER_BYTES, MAX_WALLPAPERS, WALLPAPER_EXTENSIONS, WALLPAPER_HASH_PATTERN, WALLPAPER_MIMES,
  decodeWallpaper, parseWallpaperFileName, sniffWallpaperMime, wallpaperHash,
} from '../src/wallpaper.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

describe('sniffWallpaperMime', () => {
  it('recognizes PNG, JPEG, and WebP by signature', () => {
    expect(sniffWallpaperMime(PNG)).toBe('image/png')
    expect(sniffWallpaperMime(JPEG)).toBe('image/jpeg')
    expect(sniffWallpaperMime(WEBP)).toBe('image/webp')
  })

  it('refuses everything else, including look-alikes and truncated headers', () => {
    const cases: Array<[string, Uint8Array]> = [
      ['empty', new Uint8Array()],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['gif', Buffer.from('GIF89a......')],
      ['avif', Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif')])],
      ['riff wave', Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')])],
      ['riff without a form type', Buffer.from('RIFF')],
      ['short png', PNG.subarray(0, 7)],
      ['short jpeg', JPEG.subarray(0, 2)],
      ['png with a flipped byte', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]), Buffer.alloc(4)])],
      ['text', Buffer.from('hello world, definitely not an image')],
    ]
    for (const [label, bytes] of cases) expect(sniffWallpaperMime(bytes), label).toBeUndefined()
  })
})

describe('decodeWallpaper', () => {
  it('decodes a valid upload and reports its kind from the bytes', () => {
    const decoded = decodeWallpaper(PNG.toString('base64'))
    expect(decoded).toEqual({ ok: true, bytes: PNG, mime: 'image/png' })
    expect(decodeWallpaper(JPEG.toString('base64'))).toMatchObject({ ok: true, mime: 'image/jpeg' })
    expect(decodeWallpaper(WEBP.toString('base64'))).toMatchObject({ ok: true, mime: 'image/webp' })
  })

  it.each([
    ['whitespace', ' iVBORw0KGgo='],
    ['an embedded newline', 'iVBO\nRw0KGgo='],
    ['trailing newline', `${PNG.toString('base64')}\n`],
    ['url-safe digits', Buffer.from([0xfb, 0xff, 0xfe, 0xfb, 0xef]).toString('base64url')],
    ['a stray character', `${PNG.toString('base64')}!`],
    ['missing padding', PNG.toString('base64').replace(/=+$/, '') + 'A'],
    ['a data URL prefix', `data:image/png;base64,${PNG.toString('base64')}`],
  ])('rejects %s as invalid encoding', (_label, text) => {
    expect(decodeWallpaper(text)).toEqual({ ok: false, reason: 'invalid-encoding' })
  })

  it('rejects valid base64 that is not PNG, JPEG, or WebP', () => {
    expect(decodeWallpaper(Buffer.from('<svg/>').toString('base64'))).toEqual({ ok: false, reason: 'unsupported-type' })
    expect(decodeWallpaper('')).toEqual({ ok: false, reason: 'unsupported-type' })
  })

  it('bounds the size before and after decoding', () => {
    const atLimit = Buffer.alloc(MAX_WALLPAPER_BYTES)
    PNG.copy(atLimit)
    expect(decodeWallpaper(atLimit.toString('base64'))).toMatchObject({ ok: true, mime: 'image/png' })
    const overByOne = Buffer.alloc(MAX_WALLPAPER_BYTES + 1)
    PNG.copy(overByOne)
    // One byte over still fits the encoded-length ceiling, so the decoded size must catch it.
    expect(overByOne.toString('base64').length).toBe(Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4)
    expect(decodeWallpaper(overByOne.toString('base64'))).toEqual({ ok: false, reason: 'too-large' })
    // Far over the ceiling is refused without decoding, even when the text is not base64 at all.
    expect(decodeWallpaper('!'.repeat(Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4 + 1))).toEqual({ ok: false, reason: 'too-large' })
  })
})

describe('content addressing', () => {
  it('hashes with lowercase hex SHA-256', () => {
    expect(wallpaperHash(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(wallpaperHash(PNG)).toMatch(WALLPAPER_HASH_PATTERN)
  })

  it('parses stored file names strictly', () => {
    const hash = wallpaperHash(PNG)
    expect(parseWallpaperFileName(`${hash}.png`)).toEqual({ hash, mime: 'image/png' })
    expect(parseWallpaperFileName(`${hash}.jpg`)).toEqual({ hash, mime: 'image/jpeg' })
    expect(parseWallpaperFileName(`${hash}.webp`)).toEqual({ hash, mime: 'image/webp' })
    for (const name of [
      hash, `${hash}.gif`, `${hash}.jpeg`, `${hash}.png.tmp`, `${hash.toUpperCase()}.png`, `${hash.slice(1)}.png`,
      `.${hash}.png`, 'readme.txt', '', `${hash}.`, `${hash}.PNG`,
    ]) expect(parseWallpaperFileName(name), name).toBeUndefined()
  })

  it('keeps the extension table and kind list in step', () => {
    expect(WALLPAPER_MIMES.map(mime => WALLPAPER_EXTENSIONS[mime])).toEqual(['png', 'jpg', 'webp'])
    expect(MAX_WALLPAPERS).toBe(24)
  })
})
