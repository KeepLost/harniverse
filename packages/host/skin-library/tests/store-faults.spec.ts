/** Read faults while scanning packs: an unreadable file is reported, not fatal. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn((path: string, options?: unknown) => {
      if (path.endsWith('eio.json')) return Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
      // A non-Error rejection is the case under test.
      if (path.endsWith('odd.json')) return Promise.reject('not an error')
      return actual.readFile(path, options as never)
    }),
  }
})

const { PACK_FORMAT } = await import('../src/pack.ts')
const { SkinStore } = await import('../src/store.ts')
const { mkdir, writeFile } = await import('node:fs/promises')

describe('pack scan faults', () => {
  it('reports unreadable pack files and keeps the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skin-faults-'))
    try {
      const packs = join(root, 'packs')
      await mkdir(packs)
      await writeFile(join(packs, 'eio.json'), '{}')
      await writeFile(join(packs, 'odd.json'), '{}')
      await writeFile(join(packs, 'fine.json'), JSON.stringify({
        format: PACK_FORMAT,
        version: 1,
        id: 'fine',
        name: 'Fine',
        colorScheme: 'dark',
        tokens: {
          '--dsw-accent': '#5e6ad2',
          '--dsw-alias-bg-base': '#101014',
          '--dsw-alias-bg-layer-1': '#1b1e28',
          '--dsw-alias-border-l1': '#222222',
          '--dsw-alias-border-l2': '#333333',
          '--dsw-alias-label-primary': '#f4f5f7',
          '--dsw-alias-label-secondary': '#a5adb8',
        },
      }))
      const listing = await new SkinStore(root).listPacks()
      expect(listing.skins.map(skin => skin.id)).toEqual(['fine'])
      expect(listing.rejected).toEqual([
        { file: 'eio.json', message: 'the pack could not be read: EIO: i/o error' },
        { file: 'odd.json', message: 'the pack could not be read: not an error' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
