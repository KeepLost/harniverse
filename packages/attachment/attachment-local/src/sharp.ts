/**
 * Lazy `sharp` loader: image-free startup never loads the native binding.
 * @module @deepseek-ai/dsh-attachment-local/sharp
 */

import type sharp from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

/** Caller-relative loader pinned to this package's published layout. */
export const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)
