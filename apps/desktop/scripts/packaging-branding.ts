/** Generate native icon containers from the same mark used by the Electron shell. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { desktopIconBitmap } from '../src/branding.ts'

interface PngEncoder {
  png(options: { compressionLevel: number; adaptiveFiltering: boolean; palette: boolean }): {
    toBuffer(): Promise<Buffer>
  }
}

/**
 * Write PNG sizes, a multi-resolution Windows ICO, and macOS ICNS including Retina sizes.
 * @param directory - target-isolated build-resource directory, outside the sealed runtime.
 * @returns completion after every deterministic asset has been written.
 */
export async function generateDesktopIcons(directory: string): Promise<void> {
  // Reuse the workspace's existing image dependency; it is never added to the Electron shell.
  const require = createRequire(new URL('../../../packages/attachment/attachment-local/package.json', import.meta.url))
  const sharp = require('sharp') as (pixels: Buffer, options: {
    raw: { width: number; height: number; channels: 4 }
  }) => PngEncoder
  const pngs = new Map<number, Buffer>()
  mkdirSync(join(directory, 'icons'), { recursive: true })
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const png = await sharp(desktopIconBitmap(size, 'rgba'), { raw: { width: size, height: size, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer()
    pngs.set(size, png)
    writeFileSync(join(directory, 'icons', `${size}x${size}.png`), png)
  }
  writeFileSync(join(directory, 'icon.png'), pngs.get(1024)!)

  // Current Windows versions accept PNG entries in ICO, including the 256px representation.
  const windowsSizes = [16, 24, 32, 48, 64, 128, 256]
  const icoHeader = Buffer.alloc(6 + windowsSizes.length * 16)
  icoHeader.writeUInt16LE(1, 2)
  icoHeader.writeUInt16LE(windowsSizes.length, 4)
  let offset = icoHeader.length
  const windowsPngs = windowsSizes.map((size, index) => {
    const png = pngs.get(size)!
    const entry = 6 + index * 16
    icoHeader[entry] = size === 256 ? 0 : size
    icoHeader[entry + 1] = icoHeader[entry]!
    icoHeader.writeUInt16LE(1, entry + 4)
    icoHeader.writeUInt16LE(32, entry + 6)
    icoHeader.writeUInt32LE(png.length, entry + 8)
    icoHeader.writeUInt32LE(offset, entry + 12)
    offset += png.length
    return png
  })
  writeFileSync(join(directory, 'icon.ico'), Buffer.concat([icoHeader, ...windowsPngs]))

  const representations = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
    ic11: 32, ic12: 64, ic13: 256, ic14: 512 }
  const chunks = Object.entries(representations).map(([type, size]) => {
    const png = pngs.get(size)!
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(png.length + header.length, 4)
    return Buffer.concat([header, png])
  })
  const icnsHeader = Buffer.alloc(8)
  icnsHeader.write('icns', 0, 'ascii')
  icnsHeader.writeUInt32BE(icnsHeader.length + chunks.reduce((length, chunk) => length + chunk.length, 0), 4)
  writeFileSync(join(directory, 'icon.icns'), Buffer.concat([icnsHeader, ...chunks]))
}
