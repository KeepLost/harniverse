/**
 * Containment-rule specs over the real filesystem: registered-root liveness,
 * lexical gates (NUL, `.git`, escape), realpath identity (symlink refusal),
 * tolerant absent canonicalization, and the io arms (oversized path).
 */
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalTarget, canonicalTargetTolerant, containedRoot, hasGitSegment, lexicalContainedPath,
} from '../src/containment.ts'

let root: string | undefined

beforeEach(async () => {
  // The registered root is canonical by contract; macOS tmpdir() sits behind the /var -> /private/var link.
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-wfw-containment-')))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('lexicalContainedPath', () => {
  it('refuses NUL bytes, absolute paths, escapes, and .git segments', () => {
    expect(() => lexicalContainedPath(root as string, 'a\0b')).toThrowError(/must be relative/u)
    expect(() => lexicalContainedPath(root as string, '/etc/passwd')).toThrowError(/must be relative/u)
    expect(() => lexicalContainedPath(root as string, '../outside.txt')).toThrowError(/escapes the workspace/u)
    expect(() => lexicalContainedPath(root as string, 'sub/.git/config')).toThrowError(/repository metadata/u)
    expect(hasGitSegment('.git')).toBe(true)
    expect(hasGitSegment('git/config')).toBe(false)
    expect(lexicalContainedPath(root as string, 'a/../b.txt')).toBe(join(root ?? '.', 'b.txt'))
  })
})

describe('containedRoot', () => {
  it('refuses a registered root that no longer resolves', async () => {
    const missing = join(root as string, 'gone')
    await expect(containedRoot(missing, 'a.txt')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses a registered root that is no longer canonical', async () => {
    const linked = join(root as string, 'linked-root')
    // The symlink resolves elsewhere, which differs from the registered spelling.
    await symlink(root as string, linked)
    await expect(containedRoot(linked, 'a.txt')).rejects.toMatchObject({ code: 'path-invalid' })
  })

  it('resolves the canonical root and a contained target', async () => {
    const contained = await containedRoot(root as string, 'sub/file.txt')
    expect(contained.root).toBe(root)
    expect(contained.target).toBe(join(root as string, 'sub/file.txt'))
  })
})

describe('canonicalTarget', () => {
  it('refuses a symlinked final spelling', async () => {
    await writeFile(join(root as string, 'real.txt'), 'x')
    await symlink(join(root as string, 'real.txt'), join(root as string, 'link.txt'))
    const contained = await containedRoot(root as string, 'link.txt')
    await expect(canonicalTarget(contained)).rejects.toMatchObject({ code: 'symlink' })
    // The tolerant variant rethrows the same typed refusal.
    await expect(canonicalTargetTolerant(contained)).rejects.toMatchObject({ code: 'symlink' })
  })

  it('reports a missing entry as absent through the tolerant variant', async () => {
    const contained = await containedRoot(root as string, 'missing.txt')
    await expect(canonicalTarget(contained)).rejects.toMatchObject({ code: 'not-found' })
    await expect(canonicalTargetTolerant(contained)).resolves.toBeUndefined()
  })

  it('refuses an unresolvable path with the io code', async () => {
    // A path beyond the kernel name limit fails realpath with ENAMETOOLONG,
    // which is neither absent nor a permission fault.
    const long = 'x'.repeat(300)
    const segments = Array.from({ length: 40 }, () => long).join('/')
    const contained = await containedRoot(root as string, segments)
    await expect(canonicalTarget(contained)).rejects.toMatchObject({ code: 'io' })
  })
})
