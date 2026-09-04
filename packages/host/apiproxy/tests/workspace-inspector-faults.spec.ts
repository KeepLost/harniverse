/**
 * Workspace inspection failure classification: every filesystem and Git fault
 * the inspector can meet must reach the caller as one of its own structured
 * codes, never as a raw errno or a leaked host path. These paths need injected
 * faults because a real filesystem cannot be made to fail on demand between
 * the containment check and the descriptor open.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  /** errno raised by `open` for a path ending with this suffix. */
  openCode: undefined as string | undefined,
  openSuffix: '',
  /** errno raised by `realpath` for a path ending with this suffix. */
  realpathCode: undefined as string | undefined,
  realpathSuffix: '',
  /** Replace one `opendir` read with a rejection. */
  opendirCode: undefined as string | undefined,
  /** Answer `realpath` for this exact path with this value instead of the truth. */
  realpathRedirectFrom: undefined as string | undefined,
  realpathRedirectTo: '',
  /** Fail `realpath` for this exact path only after this many calls. */
  realpathLatePath: undefined as string | undefined,
  realpathLateCode: '',
  realpathLateCalls: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`simulated ${code}`), { code })
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.openCode !== undefined && String(args[0]).endsWith(faults.openSuffix)) {
        throw fail(faults.openCode)
      }
      return await actual.open(...args)
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = String(args[0])
      if (faults.realpathCode !== undefined && path.endsWith(faults.realpathSuffix)) {
        throw fail(faults.realpathCode)
      }
      if (faults.realpathLatePath === path) {
        faults.realpathLateCalls += 1
        if (faults.realpathLateCalls > 1) throw fail(faults.realpathLateCode)
      }
      if (faults.realpathRedirectFrom === path) return faults.realpathRedirectTo
      return await actual.realpath(...args)
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      if (faults.opendirCode !== undefined) throw fail(faults.opendirCode)
      return await actual.opendir(...args)
    },
  }
})

const {
  listWorkspaceFiles,
  readWorkspaceBinary,
  readWorkspaceFile,
  workspaceGitCommits,
  workspaceGitStatus,
} = await import('../src/workspace-inspector.ts')

function tempWorkspace(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-workspace-faults-')))
}

afterEach(() => {
  faults.openCode = undefined
  faults.openSuffix = ''
  faults.realpathCode = undefined
  faults.realpathSuffix = ''
  faults.opendirCode = undefined
  faults.realpathRedirectFrom = undefined
  faults.realpathRedirectTo = ''
  faults.realpathLatePath = undefined
  faults.realpathLateCode = ''
  faults.realpathLateCalls = 0
})

describe('containment failure classification', () => {
  it.each([
    ['EACCES', 'workspace-entry-not-readable'],
    ['EIO', 'workspace-entry-not-readable'],
    ['ENOENT', 'workspace-entry-not-found'],
    ['ENOTDIR', 'workspace-entry-not-found'],
  ])('maps %s while canonicalizing to %s', async (openCode, code) => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'file.txt'), 'hello')
    faults.realpathCode = openCode
    faults.realpathSuffix = 'file.txt'

    await expect(readWorkspaceFile(root, 'file.txt', new AbortController().signal))
      .rejects.toMatchObject({ code })
  })

  it('does not leak the host path in a containment failure message', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'secret.txt'), 'hello')
    faults.realpathCode = 'EACCES'
    faults.realpathSuffix = 'secret.txt'

    await expect(readWorkspaceFile(root, 'secret.txt', new AbortController().signal))
      .rejects.toThrow(/workspace entry "secret\.txt" cannot be resolved/)
  })
})

describe('directory read failure classification', () => {
  it.each([
    ['ELOOP', 'workspace-path-invalid'],
    ['ENOENT', 'workspace-entry-not-found'],
    ['ENOTDIR', 'workspace-entry-type-invalid'],
    ['EACCES', 'workspace-entry-not-readable'],
  ])('maps %s from opening a directory to %s', async (openCode, code) => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'folder'))
    faults.openCode = openCode
    faults.openSuffix = 'folder'

    await expect(listWorkspaceFiles(root, 'folder', new AbortController().signal))
      .rejects.toMatchObject({ code })
  })

  it('classifies a failure raised while streaming entries', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'folder'))
    faults.opendirCode = 'EACCES'

    await expect(listWorkspaceFiles(root, 'folder', new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-entry-not-readable' })
  })

  it('prefers caller cancellation over a concurrent read failure', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'folder'))
    faults.opendirCode = 'EACCES'
    const abort = new AbortController()
    abort.abort(new Error('cancelled during read'))

    await expect(listWorkspaceFiles(root, 'folder', abort.signal)).rejects.toThrow('cancelled during read')
  })
})

