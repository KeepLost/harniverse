/**
 * Lazy `sharp` loader: image-free startup never loads the native binding.
 * @module @deepseek-ai/dsh-attachment-local/sharp
 */

import type sharp from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

/** Caller-relative loader pinned to this package's published layout. */
const loadSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)

let svgBlocked = false

/**
 * Load `sharp` with the SVG decoder disabled. SVG is not an accepted
 * attachment format, so untrusted bytes must never reach librsvg even to be
 * rejected afterwards.
 * @returns the `sharp` module, process-wide blocked from decoding SVG.
 */
export function requireSharp(): typeof sharp {
  const loaded = loadSharp()
  if (!svgBlocked) {
    loaded.block({ operation: ['VipsForeignLoadSvg'] })
    svgBlocked = true
  }
  return loaded
}
