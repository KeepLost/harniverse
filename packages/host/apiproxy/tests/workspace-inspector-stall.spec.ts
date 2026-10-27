/**
 * WorkspaceStallGuard: the watchdog abandons an operation whose filesystem
 * promises never settle, strikes accumulate per root into a cooldown that
 * fails fast without touching the filesystem, and a healthy operation after
 * the cooldown reopens the root. The inspector operations run under the guard
 * and surface its failures as structured WorkspaceInspectorError codes.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceInspectorError,
  WorkspaceStallGuard,
  listWorkspaceFiles,
  readWorkspaceFile,
} from '../src/workspace-inspector.ts'

const never = (): Promise<never> => new Promise<never>(() => {})

describe('WorkspaceStallGuard watchdog', () => {
  it('resolves a settled operation and rejects its error unchanged', async () => {
    const guard = new WorkspaceStallGuard({ timeoutMs: 10 })
    await expect(guard.run('/r', 'p', new AbortController().signal, async () => 'ok')).resolves.toBe('ok')
    await expect(guard.run('/r', 'p', new AbortController().signal, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
  })

  it('abandons a stalled operation with the stall code and records a strike', async () => {
    const guard = new WorkspaceStallGuard({ timeoutMs: 5 })
    await expect(guard.run('/r', 'p', new AbortController().signal, never)).rejects.toMatchObject({
      code: 'workspace-entry-stalled',
    })
  })

  it('rejects an already-aborted caller signal before starting', async () => {
    const guard = new WorkspaceStallGuard({ timeoutMs: 10 })
    const controller = new AbortController()
    controller.abort()
    const op = vi.fn(async () => 'ok')
    await expect(guard.run('/r', 'p', controller.signal, op)).rejects.toMatchObject({ name: 'AbortError' })
    expect(op).not.toHaveBeenCalled()
  })
})

describe('WorkspaceStallGuard breaker', () => {
  it('fails fast after three strikes inside the window, without touching the filesystem', async () => {
    const clock = { now: 0 }
    const guard = new WorkspaceStallGuard({ timeoutMs: 0, now: () => clock.now })
    for (let index = 0; index < 3; index++) {
      await expect(guard.run('/r', 'p', new AbortController().signal, never)).rejects.toMatchObject({
        code: 'workspace-entry-stalled',
      })
      clock.now += 1
    }
    const op = vi.fn(never)
    await expect(guard.run('/r', 'p', new AbortController().signal, op)).rejects.toMatchObject({
      code: 'workspace-root-stalled',
    })
    expect(op).not.toHaveBeenCalled()
  })

  it('keeps a second root fully independent', async () => {
    const guard = new WorkspaceStallGuard({ timeoutMs: 0 })
    for (let index = 0; index < 3; index++) {
      await expect(guard.run('/a', 'p', new AbortController().signal, never)).rejects.toMatchObject({
        code: 'workspace-entry-stalled',
      })
    }
    await expect(guard.run('/b', 'p', new AbortController().signal, async () => 'ok')).resolves.toBe('ok')
    await expect(guard.run('/a', 'p', new AbortController().signal, never)).rejects.toMatchObject({
      code: 'workspace-root-stalled',
    })
  })

  it('reopens the root after the cooldown and a healthy probe keeps it open', async () => {
    const clock = { now: 0 }
    const guard = new WorkspaceStallGuard({ timeoutMs: 0, now: () => clock.now })
    for (let index = 0; index < 3; index++) {
      await expect(guard.run('/r', 'p', new AbortController().signal, never)).rejects.toMatchObject({
        code: 'workspace-entry-stalled',
      })
      clock.now += 1
    }
    clock.now += 30_001
    await expect(guard.run('/r', 'p', new AbortController().signal, async () => 'ok')).resolves.toBe('ok')
    await expect(guard.run('/r', 'p', new AbortController().signal, async () => 'ok')).resolves.toBe('ok')
  })

  it('ages strikes out of the rolling window', async () => {
    const clock = { now: 0 }
    const guard = new WorkspaceStallGuard({ timeoutMs: 0, now: () => clock.now })
    await expect(guard.run('/r', 'p', new AbortController().signal, never)).rejects.toMatchObject({
      code: 'workspace-entry-stalled',
    })
    clock.now += 60_001
    await expect(guard.run('/r', 'p', new AbortController().signal, never)).rejects.toMatchObject({
      code: 'workspace-entry-stalled',
    })
    // Only one strike is live; the root stays out of cooldown.
    await expect(guard.run('/r', 'p', new AbortController().signal, async () => 'ok')).resolves.toBe('ok')
  })
})

describe('inspector operations under the guard', () => {
  it('reads a real file unchanged through the shared-guard seam', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stall-ok-')))
    try {
      writeFileSync(join(root, 'note.md'), 'first\n')
      const preview = await readWorkspaceFile(root, 'note.md', new AbortController().signal, {}, new WorkspaceStallGuard({ timeoutMs: 2_000 }))
      expect(preview.content).toBe('first\n')
    } finally {
      const { rmSync } = await import('node:fs')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('surfaces the open breaker as a structured error before any filesystem work', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stall-open-')))
    try {
      mkdirSync(join(root, 'sub'))
      const guard = new WorkspaceStallGuard({ timeoutMs: 0 })
      for (let index = 0; index < 3; index++) {
        await expect(guard.run(root, 'p', new AbortController().signal, never)).rejects.toBeInstanceOf(WorkspaceInspectorError)
      }
      await expect(readWorkspaceFile(root, 'sub', new AbortController().signal, {}, guard)).rejects.toMatchObject({
        code: 'workspace-root-stalled',
      })
      await expect(listWorkspaceFiles(root, '.', new AbortController().signal, guard)).rejects.toMatchObject({
        code: 'workspace-root-stalled',
      })
    } finally {
      const { rmSync } = await import('node:fs')
      rmSync(root, { recursive: true, force: true })
    }
  })
})
