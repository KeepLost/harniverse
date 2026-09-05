/**
 * Filesystem-real coverage for the Cordis-free spill store mechanics: locator
 * layout validation, cursor parsing bounds, corrupt UTF-8 artifacts, private
 * permission enforcement, directory-admission errors, and page-bound edges.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localLocator, readTextFile, saveTextFile, sessionDir } from '../src/store.ts'

let root: string
const TEST_SIGNAL = new AbortController().signal

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-spill-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function save(sessionId = 'sess-1', content = 'payload'): Promise<{ locator: string; path: string }> {
  const saved = await saveTextFile({ signal: TEST_SIGNAL, root, sessionId, suggestedName: 'r.txt', content })
  return { locator: localLocator(root, saved.path), path: saved.path }
}

describe('localLocator layout validation', () => {
  it('rejects paths that escape the two-level session layout', () => {
    expect(() => localLocator(root, join(root, 'loose.txt'))).toThrow('outside the expected session layout')
    expect(() => localLocator(root, join(root, 'session-abc123def4567890', 'a', 'b.txt'))).toThrow('outside the expected session layout')
    expect(() => localLocator(root, join(root, 'notsession-abc123def4567890', 'f.txt'))).toThrow('outside the expected session layout')
    expect(() => localLocator(root, join(root, 'session-abc', 'f.txt'))).toThrow('outside the expected session layout')
  })
})

describe('readTextFile validation edges', () => {
  it('rejects malformed cursors', async () => {
    const { locator } = await save()
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, cursor: 'junk', maxChars: 10 }))
      .rejects.toThrow('invalid local spill cursor')
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, cursor: 'v1:x', maxChars: 10 }))
      .rejects.toThrow('invalid local spill cursor')
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, cursor: 'v1:-1', maxChars: 10 }))
      .rejects.toThrow('invalid local spill cursor')
  })

  it('rejects page bounds outside the supported range', async () => {
    const { locator } = await save()
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, maxChars: 0 }))
      .rejects.toThrow('spill read maxChars must be an integer from 1 to 50000')
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, maxChars: 50_001 }))
      .rejects.toThrow('spill read maxChars must be an integer from 1 to 50000')
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, maxChars: 2.5 }))
      .rejects.toThrow('spill read maxChars must be an integer from 1 to 50000')
  })

  it('rejects a locator that names a directory', async () => {
    await save()
    mkdirSync(join(sessionDir(root, 'sess-1'), 'sub.dir'), { mode: 0o700 })
    const dirLocator = localLocator(root, join(sessionDir(root, 'sess-1'), 'sub.dir'))
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator: dirLocator, maxChars: 10 }))
      .rejects.toThrow('does not identify a regular file')
  })

  it('rejects a cursor beyond the artifact and returns an empty final page', async () => {
    const { locator } = await save('sess-1', 'hello')
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, cursor: 'v1:999999', maxChars: 10 }))
      .rejects.toThrow('cursor exceeds artifact length')
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, cursor: 'v1:5', maxChars: 10 }))
      .resolves.toEqual({ text: '' })
  })

  it('trims a code point cut by the byte bound when the artifact continues', async () => {
    const { locator } = await save('sess-1', `ab${'😀'.repeat(3)}`)
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, maxChars: 1 }))
      .resolves.toEqual({ text: 'a', nextCursor: 'v1:1' })
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, cursor: 'v1:2', maxChars: 1 }))
      .resolves.toEqual({ text: '😀', nextCursor: 'v1:6' })
  })

  it('rejects artifacts that are not valid UTF-8', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'corrupt-all.txt'), Buffer.from([0xff, 0xff, 0xff, 0xff]))
    writeFileSync(join(dir, 'corrupt-tail.txt'), Buffer.from([0x41, 0x80, 0x80, 0x80]))
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator: localLocator(root, join(dir, 'corrupt-all.txt')), maxChars: 100 }))
      .rejects.toThrow('stored spill artifact is not valid UTF-8')
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator: localLocator(root, join(dir, 'corrupt-tail.txt')), maxChars: 100 }))
      .rejects.toThrow('stored spill artifact is not valid UTF-8')
  })

  it('rejects reads when the configured root does not exist', async () => {
    const { locator } = await save()
    await expect(readTextFile({ signal: TEST_SIGNAL, root: join(root, 'missing'), locator, maxChars: 10 }))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('private directory permissions', () => {
  // POSIX mode bits gate these rejections; the store skips the check on win32.
  it.skipIf(process.platform === 'win32')('rejects saves when the root grants group or world access', async () => {
    await save()
    chmodSync(root, 0o755)
    await expect(saveTextFile({ signal: TEST_SIGNAL, root, sessionId: 'sess-2', suggestedName: 'r.txt', content: 'x' }))
      .rejects.toThrow('must not grant group or world access')
  })

  it.skipIf(process.platform === 'win32')('rejects reads when the session directory grants group or world access', async () => {
    const { locator } = await save()
    chmodSync(sessionDir(root, 'sess-1'), 0o755)
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator, maxChars: 10 }))
      .rejects.toThrow('must not grant group or world access')
  })
})

describe('saveTextFile directory admission', () => {
  it('creates a nested configured root one component at a time', async () => {
    const nested = join(root, 'deep', 'spill')
    const saved = await saveTextFile({ signal: TEST_SIGNAL, root: nested, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' })
    expect(saved.path.startsWith(nested)).toBe(true)
  })
})