describe('file read failure classification', () => {
  it.each([
    ['ELOOP', 'workspace-path-invalid'],
    ['ENOENT', 'workspace-entry-not-found'],
    ['ENOTDIR', 'workspace-entry-not-found'],
    ['EACCES', 'workspace-entry-not-readable'],
  ])('maps %s from opening a text file to %s', async (openCode, code) => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'file.txt'), 'hello')
    faults.openCode = openCode
    faults.openSuffix = 'file.txt'

    await expect(readWorkspaceFile(root, 'file.txt', new AbortController().signal))
      .rejects.toMatchObject({ code })
  })

  it.each([
    ['ELOOP', 'workspace-path-invalid'],
    ['ENOENT', 'workspace-entry-not-found'],
    ['ENOTDIR', 'workspace-entry-not-found'],
    ['EACCES', 'workspace-entry-not-readable'],
  ])('maps %s from opening a preview file to %s', async (openCode, code) => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'image.png'), 'bytes')
    faults.openCode = openCode
    faults.openSuffix = 'image.png'

    await expect(readWorkspaceBinary(root, 'image.png', new AbortController().signal))
      .rejects.toMatchObject({ code })
  })

  it.each([
    ['text', (root: string, signal: AbortSignal) => readWorkspaceFile(root, 'file.txt', signal)],
    ['preview', (root: string, signal: AbortSignal) => readWorkspaceBinary(root, 'file.png', signal)],
  ])('prefers caller cancellation over an open failure on a %s read', async (_label, read) => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'file.txt'), 'hello')
    writeFileSync(join(root, 'file.png'), 'bytes')
    faults.openCode = 'EACCES'
    faults.openSuffix = 'file'
    const abort = new AbortController()
    abort.abort(new Error('cancelled before open settled'))

    await expect(read(root, abort.signal)).rejects.toThrow('cancelled before open settled')
  })
})

describe('git metadata failure classification', () => {
  it('refuses a repository whose metadata cannot be canonicalized', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n')
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    mkdirSync(join(root, '.git', 'refs'), { recursive: true })
    faults.realpathCode = 'EACCES'
    faults.realpathSuffix = '.git'

    await expect(workspaceGitStatus(root, new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-git-failed' })
  })
})

describe('git process failure classification', () => {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const originalPath = process.env[pathKey]
  afterEach(() => {
    // An absent original stays absent as an empty search path rather than a
    // dynamically deleted key.
    process.env[pathKey] = originalPath ?? ''
  })

  it('reports a Git binary that cannot be started', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, '.git'))
    // An empty PATH leaves `git` unresolvable, so spawn reports the process
    // error instead of any repository condition.
    process.env[pathKey] = join(root, 'no-tools-here')

    await expect(workspaceGitStatus(root, new AbortController().signal))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a directory that is not a repository at all', async () => {
    const root = tempWorkspace()

    await expect(workspaceGitStatus(root, new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-git-not-repository' })
  })
})

describe('git repository boundary faults', () => {
  it('refuses a work tree Git reports as empty', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, '.git'))
    // A bare repository has no work tree, so the toplevel probe answers with
    // nothing and the inspector refuses rather than guessing a root.
    await expect(workspaceGitStatus(root, new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-git-not-repository' })
  })

  it('classifies a directory revalidation failure during a listing', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'folder'))
    writeFileSync(join(root, 'folder', 'inside.txt'), 'x')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    // On a real-path platform the descriptor is revalidated after the walk, so
    // a containment failure there must surface as the inspector's own code.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    faults.realpathLatePath = join(root, 'folder')
    faults.realpathLateCode = 'EACCES'
    try {
      await expect(listWorkspaceFiles(root, 'folder', new AbortController().signal))
        .rejects.toMatchObject({ code: 'workspace-entry-not-readable' })
    } finally {
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
    }
  })
})

