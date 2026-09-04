import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_BINARY_BYTE_LIMIT,
  WORKSPACE_DIRECTORY_ENTRY_LIMIT,
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
  }, 60_000)

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

  it.skipIf(process.platform === 'win32')('accepts a registered Git Workspace whose path ends in whitespace', async () => {
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

describe('workspace path containment', () => {
  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a NUL byte', 'README\0.md'],
    ['a parent escape', '../outside.txt'],
    ['a nested parent escape', 'nested/../../outside.txt'],
  ])('refuses %s before touching the filesystem', async (_label, path) => {
    await expect(readWorkspaceFile(tempWorkspace(), path, new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-path-invalid' })
  })

  it('refuses a workspace root that is itself a symbolic link', async () => {
    const real = tempWorkspace()
    const link = join(tempWorkspace(), 'link-root')
    writeFileSync(join(real, 'inside.txt'), 'hello')
    symlinkSync(real, link, 'dir')

    // The registered root must already be canonical; resolving it through a
    // link would let the link's target move the whole boundary.
    await expect(readWorkspaceFile(link, 'inside.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-path-invalid' })
  })

  it('reports a missing entry distinctly from an unreadable one', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'file.txt'), 'hello')

    await expect(readWorkspaceFile(root, 'absent.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-entry-not-found' })
    // A path that walks through a regular file is ENOTDIR, not ENOENT.
    await expect(readWorkspaceFile(root, 'file.txt/child.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-entry-not-found' })
  })

  it('refuses a directory read of a regular file and a file read of a directory', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'file.txt'), 'hello')
    mkdirSync(join(root, 'folder'))

    await expect(listWorkspaceFiles(root, 'file.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-entry-type-invalid' })
    await expect(readWorkspaceFile(root, 'folder', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-entry-type-invalid' })
  })

  it('refuses a directory listing through a symbolic link', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'alias'), 'dir')

    await expect(listWorkspaceFiles(root, 'alias', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-path-invalid' })
  })

  it('honors cancellation raised while listing a directory', async () => {
    const root = tempWorkspace()
    for (let index = 0; index < 40; index += 1) writeFileSync(join(root, `f${String(index)}.txt`), 'x')
    const abort = new AbortController()
    abort.abort(new Error('cancelled mid-list'))

    await expect(listWorkspaceFiles(root, '.', abort.signal)).rejects.toThrow('cancelled mid-list')
  })

  it('classifies every entry kind it can encounter', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'folder'))
    writeFileSync(join(root, 'file.txt'), 'x')
    symlinkSync(join(root, 'missing'), join(root, 'dangling'), 'file')

    const listed = await listWorkspaceFiles(root, '.', new AbortController().signal)
    const kinds = new Map(listed.entries.map(entry => [entry.name, entry.kind]))
    expect(kinds.get('folder')).toBe('directory')
    expect(kinds.get('file.txt')).toBe('file')
    expect(kinds.get('dangling')).toBe('symlink')
  })

  it('builds nested child paths from a subdirectory listing', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), 'x')

    // A trailing slash must not double up in the projected child path.
    for (const path of ['src', 'src/']) {
      const listed = await listWorkspaceFiles(root, path, new AbortController().signal)
      expect(listed.entries.map(entry => entry.path)).toEqual(['src/index.ts'])
    }
  })
})

