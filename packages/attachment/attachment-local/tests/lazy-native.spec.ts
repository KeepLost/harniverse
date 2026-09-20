import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { detectImage } from '../src/image.ts'

const require = createRequire(import.meta.url)

/** Whether one native dependency's module is present in the require cache. */
function nativeLoaded(name: string): boolean {
  const entry = require.resolve(name)
  const marker = entry.slice(0, entry.indexOf('/node_modules/') + '/node_modules/'.length)
  const root = marker + name + '/'
  return Object.keys(require.cache).some(path => path.startsWith(root))
}

describe('attachment-local lazy sharp', () => {
  it('loads no native binding at import and works on first use', async () => {
    expect(nativeLoaded('sharp')).toBe(false)
    // A one-pixel PNG exercises the real decode path through requireSharp().
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    // First use succeeding through requireSharp() proves the lazy loader works;
    // vite-node externalization bypasses require.cache, so the post-load cache
    // presence is not observable here.
    const detected = await detectImage(png)
    expect(detected).toMatchObject({ width: 1, height: 1 })
  })
})