describe('git output parsing boundaries', () => {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const originalPath = process.env[pathKey]
  afterEach(() => {
    // An absent original stays absent as an empty search path rather than a
    // dynamically deleted key.
    process.env[pathKey] = originalPath ?? ''
  })

  /**
   * Install a stub `git` ahead of the real one so the inspector's parsing can
   * be driven with exact bytes, including endings and empty fields a real Git
   * would not produce on this platform.
   * @param script - shell body receiving the forwarded Git arguments.
   * @returns the workspace whose stub is installed.
   */
  function stubGit(script: string): string {
    const root = tempWorkspace()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const stub = join(bin, process.platform === 'win32' ? 'git.cmd' : 'git')
    // The inspector runs Git through the opened descriptor on Linux, so the
    // stub cannot learn the workspace from its own cwd; bake it in as ROOT.
    // The stub directory goes first but the real PATH stays behind it, or the
    // script's own utilities (`sleep`) would not resolve either.
    const shellScript = `#!/bin/sh\nROOT='${root}'\n${script}\n`
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'git.sh'), shellScript)
      writeFileSync(stub, '@echo off\r\n"%ProgramFiles%\\Git\\usr\\bin\\sh.exe" "%~dp0git.sh" %*\r\n')
    } else {
      writeFileSync(stub, shellScript, { mode: 0o755 })
    }
    process.env[pathKey] = originalPath === undefined ? bin : `${bin}${delimiter}${originalPath}`
    return root
  }

  it('refuses a repository whose toplevel probe answers with nothing', async () => {
    const root = stubGit('exit 0')

    // Both probes succeed with empty output: there is no work tree to inspect.
    await expect(workspaceGitStatus(root, new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-git-not-repository' })
  })

  it('accepts CRLF-terminated repository probes', async () => {
    const root = stubGit([
      'case "$*" in',
      '  *--show-toplevel*) printf "%s\\r\\n" "$ROOT" ;;',
      '  *--absolute-git-dir*) printf "%s\\r\\n" "$ROOT/.git" ;;',
      '  *status*) printf "## main\\0" ;;',
      'esac',
      'exit 0',
    ].join('\n'))
    mkdirSync(join(root, '.git'))

    // A Windows-built Git terminates its output with CRLF; the trailing \r is
    // not part of the path.
    await expect(workspaceGitStatus(root, new AbortController().signal))
      .resolves.toMatchObject({ branch: 'main', entries: [] })
  })

  it('accepts repository probes with no trailing newline at all', async () => {
    const root = stubGit([
      'case "$*" in',
      '  *--show-toplevel*) printf "%s" "$ROOT" ;;',
      '  *--absolute-git-dir*) printf "%s" "$ROOT/.git" ;;',
      '  *status*) printf "" ;;',
      'esac',
      'exit 0',
    ].join('\n'))
    mkdirSync(join(root, '.git'))

    await expect(workspaceGitStatus(root, new AbortController().signal))
      .resolves.toMatchObject({ branch: null, entries: [] })
  })

  it('reports a Git failure that is not a missing repository', async () => {
    const root = stubGit([
      'case "$*" in',
      '  *--show-toplevel*) printf "%s\\n" "$ROOT"; exit 0 ;;',
      '  *--absolute-git-dir*) printf "%s\\n" "$ROOT/.git"; exit 0 ;;',
      'esac',
      'echo "fatal: index file corrupt" >&2',
      'exit 128',
    ].join('\n'))
    mkdirSync(join(root, '.git'))

    await expect(workspaceGitStatus(root, new AbortController().signal))
      .rejects.toMatchObject({ code: 'workspace-git-failed', operation: 'status' })
  })

  it('reads a status record shorter than its status columns', async () => {
    const root = stubGit([
      'case "$*" in',
      '  *--show-toplevel*) printf "%s\\n" "$ROOT"; exit 0 ;;',
      '  *--absolute-git-dir*) printf "%s\\n" "$ROOT/.git"; exit 0 ;;',
      'esac',
      'printf "## main\\0M\\0"',
      'exit 0',
    ].join('\n'))
    mkdirSync(join(root, '.git'))

    // A one-character record has no worktree column; both columns still read
    // as a definite value rather than undefined.
    await expect(workspaceGitStatus(root, new AbortController().signal))
      .resolves.toMatchObject({ entries: [{ path: '', indexStatus: 'M', worktreeStatus: ' ' }] })
  })

  it('stops reading commit fields at the first empty hash', async () => {
    const root = stubGit([
      'case "$*" in',
      '  *--show-toplevel*) printf "%s\\n" "$ROOT"; exit 0 ;;',
      '  *--absolute-git-dir*) printf "%s\\n" "$ROOT/.git"; exit 0 ;;',
      'esac',
      'printf "h1\\0s1\\0name\\0mail\\0date\\0subject\\0\\0\\0\\0\\0\\0\\0"',
      'exit 0',
    ].join('\n'))
    mkdirSync(join(root, '.git'))

    // The -z stream ends with a trailing separator, so a final all-empty
    // record must not become a commit.
    await expect(workspaceGitCommits(root, 5, new AbortController().signal))
      .resolves.toMatchObject({ commits: [{ hash: 'h1', subject: 'subject' }], truncated: false })
  })

  it('reports the caller reason when cancellation lands during Git', async () => {
    const root = stubGit([
      'case "$*" in',
      '  *--show-toplevel*) printf "%s\\n" "$ROOT"; exit 0 ;;',
      '  *--absolute-git-dir*) printf "%s\\n" "$ROOT/.git"; exit 0 ;;',
      'esac',
      'exec sleep 30',
    ].join('\n'))
    mkdirSync(join(root, '.git'))
    const abort = new AbortController()
    const reading = workspaceGitStatus(root, abort.signal)
    setTimeout(() => { abort.abort(new Error('operator cancelled the read')) }, 150)

    await expect(reading).rejects.toThrow('operator cancelled the read')
  })

  it('reports a non-Error cancellation reason as a cancelled Git operation', async () => {
    const root = stubGit([
      'case "$*" in',
      '  *--show-toplevel*) printf "%s\\n" "$ROOT"; exit 0 ;;',
      '  *--absolute-git-dir*) printf "%s\\n" "$ROOT/.git"; exit 0 ;;',
      'esac',
      'exec sleep 30',
    ].join('\n'))
    mkdirSync(join(root, '.git'))
    const abort = new AbortController()
    const reading = workspaceGitStatus(root, abort.signal)
    setTimeout(() => { abort.abort('stringly cancelled') }, 150)

    await expect(reading).rejects.toThrow('workspace Git operation was cancelled')
  })
})