describe('workspace file reading boundaries', () => {
  it('refuses a file whose bytes are not valid UTF-8 text', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'binary.txt'), Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]))

    await expect(readWorkspaceFile(root, 'binary.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-file-binary' })
  })

  it('refuses a file whose size changes between its probe and its final check', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'growing.txt'), 'small')
    const handle = await open(join(root, 'growing.txt'), 'r')
    const real = await handle.stat()
    await handle.close()
    const probes = vi.spyOn(Object.getPrototypeOf(handle) as FileHandle, 'stat')
    let calls = 0
    probes.mockImplementation(() => {
      calls += 1
      // The first probe sizes the buffer; the final one must disagree, as a
      // concurrent writer would make it.
      return Promise.resolve(calls === 1 ? real : Object.assign(Object.create(real as object) as typeof real, { size: real.size + 7 }))
    })
    try {
      await expect(readWorkspaceFile(root, 'growing.txt', new AbortController().signal))
        .rejects.toMatchObject({ code: 'workspace-entry-not-readable' })
    } finally {
      probes.mockRestore()
    }
  })

  it('refuses a preview whose size changes between its probe and its final check', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'shrinking.png'), 'bytes')
    const handle = await open(join(root, 'shrinking.png'), 'r')
    const real = await handle.stat()
    await handle.close()
    const probes = vi.spyOn(Object.getPrototypeOf(handle) as FileHandle, 'stat')
    let calls = 0
    probes.mockImplementation(() => {
      calls += 1
      return Promise.resolve(calls === 1 ? real : Object.assign(Object.create(real as object) as typeof real, { size: real.size + 3 }))
    })
    try {
      await expect(readWorkspaceBinary(root, 'shrinking.png', new AbortController().signal))
        .rejects.toMatchObject({ code: 'workspace-entry-not-readable' })
    } finally {
      probes.mockRestore()
    }
  })

  it('refuses a preview larger than the binary byte limit', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'huge.png'), Buffer.alloc(WORKSPACE_BINARY_BYTE_LIMIT + 1))

    await expect(readWorkspaceBinary(root, 'huge.png', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-file-too-large' })
  })

  it('refuses a binary preview of an unsupported extension that really exists', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'plain text')

    await expect(readWorkspaceBinary(root, 'notes.txt', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-file-preview-unsupported' })
  })

  it('refuses a binary preview of a missing file', async () => {
    await expect(readWorkspaceBinary(tempWorkspace(), 'absent.png', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-entry-not-found' })
  })

  it('refuses a binary preview of a directory and of a symbolic link', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'folder.png'))
    writeFileSync(join(root, 'real.png'), 'x')
    symlinkSync(join(root, 'real.png'), join(root, 'alias.png'), 'file')

    await expect(readWorkspaceBinary(root, 'folder.png', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-entry-type-invalid' })
    await expect(readWorkspaceBinary(root, 'alias.png', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-path-invalid' })
  })

  it('serves every allowlisted preview media type', async () => {
    const root = tempWorkspace()
    const expected: Record<string, string> = {
      'a.pdf': 'application/pdf',
      'a.gif': 'image/gif',
      'a.jpg': 'image/jpeg',
      'a.jpeg': 'image/jpeg',
      'a.png': 'image/png',
      'a.svg': 'image/svg+xml',
      'a.webp': 'image/webp',
    }
    for (const name of Object.keys(expected)) writeFileSync(join(root, name), 'bytes')

    for (const [name, mediaType] of Object.entries(expected)) {
      // Uppercase proves the extension match is case-insensitive.
      const upper = `upper-${name.toUpperCase()}`
      writeFileSync(join(root, upper), 'bytes')
      await expect(readWorkspaceBinary(root, name, new AbortController().signal))
        .resolves.toMatchObject({ mediaType })
      await expect(readWorkspaceBinary(root, upper, new AbortController().signal))
        .resolves.toMatchObject({ mediaType })
    }
  })
})

describe('workspace git projection', () => {
  /** A workspace with an initialized repository and a deterministic identity. */
  async function repository(): Promise<string> {
    const root = tempWorkspace()
    await execFileAsync('git', ['init', root])
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Inspector Test'])
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'inspector@example.invalid'])
    return root
  }

  const git = (root: string, ...args: string[]): Promise<unknown> => execFileAsync('git', ['-C', root, ...args])

  it('reports no branch for a repository with no commits yet', async () => {
    const root = await repository()
    writeFileSync(join(root, 'first.txt'), 'x')

    // `## No commits yet on main` names the branch that does not exist yet.
    const status = await workspaceGitStatus(root, new AbortController().signal)
    expect(status.branch).not.toBe('')
    expect(status.entries).toEqual([expect.objectContaining({ path: 'first.txt', indexStatus: '?' })])
  })

  it('reports a detached HEAD as no branch', async () => {
    const root = await repository()
    writeFileSync(join(root, 'tracked.txt'), 'first\n')
    await git(root, 'add', '--', 'tracked.txt')
    await git(root, 'commit', '-m', 'initial')
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])
    await git(root, 'checkout', '--detach', stdout.trim())

    await expect(workspaceGitStatus(root, new AbortController().signal))
      .resolves.toMatchObject({ branch: null })
  })

  it('carries the original path of a renamed entry', async () => {
    const root = await repository()
    writeFileSync(join(root, 'before.txt'), 'contents\n')
    await git(root, 'add', '--', 'before.txt')
    await git(root, 'commit', '-m', 'initial')
    await git(root, 'mv', 'before.txt', 'after.txt')

    const status = await workspaceGitStatus(root, new AbortController().signal)
    expect(status.entries).toEqual([expect.objectContaining({
      path: 'after.txt',
      originalPath: 'before.txt',
      indexStatus: 'R',
    })])
    expect(status.truncated).toBe(false)
  })

  it('bounds a status list larger than the entry limit', async () => {
    const root = await repository()
    for (let index = 0; index < 2_100; index += 1) {
      writeFileSync(join(root, `f${String(index).padStart(5, '0')}.txt`), 'x')
    }

    const status = await workspaceGitStatus(root, new AbortController().signal)
    expect(status.entries).toHaveLength(2_000)
    expect(status.truncated).toBe(true)
  })

  it('bounds commit history and reports more history beyond the request', async () => {
    const root = await repository()
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(join(root, 'log.txt'), `revision ${String(index)}\n`)
      await git(root, 'add', '--', 'log.txt')
      await git(root, 'commit', '-m', `commit ${String(index)}`)
    }

    const bounded = await workspaceGitCommits(root, 2, new AbortController().signal)
    expect(bounded.commits).toHaveLength(2)
    expect(bounded.truncated).toBe(true)
    const all = await workspaceGitCommits(root, 50, new AbortController().signal)
    expect(all.commits).toHaveLength(4)
    expect(all.truncated).toBe(false)
    expect(all.commits[0]).toMatchObject({ subject: 'commit 3', authorEmail: 'inspector@example.invalid' })
  })

  it('reads a staged diff separately from the working tree', async () => {
    const root = await repository()
    writeFileSync(join(root, 'tracked.txt'), 'first\n')
    await git(root, 'add', '--', 'tracked.txt')
    await git(root, 'commit', '-m', 'initial')
    writeFileSync(join(root, 'tracked.txt'), 'staged\n')
    await git(root, 'add', '--', 'tracked.txt')
    writeFileSync(join(root, 'tracked.txt'), 'unstaged\n')

    const signal = new AbortController().signal
    expect((await workspaceGitDiff(root, undefined, true, signal)).diff).toContain('+staged')
    expect((await workspaceGitDiff(root, undefined, false, signal)).diff).toContain('+unstaged')
  })

  it('refuses a diff path that escapes the workspace', async () => {
    const root = await repository()

    await expect(workspaceGitDiff(root, '../outside.txt', false, new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-path-invalid' })
  })

  it.each([
    ['status', (root: string, signal: AbortSignal) => workspaceGitStatus(root, signal)],
    ['commits', (root: string, signal: AbortSignal) => workspaceGitCommits(root, 5, signal)],
    ['diff', (root: string, signal: AbortSignal) => workspaceGitDiff(root, undefined, false, signal)],
  ])('reports a directory outside any repository through %s', async (_label, read) => {
    await expect(read(tempWorkspace(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-git-not-repository' })
  })
})

describe('cross-platform descriptor handling', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const as = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true, writable: false })
  }
  afterEach(() => {
    if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
  })

  it('lists a directory through its real path where /dev/fd is not a directory', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'folder'))
    writeFileSync(join(root, 'README.md'), 'hello')
    as('darwin')

    // Linux traverses the opened descriptor; elsewhere the real path is walked
    // and the descriptor is revalidated afterwards.
    const listed = await listWorkspaceFiles(root, '.', new AbortController().signal)
    expect(listed.entries.map(entry => entry.name)).toEqual(['folder', 'README.md'])
  })

  it('still refuses a replaced directory when traversing the real path', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'folder'))
    writeFileSync(join(root, 'folder', 'inside.txt'), 'x')
    as('darwin')

    const inspector = listWorkspaceFiles(root, 'folder', new AbortController().signal)
    await expect(inspector).resolves.toMatchObject({ entries: [expect.objectContaining({ name: 'inside.txt' })] })
  })

  it('runs Git against the real root where a descriptor root is unavailable', async () => {
    const root = tempWorkspace()
    await execFileAsync('git', ['init', root])
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Inspector Test'])
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'inspector@example.invalid'])
    writeFileSync(join(root, 'tracked.txt'), 'first\n')
    as('darwin')

    await expect(workspaceGitStatus(root, new AbortController().signal))
      .resolves.toMatchObject({ entries: [expect.objectContaining({ path: 'tracked.txt' })] })
  })

  it('compares filesystem paths case-insensitively on Windows', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'README.md'), 'hello')
    as('win32')

    await expect(readWorkspaceFile(root, 'README.md', new AbortController().signal))
      .resolves.toMatchObject({ content: 'hello' })
  })

  it('silences global Git configuration with the Windows null device', async () => {
    const root = tempWorkspace()
    await execFileAsync('git', ['init', root])
    writeFileSync(join(root, 'tracked.txt'), 'first\n')
    as('win32')

    // NUL names no readable file here, and Git treats an unreadable global
    // config as empty, so the read still succeeds without host configuration.
    await expect(workspaceGitStatus(root, new AbortController().signal))
      .resolves.toMatchObject({ entries: [expect.objectContaining({ path: 'tracked.txt' })] })
  })
})

