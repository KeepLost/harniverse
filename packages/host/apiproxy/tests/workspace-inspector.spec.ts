import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  workspaceGitCommits,
  workspaceGitDiff,
  workspaceGitStatus,
} from '../src/workspace-inspector.ts'

const execFileAsync = promisify(execFile)

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-workspace-inspector-'))
}

describe('workspace file inspection', () => {
  it('lists every immediate entry, including hidden directories', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, '.hidden'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'README.md'), 'hello')

    const result = await listWorkspaceFiles(root, '.', new AbortController().signal)

    expect(result.entries.map(entry => entry.name)).toEqual(['.hidden', 'node_modules', 'README.md'])
    expect(result.truncated).toBe(false)
  })

  it('rejects canonical paths that escape through a symlink', async () => {
    const root = tempWorkspace()
    const outside = tempWorkspace()
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, join(root, 'escape'), 'dir')

    await expect(readWorkspaceFile(root, 'escape/secret.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-path-invalid' })
  })

  it('bounds file content without splitting UTF-8 code points', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'large.txt'), `${'a'.repeat(1024 * 1024 - 1)}😀tail`)

    const result = await readWorkspaceFile(root, 'large.txt', new AbortController().signal)

    expect(result.truncated).toBe(true)
    expect(result.content.endsWith('�')).toBe(false)
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe('workspace git inspection', () => {
  it('returns workspace-scoped status, commits, and bounded diffs', async () => {
    const root = tempWorkspace()
    await execFileAsync('git', ['init', root])
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Inspector Test'])
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'inspector@example.invalid'])
    writeFileSync(join(root, 'tracked.txt'), 'first\n')
    await execFileAsync('git', ['-C', root, 'add', '--', 'tracked.txt'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'initial'])
    writeFileSync(join(root, 'tracked.txt'), `first\n${'changed\n'.repeat(200_000)}`)
    writeFileSync(join(root, 'untracked.txt'), 'new\n')

    const signal = new AbortController().signal
    const status = await workspaceGitStatus(root, signal)
    const commits = await workspaceGitCommits(root, 10, signal)
    const diff = await workspaceGitDiff(root, undefined, false, signal)

    expect(status.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', worktreeStatus: 'M' }),
      expect.objectContaining({ path: 'untracked.txt', indexStatus: '?', worktreeStatus: '?' }),
    ]))
    expect(commits.commits[0]).toMatchObject({ subject: 'initial', authorName: 'Inspector Test' })
    expect(diff.diff).toContain('tracked.txt')
    expect(diff.truncated).toBe(true)
    expect(Buffer.byteLength(diff.diff)).toBeLessThanOrEqual(1024 * 1024)
  })

  it('honors an already-aborted signal before starting Git', async () => {
    const abort = new AbortController()
    abort.abort(new Error('cancelled by caller'))

    await expect(workspaceGitStatus(tempWorkspace(), abort.signal)).rejects.toThrow('cancelled by caller')
  })
})
