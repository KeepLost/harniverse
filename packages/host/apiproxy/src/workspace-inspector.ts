import { execFile } from 'node:child_process'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const WORKSPACE_DIRECTORY_ENTRY_LIMIT = 2_000
export const WORKSPACE_FILE_BYTE_LIMIT = 1024 * 1024
export const WORKSPACE_DIFF_BYTE_LIMIT = 1024 * 1024
export const WORKSPACE_GIT_STATUS_LIMIT = 2_000
export const WORKSPACE_GIT_COMMIT_LIMIT = 100

type WorkspaceInspectorErrorCode =
  | 'workspace-path-invalid'
  | 'workspace-entry-not-found'
  | 'workspace-entry-not-readable'
  | 'workspace-entry-type-invalid'
  | 'workspace-file-binary'
  | 'workspace-git-not-repository'
  | 'workspace-git-failed'

/** Expected read-only inspection failure mapped to a structured RPC error by the Host API. */
export class WorkspaceInspectorError extends Error {
  constructor(
    readonly code: WorkspaceInspectorErrorCode,
    message: string,
    readonly path?: string,
    readonly operation?: string,
  ) {
    super(message)
    this.name = 'WorkspaceInspectorError'
  }
}

export interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
}

export interface WorkspaceGitStatusEntry {
  path: string
  indexStatus: string
  worktreeStatus: string
  originalPath?: string
}

export interface WorkspaceGitCommit {
  hash: string
  shortHash: string
  authorName: string
  authorEmail: string
  authoredAt: string
  subject: string
}

function abortSignal(signal: AbortSignal): AbortSignal {
  signal.throwIfAborted()
  return AbortSignal.any([signal, AbortSignal.timeout(10_000)])
}

function relativePath(root: string, path: string): string {
  if (path.includes('\0') || isAbsolute(path)) {
    throw new WorkspaceInspectorError('workspace-path-invalid', `workspace path ${JSON.stringify(path)} must be relative`, path)
  }
  const target = resolve(root, path)
  const fromRoot = relative(root, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new WorkspaceInspectorError('workspace-path-invalid', `workspace path ${JSON.stringify(path)} escapes the workspace`, path)
  }
  return target
}

async function containedPath(root: string, path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let canonicalRoot: string
  let canonicalTarget: string
  try {
    canonicalRoot = await realpath(root)
    if (canonicalRoot !== resolve(root)) {
      throw new WorkspaceInspectorError(
        'workspace-path-invalid',
        'the registered workspace path no longer resolves to its canonical directory',
        path,
      )
    }
    canonicalTarget = await realpath(relativePath(canonicalRoot, path))
  } catch (error: unknown) {
    if (error instanceof WorkspaceInspectorError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new WorkspaceInspectorError('workspace-entry-not-found', `workspace entry ${JSON.stringify(path)} was not found`, path)
    }
    throw new WorkspaceInspectorError('workspace-entry-not-readable', `workspace entry ${JSON.stringify(path)} cannot be resolved`, path)
  }
  const fromRoot = relative(canonicalRoot, canonicalTarget)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new WorkspaceInspectorError('workspace-path-invalid', `workspace path ${JSON.stringify(path)} escapes the workspace`, path)
  }
  signal.throwIfAborted()
  return canonicalTarget
}

function entryKind(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): WorkspaceFileEntry['kind'] {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'directory'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

/** List one workspace directory without name-based exclusions. */
export async function listWorkspaceFiles(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<{ path: string; entries: WorkspaceFileEntry[]; truncated: boolean }> {
  const target = await containedPath(root, path, signal)
  let info
  try {
    info = await stat(target)
  } catch {
    signal.throwIfAborted()
    throw new WorkspaceInspectorError('workspace-entry-not-readable', `workspace directory ${JSON.stringify(path)} cannot be read`, path)
  }
  if (!info.isDirectory()) {
    throw new WorkspaceInspectorError('workspace-entry-type-invalid', `workspace entry ${JSON.stringify(path)} is not a directory`, path)
  }
  let children
  try {
    children = await readdir(target, { withFileTypes: true })
  } catch {
    signal.throwIfAborted()
    throw new WorkspaceInspectorError('workspace-entry-not-readable', `workspace directory ${JSON.stringify(path)} cannot be read`, path)
  }
  signal.throwIfAborted()
  children.sort((left, right) => {
    const leftDirectory = left.isDirectory() ? 0 : 1
    const rightDirectory = right.isDirectory() ? 0 : 1
    return leftDirectory - rightDirectory || left.name.localeCompare(right.name)
  })
  const entries = children.slice(0, WORKSPACE_DIRECTORY_ENTRY_LIMIT).map(entry => ({
    name: entry.name,
    path: path === '.' || path === '' ? entry.name : `${path.replace(/\/$/u, '')}/${entry.name}`,
    kind: entryKind(entry),
  }))
  return { path, entries, truncated: children.length > entries.length }
}

function decodeUtf8Prefix(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let length = bytes.byteLength; length >= Math.max(0, bytes.byteLength - 3); length--) {
    try {
      return decoder.decode(bytes.subarray(0, length))
    } catch {
      // A truncated final code point needs at most three bytes removed.
    }
  }
  throw new WorkspaceInspectorError('workspace-file-binary', 'workspace file is not valid UTF-8 text')
}

/** Read a bounded UTF-8 text prefix from one canonically contained workspace file. */
export async function readWorkspaceFile(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<{ path: string; content: string; bytes: number; truncated: boolean }> {
  const target = await containedPath(root, path, signal)
  let handle
  try {
    handle = await open(target, 'r')
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new WorkspaceInspectorError('workspace-entry-type-invalid', `workspace entry ${JSON.stringify(path)} is not a file`, path)
    }
    const length = Math.min(info.size, WORKSPACE_FILE_BYTE_LIMIT)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    signal.throwIfAborted()
    let content: string
    try {
      content = decodeUtf8Prefix(buffer.subarray(0, bytesRead))
    } catch (error: unknown) {
      if (error instanceof WorkspaceInspectorError) {
        throw new WorkspaceInspectorError(error.code, `workspace file ${JSON.stringify(path)} is not valid UTF-8 text`, path)
      }
      throw error
    }
    return { path, content, bytes: info.size, truncated: info.size > bytesRead }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof WorkspaceInspectorError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new WorkspaceInspectorError('workspace-entry-not-found', `workspace file ${JSON.stringify(path)} was not found`, path)
    }
    throw new WorkspaceInspectorError('workspace-entry-not-readable', `workspace file ${JSON.stringify(path)} cannot be read`, path)
  } finally {
    await handle?.close()
  }
}