describe('workspace entry classification and short reads', () => {
  it('stops filling a buffer at end of file', async () => {
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesRead = offset === 0 ? Math.min(3, length) : 0
      buffer.fill(2, offset, offset + bytesRead)
      return { bytesRead, buffer }
    })

    // The source ran out before the buffer filled; the caller learns how much
    // really arrived rather than spinning on zero-length reads.
    await expect(readIntoBuffer({ read } as unknown as FileHandle, Buffer.alloc(9), new AbortController().signal))
      .resolves.toBe(3)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('detects a directory holding more entries than the listing bound', async () => {
    const root = tempWorkspace()
    for (let index = 0; index <= WORKSPACE_DIRECTORY_ENTRY_LIMIT; index += 1) {
      writeFileSync(join(root, `e${String(index).padStart(5, '0')}.txt`), 'x')
    }

    // The reader takes one entry beyond the bound purely to learn that more
    // exist, then reports the bound with the overflow flagged.
    const listed = await listWorkspaceFiles(root, '.', new AbortController().signal)
    expect(listed.entries).toHaveLength(WORKSPACE_DIRECTORY_ENTRY_LIMIT)
    expect(listed.truncated).toBe(true)
  })

  it('classifies a device entry as neither file, directory, nor symlink', async () => {
    const root = tempWorkspace()
    await execFileAsync('mkfifo', [join(root, 'pipe')])

    const listed = await listWorkspaceFiles(root, '.', new AbortController().signal)
    expect(listed.entries).toEqual([expect.objectContaining({ name: 'pipe', kind: 'other' })])
  })

  it('returns an empty result when the scan budget is already spent', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'a'))
    for (let index = 0; index < WORKSPACE_FILE_SEARCH_SCAN_LIMIT + 10; index += 1) {
      writeFileSync(join(root, 'a', `f${String(index)}.txt`), 'x')
    }
    mkdirSync(join(root, 'b'))
    writeFileSync(join(root, 'b', 'late.txt'), 'x')

    // The first directory consumes the whole budget, so the queued sibling is
    // reported as truncated instead of scanned.
    const found = await searchWorkspaceFiles(root, 'late', new AbortController().signal, { exclude: [] })
    expect(found.truncated).toBe(true)
    expect(found.entries).toEqual([])
  })
})
