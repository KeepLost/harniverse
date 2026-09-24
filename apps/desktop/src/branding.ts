/** Shared Harniverse mark for native presentation and build-time installer assets. */

/**
 * Rasterize the shell's blue H on a transparent square without font or OS dependencies.
 * @param size - square pixel size requested by the native shell or packager.
 * @param order - Electron uses BGRA bitmaps; PNG encoders consume RGBA.
 * @returns unpremultiplied pixels (all nontransparent pixels are fully opaque).
 */
export function desktopIconBitmap(size: number, order: 'rgba' | 'bgra'): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const row = (y + 0.5) * 18 / size
    for (let x = 0; x < size; x++) {
      const column = (x + 0.5) * 18 / size
      if (row < 2 || row >= 16 || column < 3 || column >= 15) continue
      if (column >= 6 && column < 12 && (row < 7 || row >= 11)) continue
      const offset = (y * size + x) * 4
      pixels[offset] = order === 'rgba' ? 70 : 180
      pixels[offset + 1] = 110
      pixels[offset + 2] = order === 'rgba' ? 180 : 70
      pixels[offset + 3] = 255
    }
  }
  return pixels
}
