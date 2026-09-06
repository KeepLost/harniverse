import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { WORKSPACE_DIFF_BYTE_LIMIT, workspaceGitDiff } = await import('../src/workspace-inspector')

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed = false

  kill(): void {
    this.killed = true
    this.emit('close', null)
  }
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('workspace Git overflow bounds', () => {
  it('truncates and kills Git when stdout keeps delivering after the byte bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inspector-overflow-'))
    const gitDir = join(root, '.git')
    mkdirSync(gitDir)
    let diffChild: FakeChild | undefined
    spawnMock.mockImplementation((_command: string, args: readonly string[]) => {
      const child = new FakeChild()
      if (args.includes('rev-parse')) {
        const isGitDirectory = args.includes('--absolute-git-dir')
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(`${isGitDirectory ? gitDir : root}\n`))
          child.emit('close', 0)
        })
      } else {
        diffChild = child
      }
      return child as unknown as ChildProcess
    })

    const pending = workspaceGitDiff(root, undefined, false, new AbortController().signal)
    await vi.waitFor(() => {
      if (diffChild === undefined) throw new Error('the diff child was not spawned')
    })
    // The wait above proves assignment; the compiler cannot track closure writes.
    const child = diffChild as FakeChild

    // The first chunk fills the bound exactly; the second arrives only after
    // the buffer is full, so the collector must drop it, flag the overflow,
    // and kill the process instead of buffering past the bound.
    const bound = WORKSPACE_DIFF_BYTE_LIMIT + 64 * 1024
    child.stdout.emit('data', Buffer.alloc(bound, 0x61))
    child.stdout.emit('data', Buffer.from('delivered-after-the-bound'))

    const result = await pending
    expect(result.truncated).toBe(true)
    expect(result.diff).toBe('a'.repeat(WORKSPACE_DIFF_BYTE_LIMIT))
    expect(child.killed).toBe(true)
  })
})
