/**
 * Deterministic io-arm specs for the containment helpers: the registered
 * root failing realpath with a non-absence code, the root resolving to
 * a different canonical directory, and the create-side walk, exclusive
 * directory create, and post-create verification arms, driven through a
 * controlled node:fs/promises surface.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  containedRoot, createExclusiveDirectory, ensureIntermediateDirectory, requireAbsentEntry, verifyCreatedEntry,
} from '../src/containment.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: vi.fn((path: string) => actual.realpath(path)),
    lstat: vi.fn((path: string) => actual.lstat(path)),
    mkdir: vi.fn((path: string) => actual.mkdir(path)),
    stat: vi.fn((path: string) => actual.stat(path)),
    open: vi.fn((path: string, flags?: number) => actual.open(path, flags)),
  }
})

const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const { realpath, lstat, mkdir, stat, open } = await import('node:fs/promises')

let root: string | undefined

beforeEach(async () => {
  root = await actual.realpath(await mkdtemp(join(tmpdir(), 'dsh-wfw-create-faults-')))
})

afterEach(async () => {
  vi.mocked(realpath).mockReset()
  vi.mocked(lstat).mockReset()
  vi.mocked(mkdir).mockReset()
  vi.mocked(stat).mockReset()
  vi.mocked(open).mockReset()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

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

describe('requireAbsentEntry failure mapping', () => {
  it('treats a parent-file ENOTDIR as absence', async () => {
    await actual.writeFile(join(root as string, 'blocker'), 'x')
    await expect(requireAbsentEntry(join(root as string, 'blocker/child'), 'blocker/child')).resolves.toBeUndefined()
  })

  it('refuses with io when the entry probe fails beyond absence', async () => {
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('permission'), { code: 'EACCES' }))
    await expect(requireAbsentEntry(join(root as string, 'a.txt'), 'a.txt')).rejects.toMatchObject({ code: 'io' })
  })

  it('renders a non-Error probe failure in the io message', async () => {
    vi.mocked(lstat).mockRejectedValueOnce('plain rejection')
    await expect(requireAbsentEntry(join(root as string, 'a.txt'), 'a.txt'))
      .rejects.toMatchObject({ code: 'io', message: /plain rejection/u })
  })
})

describe('ensureIntermediateDirectory failure mapping', () => {
  it('accepts a racing creator whose directory appears between probe and mkdir', async () => {
    const target = join(root as string, 'raced')
    vi.mocked(lstat).mockImplementationOnce(async () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    })
    vi.mocked(mkdir).mockImplementationOnce(async (path) => {
      await actual.mkdir(path)
      throw Object.assign(new Error('file exists'), { code: 'EEXIST' })
    })
    await expect(ensureIntermediateDirectory(root as string, 'raced', 'raced/file.txt')).resolves.toBe(target)
  })

  it('refuses with changed when the racing occupant vanishes again', async () => {
    vi.mocked(lstat).mockImplementationOnce(async () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    })
    vi.mocked(mkdir).mockRejectedValueOnce(Object.assign(new Error('file exists'), { code: 'EEXIST' }))
    await expect(ensureIntermediateDirectory(root as string, 'ghost', 'ghost/file.txt'))
      .rejects.toMatchObject({ code: 'changed' })
  })

  it('refuses with io when mkdir fails beyond a collision', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(Object.assign(new Error('disk sleep'), { code: 'EIO' }))
    await expect(ensureIntermediateDirectory(root as string, 'bad', 'bad/file.txt'))
      .rejects.toMatchObject({ code: 'io', message: /disk sleep/u })
  })

  it('refuses with changed when the created directory vanishes before canonicalization', async () => {
    vi.mocked(realpath).mockImplementationOnce(async () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    })
    await expect(ensureIntermediateDirectory(root as string, 'vanish', 'vanish/file.txt'))
      .rejects.toMatchObject({ code: 'changed' })
  })

  it('refuses with io when canonicalization fails beyond absence', async () => {
    vi.mocked(realpath).mockImplementationOnce(async () => {
      throw Object.assign(new Error('file name too long'), { code: 'ENAMETOOLONG' })
    })
    await expect(ensureIntermediateDirectory(root as string, 'bad', 'bad/file.txt'))
      .rejects.toMatchObject({ code: 'io' })
  })

  it('refuses with symlink when the created directory resolves elsewhere', async () => {
    vi.mocked(realpath).mockImplementationOnce(async path => join(String(path), 'elsewhere'))
    await expect(ensureIntermediateDirectory(root as string, 'swapped', 'swapped/file.txt'))
      .rejects.toMatchObject({ code: 'symlink' })
  })
})

describe('createExclusiveDirectory failure mapping', () => {
  it('refuses with exists when mkdir loses a creation race', async () => {
    vi.mocked(mkdir).mockImplementationOnce(async (path) => {
      await actual.mkdir(path)
      throw Object.assign(new Error('file exists'), { code: 'EEXIST' })
    })
    await expect(createExclusiveDirectory(join(root as string, 'raced'), 'raced'))
      .rejects.toMatchObject({ code: 'exists' })
  })

  it('refuses with io when mkdir fails beyond a collision', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
    await expect(createExclusiveDirectory(join(root as string, 'full'), 'full'))
      .rejects.toMatchObject({ code: 'io', message: /no space left/u })
  })
})

describe('verifyCreatedEntry failure mapping', () => {
  it('refuses with symlink when the final file entry became a symbolic link', async () => {
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('too many levels of symbolic links'), { code: 'ELOOP' }))
    await expect(verifyCreatedEntry(join(root as string, 'a.txt'), 'a.txt', 'file'))
      .rejects.toMatchObject({ code: 'symlink' })
  })

  it('refuses with changed when the created file vanished before the no-follow open', async () => {
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    await expect(verifyCreatedEntry(join(root as string, 'a.txt'), 'a.txt', 'file'))
      .rejects.toMatchObject({ code: 'changed' })
  })

  it('refuses with io when the no-follow open fails beyond absence', async () => {
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('permission'), { code: 'EACCES' }))
    await expect(verifyCreatedEntry(join(root as string, 'a.txt'), 'a.txt', 'file'))
      .rejects.toMatchObject({ code: 'io' })
  })

  it('refuses with io when the no-follow descriptor cannot be inspected', async () => {
    const handle = {
      stat: async () => { throw new Error('stale handle') },
      close: async () => {},
    }
    vi.mocked(open).mockImplementationOnce(async () => handle as never)
    await expect(verifyCreatedEntry(join(root as string, 'a.txt'), 'a.txt', 'file'))
      .rejects.toMatchObject({ code: 'io', message: /stale handle/u })
  })

  it('refuses with changed when the no-follow descriptor names a non-file', async () => {
    const handle = {
      stat: async () => ({ dev: 1, ino: 1, isFile: () => false, isDirectory: () => true }),
      close: async () => {},
    }
    vi.mocked(open).mockImplementationOnce(async () => handle as never)
    await expect(verifyCreatedEntry(join(root as string, 'a.txt'), 'a.txt', 'file'))
      .rejects.toMatchObject({ code: 'changed' })
  })

  it('refuses with changed when the created directory vanished before verification', async () => {
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    await expect(verifyCreatedEntry(join(root as string, 'a'), 'a', 'directory'))
      .rejects.toMatchObject({ code: 'changed' })
  })

  it('refuses with symlink when the created directory entry became a symbolic link', async () => {
    await actual.writeFile(join(root as string, 'real.txt'), 'x')
    await actual.symlink(join(root as string, 'real.txt'), join(root as string, 'link.txt'))
    vi.mocked(lstat).mockImplementationOnce(async () => actual.lstat(join(root as string, 'link.txt')))
    await expect(verifyCreatedEntry(join(root as string, 'a'), 'a', 'directory'))
      .rejects.toMatchObject({ code: 'symlink' })
  })

  it('refuses with changed when the created directory entry names a non-directory', async () => {
    await actual.writeFile(join(root as string, 'plain.txt'), 'x')
    const info = await actual.lstat(join(root as string, 'plain.txt'))
    vi.mocked(lstat).mockImplementationOnce(async () => info)
    await expect(verifyCreatedEntry(join(root as string, 'a'), 'a', 'directory'))
      .rejects.toMatchObject({ code: 'changed' })
  })

  it('refuses with changed when the canonical stat of the verified entry fails', async () => {
    await actual.writeFile(join(root as string, 'a.txt'), '')
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    await expect(verifyCreatedEntry(join(root as string, 'a.txt'), 'a.txt', 'file'))
      .rejects.toMatchObject({ code: 'changed' })
  })

  it('refuses with changed when the canonical stat names a different object', async () => {
    await actual.writeFile(join(root as string, 'a.txt'), '')
    const info = await actual.stat(join(root as string, 'a.txt'))
    vi.mocked(stat).mockImplementationOnce(async () => ({ dev: info.dev, ino: info.ino + 1 }) as never)
    await expect(verifyCreatedEntry(join(root as string, 'a.txt'), 'a.txt', 'file'))
      .rejects.toMatchObject({ code: 'changed' })
  })

  it('verifies a freshly created file and directory', async () => {
    await actual.writeFile(join(root as string, 'a.txt'), '')
    await actual.mkdir(join(root as string, 'a'))
    await expect(verifyCreatedEntry(join(root as string, 'a.txt'), 'a.txt', 'file')).resolves.toBeUndefined()
    await expect(verifyCreatedEntry(join(root as string, 'a'), 'a', 'directory')).resolves.toBeUndefined()
  })
})
