import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generateDesktopIcons } from '../scripts/packaging-branding.ts'
import { desktopIconBitmap } from '../src/branding.ts'

function pngSize(bytes: Buffer): number {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  assert.equal(bytes[25], 6, 'icons retain RGBA transparency')
  return bytes.readUInt32BE(16)
}

void test('native window and tray retain the same blue H mark as the packaged icons', () => {
  const rgba = desktopIconBitmap(18, 'rgba')
  const bgra = desktopIconBitmap(18, 'bgra')
  const pixel = (x: number, y: number) => [...rgba.subarray((y * 18 + x) * 4, (y * 18 + x + 1) * 4)]
  assert.deepEqual(pixel(3, 2), [70, 110, 180, 255])
  assert.deepEqual(pixel(12, 15), [70, 110, 180, 255])
  assert.deepEqual(pixel(9, 8), [70, 110, 180, 255])
  assert.deepEqual(pixel(9, 3), [0, 0, 0, 0])
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 0])
  for (let offset = 0; offset < rgba.length; offset += 4) {
    assert.deepEqual([...bgra.subarray(offset, offset + 4)], [rgba[offset + 2], rgba[offset + 1], rgba[offset], rgba[offset + 3]])
  }
})

void test('packaging emits deterministic PNG, Windows ICO and macOS ICNS from the native H mark', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harniverse-branding-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await generateDesktopIcons(first)
    await generateDesktopIcons(second)
    assert.equal(pngSize(readFileSync(join(first, 'icon.png'))), 1024)
    const sizes = readdirSync(join(first, 'icons')).map((name) => {
      const bytes = readFileSync(join(first, 'icons', name))
      assert.deepEqual(bytes, readFileSync(join(second, 'icons', name)))
      const size = pngSize(bytes)
      assert.equal(name, `${size}x${size}.png`)
      return size
    })
    assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256, 512, 1024])
    for (const name of ['icon.png', 'icon.ico', 'icon.icns']) {
      assert.deepEqual(readFileSync(join(first, name)), readFileSync(join(second, name)), `${name} must be reproducible`)
    }

    const ico = readFileSync(join(first, 'icon.ico'))
    assert.equal(ico.readUInt16LE(0), 0)
    assert.equal(ico.readUInt16LE(2), 1)
    const count = ico.readUInt16LE(4)
    assert.equal(count, 7)
    let nextOffset = 6 + count * 16
    const icoSizes: number[] = []
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16
      const size = ico[entry] || 256
      assert.equal(ico[entry + 1] || 256, size)
      assert.equal(ico.readUInt16LE(entry + 6), 32)
      assert.equal(ico.readUInt32LE(entry + 12), nextOffset)
      const length = ico.readUInt32LE(entry + 8)
      assert.deepEqual(ico.subarray(nextOffset, nextOffset + length), readFileSync(join(first, 'icons', `${size}x${size}.png`)))
      nextOffset += length
      icoSizes.push(size)
    }
    assert.equal(nextOffset, ico.length)
    assert.deepEqual(icoSizes, [16, 24, 32, 48, 64, 128, 256])

    const icns = readFileSync(join(first, 'icon.icns'))
    assert.equal(icns.toString('ascii', 0, 4), 'icns')
    assert.equal(icns.readUInt32BE(4), icns.length)
    const representations: Record<string, number> = {}
    let offset = 8
    while (offset < icns.length) {
      const type = icns.toString('ascii', offset, offset + 4)
      const length = icns.readUInt32BE(offset + 4)
      assert.ok(length > 8 && offset + length <= icns.length)
      const png = icns.subarray(offset + 8, offset + length)
      const size = pngSize(png)
      assert.deepEqual(png, readFileSync(join(first, 'icons', `${size}x${size}.png`)))
      representations[type] = size
      offset += length
    }
    assert.equal(offset, icns.length)
    assert.deepEqual(representations, { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
      ic11: 32, ic12: 64, ic13: 256, ic14: 512 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
