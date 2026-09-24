/** Native Windows ownership: process-tree termination must work with no tools on PATH. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { spawnSubprocess } from '../src/spawn.ts'
import { createWindowsProcessInspector } from '../src/windows-inspector.ts'
import type { ProcessIdentity } from '../src/process-inspector.ts'

describe.skipIf(process.platform !== 'win32')('Windows process trees without PATH', () => {
  it.each(['subprocess', 'inspector'] as const)('%s kills and joins the root and its descendant', { timeout: 15000 }, async (owner) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-empty-path-tree-'))
    const stateFile = join(root, 'tree.json')
    const inspector = createWindowsProcessInspector()
    const systemRoot = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1]
    expect(systemRoot).toBeDefined()
    const utility = win32.join(systemRoot!, 'System32', 'taskkill.exe')
    // Exercise lookup in the provider's environment, not merely its child's env option.
    vi.stubEnv('PATH', '')
    let handle: ReturnType<typeof spawnSubprocess> | undefined
    let identities: ProcessIdentity[] = []
    try {
      handle = spawnSubprocess({
        argv: [process.execPath, fileURLToPath(new URL('./fixtures/managed-tree.ts', import.meta.url)), stateFile],
        cwd: root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      })
      const state = await vi.waitFor(async () => JSON.parse(await readFile(stateFile, 'utf8')) as { root: number; descendant: number },
        { interval: 10, timeout: 5000 })
      expect(state.root).toBe(handle.pid)
      expect(state.descendant).not.toBe(state.root)
      identities = inspector.snapshot().tree(state.root).filter(member => [state.root, state.descendant].includes(member.pid))
      expect(identities).toHaveLength(2)
      expect(identities.every(identity => inspector.isAlive(identity))).toBe(true)
      if (owner === 'subprocess') handle.terminate()
      else inspector.signalGroup(handle.pid, 'SIGKILL')
      expect(await handle.waitForExit(AbortSignal.timeout(5000)), 'the process root must exit after tree termination').toBe(true)
      await handle.done
      await vi.waitFor(() => { expect(identities.some(identity => inspector.isAlive(identity))).toBe(false) },
        { interval: 10, timeout: 2000 })
    } finally {
      vi.unstubAllEnvs()
      // Independent absolute cleanup also contains a regression of the production resolver.
      if (identities.length === 0 && handle) {
        spawnSync(utility, ['/PID', String(handle.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
      for (const identity of identities) {
        if (inspector.isAlive(identity)) spawnSync(utility, ['/PID', String(identity.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
      await handle?.done
      await rm(root, { recursive: true, force: true })
    }
  })
})
