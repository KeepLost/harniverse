import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_BINARY_BYTE_LIMIT,
  WORKSPACE_FILE_SEARCH_RESULT_LIMIT,
  WORKSPACE_FILE_SEARCH_SCAN_LIMIT,
  listWorkspaceFiles,
  openedPathInfo,
  readIntoBuffer,
  readWorkspaceBinary,
  readWorkspaceFile,
  searchWorkspaceFiles,
  workspaceGitCommits,
  workspaceGitDiff,
  workspaceGitStatus,
} from '../src/workspace-inspector.ts'

const execFileAsync = promisify(execFile)

function tempWorkspace(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-inspector-')))
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

  it('rejects file reads through symbolic links within the workspace', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'target.txt'), 'inside')
    symlinkSync(join(root, 'target.txt'), join(root, 'alias.txt'), 'file')

    await expect(readWorkspaceFile(root, 'alias.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-path-invalid' })
  })

  it.skipIf(process.platform === 'win32')('rejects FIFOs without blocking the Host filesystem pool', async () => {
    const root = tempWorkspace()
    await execFileAsync('mkfifo', [join(root, 'pipe.txt')])

    await expect(readWorkspaceFile(root, 'pipe.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-entry-type-invalid' })
  })

  it('bounds file content without splitting UTF-8 code points', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'large.txt'), `${'a'.repeat(1024 * 1024 - 1)}😀tail`)

    const result = await readWorkspaceFile(root, 'large.txt', new AbortController().signal)

    expect(result.truncated).toBe(true)
    expect(result.content.endsWith('�')).toBe(false)
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(1024 * 1024)
  })

  it('searches nested regular-file names without following symlinks', async () => {
    const root = tempWorkspace()
    const nested = join(root, 'src')
    mkdirSync(nested)
    writeFileSync(join(nested, 'Workbench.tsx'), 'export {}')
    symlinkSync(root, join(nested, 'loop'), 'dir')

    const result = await searchWorkspaceFiles(root, 'workbench', new AbortController().signal)

    expect(result).toEqual({
      entries: [{ name: 'Workbench.tsx', path: 'src/Workbench.tsx', kind: 'file' }],
      truncated: false,
    })
  })

  it('scopes file-name search with include/exclude globs and applies default skips', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'tests'))
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'src', 'main.py'), '')
    writeFileSync(join(root, 'src', 'main.ts'), '')
    writeFileSync(join(root, 'tests', 'main.py'), '')
    writeFileSync(join(root, 'dist', 'main.py'), '')

    const defaults = await searchWorkspaceFiles(root, 'main', new AbortController().signal, {
      include: ['*.py'],
    })
    expect(defaults.entries.map(entry => entry.path)).toEqual(['src/main.py', 'tests/main.py'])

    const explicit = await searchWorkspaceFiles(root, 'main', new AbortController().signal, {
      include: ['*.py'],
      exclude: ['tests/'],
    })
    expect(explicit.entries.map(entry => entry.path)).toEqual(['dist/main.py', 'src/main.py'])

    const anchored = await searchWorkspaceFiles(root, 'main', new AbortController().signal, {
      include: ['src/**'],
    })
    expect(anchored.entries.map(entry => entry.path)).toEqual(['src/main.py', 'src/main.ts'])
  })

  it('bounds recursive file-name search results', async () => {
    const root = tempWorkspace()
    for (let index = 0; index <= WORKSPACE_FILE_SEARCH_RESULT_LIMIT; index++) {
      writeFileSync(join(root, `match-${index}.txt`), '')
    }

    const result = await searchWorkspaceFiles(root, 'match-', new AbortController().signal)

    expect(result.entries).toHaveLength(WORKSPACE_FILE_SEARCH_RESULT_LIMIT)
    expect(result.truncated).toBe(true)
  })

  it('stops recursive search at the exact scan bound', async () => {
    const root = tempWorkspace()
    try {
      for (let index = 0; index < WORKSPACE_FILE_SEARCH_SCAN_LIMIT; index++) {
        writeFileSync(join(root, `entry-${index}.txt`), '')
      }

      const result = await searchWorkspaceFiles(root, 'missing', new AbortController().signal)

      expect(result).toEqual({ entries: [], truncated: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('reads supported binary previews completely and rejects unsupported or oversized files', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'pixel.png'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(root, 'archive.bin'), Buffer.from([4]))
    writeFileSync(join(root, 'huge.pdf'), Buffer.alloc(WORKSPACE_BINARY_BYTE_LIMIT + 1))

    await expect(readWorkspaceBinary(root, 'pixel.png', new AbortController().signal)).resolves.toEqual({
      path: 'pixel.png', dataBase64: 'AAECAw==', mediaType: 'image/png', bytes: 4,
    })
    await expect(readWorkspaceBinary(root, 'archive.bin', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-file-preview-unsupported' })
    await expect(readWorkspaceBinary(root, 'huge.pdf', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-file-too-large' })
  })

  it('accepts a binary preview at the exact byte limit', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'exact.pdf'), Buffer.alloc(WORKSPACE_BINARY_BYTE_LIMIT))

    const result = await readWorkspaceBinary(root, 'exact.pdf', new AbortController().signal)

    expect(result.bytes).toBe(WORKSPACE_BINARY_BYTE_LIMIT)
    expect(result.mediaType).toBe('application/pdf')
  })

  it('fills fixed buffers across short reads and detects descriptor replacement', async () => {
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesRead = Math.min(2, length)
      buffer.fill(1, offset, offset + bytesRead)
      return { bytesRead, buffer }
    })
    const buffer = Buffer.alloc(5)
    await expect(readIntoBuffer({ read } as unknown as FileHandle, buffer, new AbortController().signal)).resolves.toBe(5)
    expect(read).toHaveBeenCalledTimes(3)

    const root = tempWorkspace()
    const target = join(root, 'target.txt')
    writeFileSync(target, 'original')
    const handle = await open(target, 'r')
    try {
      renameSync(target, join(root, 'original.txt'))
      writeFileSync(target, 'replacement')
      await expect(openedPathInfo(root, 'target.txt', target, handle, new AbortController().signal, 'file'))
        .rejects.toMatchObject({ code: 'workspace-path-invalid' })
    } finally {
      await handle.close()
    }
  })
})

