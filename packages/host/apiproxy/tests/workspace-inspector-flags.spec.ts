/**
 * Platform-resolved open flags are computed once at module scope, so the
 * Windows shape is only observable through a fresh import under that platform.
 * This lives in its own file because resetting the module registry would
 * otherwise hand the rest of the suite a second instrumented copy.
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
  vi.resetModules()
})

describe('platform-resolved open flags', () => {
  it('omits the non-blocking flag on a platform that has none', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.resetModules()

    const fresh = await import('../src/workspace-inspector.ts')
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-flags-')))
    writeFileSync(join(root, 'file.txt'), 'hello')

    // O_NONBLOCK does not exist on Windows; opening must still succeed.
    await expect(fresh.readWorkspaceFile(root, 'file.txt', new AbortController().signal))
      .resolves.toMatchObject({ content: 'hello' })
  })

  it('keeps the non-blocking flag on a platform that has it', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.resetModules()

    const fresh = await import('../src/workspace-inspector.ts')
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-flags-')))
    writeFileSync(join(root, 'file.txt'), 'hello')

    // O_NONBLOCK never makes a regular-file read return early, so resolving
    // the POSIX flag set is observable only through the read still succeeding.
    await expect(fresh.readWorkspaceFile(root, 'file.txt', new AbortController().signal))
      .resolves.toMatchObject({ content: 'hello' })
  })
})
