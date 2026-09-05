/**
 * Darwin /var and /tmp alias canonicalization exercised without a POSIX host:
 * POSIX path semantics stand in for node:path so the `/private` rewrite and
 * its component walk run identically on every platform. Every filesystem
 * observation is scripted, so no host directory shapes are required.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTextFile } from '../src/store.ts'

const script = vi.hoisted(() => ({
  lstatPaths: [] as string[],
  openHandle: undefined as object | undefined,
}))

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  const posix = actual.posix
  return {
    ...actual,
    dirname: (...args: Parameters<typeof posix.dirname>) => posix.dirname(...args),
    join: (...args: Parameters<typeof posix.join>) => posix.join(...args),
    parse: (...args: Parameters<typeof posix.parse>) => posix.parse(...args),
    relative: (...args: Parameters<typeof posix.relative>) => posix.relative(...args),
    resolve: (...args: Parameters<typeof posix.resolve>) => posix.resolve(...args),
    sep: posix.sep,
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      script.lstatPaths.push(path)
      return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        isFile: () => false,
        uid: process.getuid?.() ?? 0,
        mode: 0o700,
      } as never
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => String(args[0]),
    open: async (...args: Parameters<typeof actual.open>) => {
      if (script.openHandle !== undefined) return script.openHandle as never
      return await actual.open(...args)
    },
  }
})

const TEST_SIGNAL = new AbortController().signal
const platform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  script.lstatPaths = []
  script.openHandle = undefined
  if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
})

describe('spill store darwin alias canonicalization', () => {
  it('walks the canonicalized /private prefix on every platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    script.openHandle = {
      stat: async () => ({ size: 0, isFile: () => true }),
      read: async () => ({ bytesRead: 0 }),
      close: async () => {},
    }
    await expect(readTextFile({
      signal: TEST_SIGNAL,
      root: '/var/dsh-spill-alias',
      locator: 'local-spill:v1:0123456789ab/f.txt',
      maxChars: 10,
    })).resolves.toEqual({ text: '' })
    expect(script.lstatPaths).toContain('/private/var/dsh-spill-alias')
    expect(script.lstatPaths).toContain('/var/dsh-spill-alias')
  })
})