describe('workspace git inspection', () => {
  it('does not execute repository-configured fsmonitor hooks', async () => {
    const root = tempWorkspace()
    const hook = join(root, 'fsmonitor.cjs')
    const marker = join(root, 'fsmonitor-ran')
    await execFileAsync('git', ['init', root])
    writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
    await execFileAsync('git', [
      '-C', root, 'config', 'core.fsmonitor', `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`,
    ])

    await workspaceGitStatus(root, new AbortController().signal)

    expect(existsSync(marker)).toBe(false)
  })

  it('classifies the internal Git deadline as a structured inspection failure', async () => {
    const root = tempWorkspace()
    await execFileAsync('git', ['init', root])
    const timeout = new AbortController()
    timeout.abort(new DOMException('deadline', 'TimeoutError'))
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    try {
      await expect(workspaceGitStatus(root, new AbortController().signal)).rejects.toMatchObject({
        code: 'workspace-git-failed',
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects a repository work tree outside the registered Workspace root', async () => {
    const root = tempWorkspace()
    const outside = tempWorkspace()
    await execFileAsync('git', ['init', root])
    await execFileAsync('git', ['-C', root, 'config', 'core.worktree', outside])

    await expect(workspaceGitStatus(root, new AbortController().signal)).rejects.toMatchObject({
      code: 'workspace-git-failed', operation: 'repository check',
    })
  })

  it('rejects Git metadata outside the registered Workspace root', async () => {
    const root = tempWorkspace()
    const metadata = tempWorkspace()
    await execFileAsync('git', ['init', `--separate-git-dir=${metadata}`, root])

    await expect(workspaceGitStatus(root, new AbortController().signal)).rejects.toMatchObject({
      code: 'workspace-git-failed', operation: 'repository check',
    })
  })

  it('accepts a registered Git Workspace whose path ends in whitespace', async () => {
    const initial = tempWorkspace()
    const root = `${initial} `
    renameSync(initial, root)
    await execFileAsync('git', ['init', root])

    await expect(workspaceGitStatus(root, new AbortController().signal)).resolves.toMatchObject({ entries: [] })
  })

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

  it('treats a Git diff filename as a literal pathspec', async () => {
    const root = tempWorkspace()
    await execFileAsync('git', ['init', root])
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Inspector Test'])
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'inspector@example.invalid'])
    writeFileSync(join(root, 'a[b]'), 'first\n')
    writeFileSync(join(root, 'axxb'), 'first\n')
    await execFileAsync('git', ['-C', root, 'add', '--', 'a[b]', 'axxb'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'initial'])
    writeFileSync(join(root, 'a[b]'), 'changed\n')
    writeFileSync(join(root, 'axxb'), 'also changed\n')

    const diff = await workspaceGitDiff(root, 'a[b]', false, new AbortController().signal)

    expect(diff.diff).toContain('a[b]')
    expect(diff.diff).not.toContain('axxb')
  })

  it('honors an already-aborted signal before starting Git', async () => {
    const abort = new AbortController()
    abort.abort(new Error('cancelled by caller'))

    await expect(workspaceGitStatus(tempWorkspace(), abort.signal)).rejects.toThrow('cancelled by caller')
  })
})
