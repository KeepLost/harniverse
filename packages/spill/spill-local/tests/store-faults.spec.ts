/**
 * Fault-injection coverage for the spill store's defensive filesystem checks:
 * divergent lstat observations (races), ownership and platform-alias handling,
 * directory-admission failures, symlink escapes that only realpath can catch,
 * and degenerate file-handle reads. Mocks stay passthrough unless scripted.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { localLocator, readTextFile, saveTextFile, sessionDir } from '../src/store.ts'

interface FakeStat {
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
  isFile: () => boolean
  uid: number
  mode: number
}

const script = vi.hoisted(() => ({
  lstatError: undefined as NodeJS.ErrnoException | undefined,
  lstatPaths: [] as string[],
  fakeDirFor: undefined as string | undefined,
  fakeDirUid: undefined as number | undefined,
  fakeDirUnderPrivate: false,
  fileAfter: undefined as { path: string; calls: number } | undefined,
  lstatCalls: new Map<string, number>(),
  enoentOnce: undefined as string | undefined,
  mkdirError: undefined as { pathIncludes: string; error: NodeJS.ErrnoException } | undefined,
  openHandle: undefined as object | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const dirStat = (uid: number): FakeStat => ({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isFile: () => false,
    uid,
    mode: 0o700,
  })
  const fileStat = (): FakeStat => ({
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFile: () => true,
    uid: process.getuid?.() ?? 0,
    mode: 0o600,
  })
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      script.lstatPaths.push(path)
      if (script.lstatError !== undefined) throw script.lstatError
      if (script.fakeDirFor !== undefined && path === script.fakeDirFor) {
        return dirStat(script.fakeDirUid ?? process.getuid?.() ?? 0) as never
      }
      if (script.fakeDirUnderPrivate && (path === '/private' || path.startsWith('/private/'))) {
        return dirStat(process.getuid?.() ?? 0) as never
      }
      if (script.enoentOnce !== undefined && path === script.enoentOnce) {
        script.enoentOnce = undefined
        throw ioError('ENOENT')
      }
      if (script.fileAfter !== undefined && path === script.fileAfter.path) {
        const calls = (script.lstatCalls.get(path) ?? 0) + 1
        script.lstatCalls.set(path, calls)
        if (calls > script.fileAfter.calls) return fileStat() as never
      }
      return await actual.lstat(...args)
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (script.mkdirError !== undefined && String(args[0]).includes(script.mkdirError.pathIncludes)) {
        throw script.mkdirError.error
      }
      return await actual.mkdir(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (script.openHandle !== undefined) return script.openHandle as never
      return await actual.open(...args)
    },
  }
})

const TEST_SIGNAL = new AbortController().signal
const ioError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`simulated ${code}`), { code })
const platform = Object.getOwnPropertyDescriptor(process, 'platform')

let root: string
const extras: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-spill-fault-'))
})
afterEach(() => {
  script.lstatError = undefined
  script.lstatPaths = []
  script.fakeDirFor = undefined
  script.fakeDirUid = undefined
  script.fakeDirUnderPrivate = false
  script.fileAfter = undefined
  script.lstatCalls = new Map()
  script.enoentOnce = undefined
  script.mkdirError = undefined
  script.openHandle = undefined
  if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
  rmSync(root, { recursive: true, force: true })
  for (const path of extras.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('spill store fault injection', () => {
  it('propagates non-missing lstat failures from directory admission', async () => {
    script.lstatError = ioError('EACCES')
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator: 'local-spill:v1:0123456789ab/f.txt', maxChars: 10 }))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rejects a root that stops being a real directory between checks', async () => {
    script.fileAfter = { path: root, calls: 1 }
    await expect(saveTextFile({ signal: TEST_SIGNAL, root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' }))
      .rejects.toThrow('spill root must be a real directory')
  })

  it('rejects storage directories owned by another user', async () => {
    if (typeof process.getuid !== 'function') return
    script.fakeDirFor = root
    script.fakeDirUid = process.getuid() + 1
    await expect(saveTextFile({ signal: TEST_SIGNAL, root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' }))
      .rejects.toThrow('spill root must be owned by the current user')
  })

  it('canonicalizes the macOS system aliases when admitting directories', async () => {
    if (!root.startsWith('/tmp') && !root.startsWith('/var')) return
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    script.fakeDirUnderPrivate = true
    const saved = await saveTextFile({ signal: TEST_SIGNAL, root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' })
    expect(script.lstatPaths.some(path => path.startsWith('/private/'))).toBe(true)
    expect(saved.path.startsWith(root)).toBe(true)
    expect(saved.bytes).toBe(1)
  })

  it('rejects a session directory whose real path escapes the configured root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-spill-outside-'))
    extras.push(outside)
    const dir = sessionDir(root, 'sess-1')
    symlinkSync(outside, dir, 'dir')
    writeFileSync(join(outside, 'escaped.txt'), 'host secret')
    script.fakeDirFor = dir
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator: localLocator(root, join(dir, 'escaped.txt')), maxChars: 10 }))
      .rejects.toThrow('spill session directory is outside the configured root')
  })

  it('tolerates a directory that appears between the missing probe and creation', async () => {
    const nested = join(root, 'a')
    mkdirSync(nested, { mode: 0o700 })
    script.enoentOnce = nested
    const saved = await saveTextFile({ signal: TEST_SIGNAL, root: nested, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' })
    expect(saved.path.startsWith(nested)).toBe(true)
  })

  it('propagates a non-EEXIST failure while creating a path component', async () => {
    script.mkdirError = { pathIncludes: basename(root), error: ioError('EACCES') }
    const nested = join(root, 'spill')
    await expect(saveTextFile({ signal: TEST_SIGNAL, root: nested, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' }))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('propagates a non-EEXIST failure while creating the session directory', async () => {
    script.mkdirError = { pathIncludes: 'session-', error: ioError('EACCES') }
    await expect(saveTextFile({ signal: TEST_SIGNAL, root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' }))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rejects when the byte at the cursor cannot be read', async () => {
    mkdirSync(join(root, 'session-0123456789ab'), { recursive: true, mode: 0o700 })
    script.openHandle = {
      stat: async () => ({ size: 10, isFile: () => true }),
      read: async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }),
      close: async () => {},
    }
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator: 'local-spill:v1:0123456789ab/f.txt', maxChars: 10 }))
      .rejects.toThrow('local spill cursor could not be read')
  })

  it('stops at a short read and reports the unchanged cursor', async () => {
    mkdirSync(join(root, 'session-0123456789ab'), { recursive: true, mode: 0o700 })
    script.openHandle = {
      stat: async () => ({ size: 10, isFile: () => true }),
      read: async (buffer: Buffer, _offset: number, length: number, position: number) => {
        if (position === 0 && length === 1) {
          buffer[0] = 0x41
          return { bytesRead: 1, buffer }
        }
        return { bytesRead: 0, buffer }
      },
      close: async () => {},
    }
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator: 'local-spill:v1:0123456789ab/f.txt', maxChars: 10 }))
      .resolves.toEqual({ text: '', nextCursor: 'v1:0' })
  })
})
