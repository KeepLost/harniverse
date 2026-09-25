import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  expect(index).not.toMatch(/<link\b[^>]*\brel=["'][^"']*\bicon\b/i)
  await expect(readFile(join(DIST_ROOT, 'favicon.svg'))).rejects.toMatchObject({ code: 'ENOENT' })

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Harniverse',
    short_name: 'Harniverse',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      {
        src: '/harniverse-brand-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/harniverse-brand-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  })
})

it('ships the complete brand artwork at both install icon sizes', async () => {
  for (const [name, size] of [
    ['harniverse-brand-192.png', 192],
    ['harniverse-brand-512.png', 512],
  ] as const) {
    const png = await readFile(join(DIST_ROOT, name))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.readUInt32BE(16)).toBe(size)
    expect(png.readUInt32BE(20)).toBe(size)
  }
})
