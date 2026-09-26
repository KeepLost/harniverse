import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  expect(index).toContain('<link rel="icon" href="/whale-logo.ico" type="image/x-icon" />')

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
        src: '/whale-logo-light.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  })
})

it('ships the complete lightweight logo set, including the future dark-theme variant', async () => {
  for (const name of ['whale-logo.svg', 'whale-logo-light.svg', 'whale-logo-transparent.svg']) {
    const svg = await readFile(join(DIST_ROOT, name), 'utf8')
    expect(svg).toContain('<ns0:svg')
    expect(svg).toContain('width="1254" height="1254"')
  }
  const ico = await readFile(join(DIST_ROOT, 'whale-logo.ico'))
  expect(ico.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
})
