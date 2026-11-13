/** Boot-time host workspace import: the walk, the bound, and the memory pairing. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HOST_IMPORT_MAX_BYTES,
  HOST_IMPORT_MAX_BYTES_ENV,
  importMemoryMiB,
  packHostWorkspace,
  resolveHostImportMaxBytes,
  scanHostWorkspace,
} from '../src/host-import.ts'
import { readWorkspaceTar } from '../src/workspace.ts'
import { HostWorkspaceTooLargeError } from '../src/errors-host-import.ts'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-host-import-'))
  dirs.push(dir)
  return dir
}

/** A small project-like tree: nested dirs, files, one symlink, deterministic names. */
function seededRoot(): string {
  const root = tempRoot()
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'src', 'deep'))
  writeFileSync(join(root, 'a.txt'), 'alpha')
  writeFileSync(join(root, 'src', 'b.ts'), 'beta')
  writeFileSync(join(root, 'src', 'deep', 'c.md'), 'gamma')
  symlinkSync(join(root, 'a.txt'), join(root, 'src', 'link-to-a'))
  return root
}

describe('resolveHostImportMaxBytes', () => {
  it('prefers the explicit option, then the env override, then the default', () => {
    expect(resolveHostImportMaxBytes(7)).toBe(7)
    vi.stubEnv(HOST_IMPORT_MAX_BYTES_ENV, '4096')
    expect(resolveHostImportMaxBytes(undefined)).toBe(4096)
    expect(resolveHostImportMaxBytes(7)).toBe(7)
    vi.stubEnv(HOST_IMPORT_MAX_BYTES_ENV, '  ')
    expect(resolveHostImportMaxBytes(undefined)).toBe(DEFAULT_HOST_IMPORT_MAX_BYTES)
  })

  it('rejects non-positive or non-integer env values loudly', () => {
    for (const bad of ['0', '-1', '1.5', 'soon']) {
      vi.stubEnv(HOST_IMPORT_MAX_BYTES_ENV, bad)
      expect(() => resolveHostImportMaxBytes(undefined), bad).toThrow(HOST_IMPORT_MAX_BYTES_ENV)
    }
  })
})

describe('scanHostWorkspace', () => {
  it('sums file bytes without counting irregular entries', async () => {
    expect(await scanHostWorkspace(seededRoot())).toBe('alpha'.length + 'beta'.length + 'gamma'.length)
  })

  it('answers zero for an empty root', async () => {
    expect(await scanHostWorkspace(tempRoot())).toBe(0)
  })
})

describe('packHostWorkspace', () => {
  it('packs files and directories deterministically and skips symlinks with a count', async () => {
    const root = seededRoot()
    const packed = await packHostWorkspace(root)
    expect(packed.bytes).toBe('alpha'.length + 'beta'.length + 'gamma'.length)
    expect(packed.skippedIrregular).toBe(1)
    expect(readWorkspaceTar(packed.tar).map(entry => entry.path)).toEqual([
      'a.txt',
      'src',
      'src/b.ts',
      'src/deep',
      'src/deep/c.md',
    ])
    const again = await packHostWorkspace(root)
    expect(again.tar.equals(packed.tar)).toBe(true)
  })

  it('fails closed with both sizes named when the walk passes the bound', async () => {
    const root = seededRoot()
    const bound = 'alpha'.length + 'beta'.length - 1
    await expect(packHostWorkspace(root, { maxBytes: bound })).rejects.toMatchObject({
      name: 'HostWorkspaceTooLargeError',
      root,
      maxBytes: bound,
    })
    expect(() => { throw new HostWorkspaceTooLargeError('/r', 5, 4) }).toThrow('/r carries 5 bytes')
  })
})

describe('importMemoryMiB', () => {
  it('keeps the configured floor and scales with the payload', () => {
    expect(importMemoryMiB(0, 512)).toBe(512)
    expect(importMemoryMiB(100 * 1024 * 1024, 256)).toBe(456)
    expect(importMemoryMiB(100 * 1024 * 1024, 1024)).toBe(1024)
    expect(importMemoryMiB(1, 256)).toBe(258)
  })
})