interface GitResult {
  stdout: string
  stderr: string
  overflow: boolean
}

function runGit(root: string, args: readonly string[], signal: AbortSignal, operation: string): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      maxBuffer: WORKSPACE_DIFF_BYTE_LIMIT + 64 * 1024,
      signal: abortSignal(signal),
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ stdout, stderr, overflow: false })
        return
      }
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('workspace Git operation was cancelled'))
        return
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        resolvePromise({ stdout, stderr, overflow: true })
        return
      }
      const message = stderr.trim()
      const notRepository = message.includes('not a git repository')
      reject(new WorkspaceInspectorError(
        notRepository ? 'workspace-git-not-repository' : 'workspace-git-failed',
        notRepository ? 'workspace is not inside a Git repository' : `Git ${operation} failed`,
        undefined,
        operation,
      ))
    })
  })
}

async function assertGitRepository(root: string, signal: AbortSignal): Promise<void> {
  await containedPath(root, '.', signal)
  const result = await runGit(root, ['rev-parse', '--is-inside-work-tree'], signal, 'repository check')
  if (result.stdout.trim() !== 'true') {
    throw new WorkspaceInspectorError('workspace-git-not-repository', 'workspace is not inside a Git work tree')
  }
}

function gitPath(root: string, path: string | undefined): string[] {
  if (path === undefined) return ['.']
  relativePath(root, path)
  return [path]
}

/** Read porcelain status with untracked files expanded instead of directory-collapsed. */
export async function workspaceGitStatus(
  root: string,
  signal: AbortSignal,
): Promise<{ branch: string | null; entries: WorkspaceGitStatusEntry[]; truncated: boolean }> {
  await assertGitRepository(root, signal)
  const result = await runGit(root, [
    'status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all', '--ignored=no', '--', '.',
  ], signal, 'status')
  const records = result.stdout.split('\0')
  const branchRecord = records.shift() ?? ''
  const branchText = branchRecord.startsWith('## ') ? branchRecord.slice(3) : ''
  const branch = branchText.startsWith('No commits yet on ')
    ? branchText.slice('No commits yet on '.length)
    : branchText === 'HEAD (no branch)' || branchText === ''
      ? null
      : branchText.split('...')[0] ?? null
  const entries: WorkspaceGitStatusEntry[] = []
  for (let index = 0; index < records.length && entries.length < WORKSPACE_GIT_STATUS_LIMIT; index++) {
    const record = records[index]
    if (record === undefined || record === '') continue
    const indexStatus = record[0] ?? ' '
    const worktreeStatus = record[1] ?? ' '
    const path = record.slice(3)
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const originalPath = renamed ? records[++index] : undefined
    entries.push({ path, indexStatus, worktreeStatus, ...(originalPath === undefined ? {} : { originalPath }) })
  }
  const nonEmptyRecords = records.filter(record => record !== '').length
  return {
    branch,
    entries,
    truncated: result.overflow || nonEmptyRecords > entries.length + entries.filter(entry => entry.originalPath !== undefined).length,
  }
}

/** Read a bounded workspace-path commit history. */
export async function workspaceGitCommits(
  root: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ commits: WorkspaceGitCommit[]; truncated: boolean }> {
  await assertGitRepository(root, signal)
  const boundedLimit = Math.min(limit, WORKSPACE_GIT_COMMIT_LIMIT)
  const result = await runGit(root, [
    'log', '-z', `--max-count=${String(boundedLimit + 1)}`,
    '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s', '--relative', '--', '.',
  ], signal, 'commit history')
  const fields = result.stdout.split('\0')
  const commits: WorkspaceGitCommit[] = []
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const commitFields = fields.slice(index, index + 6) as [string, string, string, string, string, string]
    const [hash, shortHash, authorName, authorEmail, authoredAt, subject] = commitFields
    if (hash === '') break
    commits.push({ hash, shortHash, authorName, authorEmail, authoredAt, subject })
  }
  return { commits: commits.slice(0, boundedLimit), truncated: result.overflow || commits.length > boundedLimit }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) return value
  return decodeUtf8Prefix(bytes.subarray(0, maxBytes))
}

/** Read a bounded working-tree or staged unified diff without external diff commands or textconv. */
export async function workspaceGitDiff(
  root: string,
  path: string | undefined,
  staged: boolean,
  signal: AbortSignal,
): Promise<{ diff: string; truncated: boolean }> {
  await assertGitRepository(root, signal)
  const result = await runGit(root, [
    'diff', '--no-ext-diff', '--no-textconv', '--relative', ...(staged ? ['--cached'] : []), '--', ...gitPath(root, path),
  ], signal, 'diff')
  const truncated = result.overflow || Buffer.byteLength(result.stdout) > WORKSPACE_DIFF_BYTE_LIMIT
  return { diff: truncateUtf8(result.stdout, WORKSPACE_DIFF_BYTE_LIMIT), truncated }
}
