/**
 * Deterministic io-arm specs for the containment helpers: the registered
 * root failing realpath with a non-absence code, and the root resolving to
 * a different canonical directory, driven through a controlled realpath.
 */
import { describe, expect, it, vi } from 'vitest'
import { containedRoot } from '../src/containment.ts'

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  realpath: vi.fn(),
}))

const { realpath } = await import('node:fs/promises')

describe('containedRoot failure mapping', () => {
  it('refuses with io when the registered root fails realpath beyond absence', async () => {
    vi.mocked(realpath).mockRejectedValue(Object.assign(new Error('file name too long'), { code: 'ENAMETOOLONG' }))
    await expect(containedRoot('/gone-root', 'a.txt')).rejects.toMatchObject({ code: 'io' })
  })

  it('refuses with not-found when the registered root is merely absent', async () => {
    vi.mocked(realpath).mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    await expect(containedRoot('/gone-root', 'a.txt')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses with path-invalid when the root resolves elsewhere', async () => {
    vi.mocked(realpath).mockResolvedValue('/canonical/root')
    await expect(containedRoot('/registered/root', 'a.txt')).rejects.toMatchObject({ code: 'path-invalid' })
  })

  it('rejects a re-thrown non-errno failure as io', async () => {
    vi.mocked(realpath).mockRejectedValue('plain rejection')
    await expect(containedRoot('/registered/root', 'a.txt')).rejects.toMatchObject({ code: 'io' })
  })
})
