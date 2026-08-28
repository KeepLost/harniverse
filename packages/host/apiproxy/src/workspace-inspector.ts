import { spawn } from 'node:child_process'
import { constants, type Dirent, type Stats } from 'node:fs'
import { open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Maximum immediate children returned by one directory listing. */
export const WORKSPACE_DIRECTORY_ENTRY_LIMIT = 2_000
/** Maximum UTF-8 prefix bytes returned by one text read. */
export const WORKSPACE_FILE_BYTE_LIMIT = 1024 * 1024
/** Maximum complete image or PDF bytes returned by one binary read. */
export const WORKSPACE_BINARY_BYTE_LIMIT = 8 * 1024 * 1024
/** Maximum regular-file matches returned by one recursive search. */
export const WORKSPACE_FILE_SEARCH_RESULT_LIMIT = 200
/** Maximum filesystem entries inspected by one recursive search. */
export const WORKSPACE_FILE_SEARCH_SCAN_LIMIT = 20_000
/** Maximum UTF-8 bytes returned by one Git diff. */
export const WORKSPACE_DIFF_BYTE_LIMIT = 1024 * 1024
/** Maximum changed paths returned by one Git status read. */
export const WORKSPACE_GIT_STATUS_LIMIT = 2_000
/** Maximum commits returned by one Git history read. */
export const WORKSPACE_GIT_COMMIT_LIMIT = 100

type WorkspaceInspectorErrorCode =
  | 'workspace-path-invalid'
  | 'workspace-entry-not-found'
  | 'workspace-entry-not-readable'
  | 'workspace-entry-type-invalid'
  | 'workspace-file-binary'
  | 'workspace-file-preview-unsupported'
  | 'workspace-file-too-large'
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

/** One workspace-relative directory child or search result. */
export interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
}

/** One parsed porcelain-v1 Git status entry. */
export interface WorkspaceGitStatusEntry {
  path: string
  indexStatus: string
  worktreeStatus: string
  originalPath?: string
}

/** One bounded Git history row. */
export interface WorkspaceGitCommit {
  hash: string
  shortHash: string
  authorName: string
  authorEmail: string
  authoredAt: string
  subject: string
}

const PREVIEW_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

const READ_ONLY_NOFOLLOW_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW
const READ_FILE_FLAGS = READ_ONLY_NOFOLLOW_FLAGS | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)

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

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function containedPath(root: string, path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let canonicalRoot: string
  let canonicalTarget: string
  try {
    canonicalRoot = await realpath(root)
    if (!sameFilesystemPath(canonicalRoot, resolve(root))) {
      throw new WorkspaceInspectorError(
        'workspace-path-invalid',
        'the registered workspace path no longer resolves to its canonical directory',
        path,
      )
    }
    const target = relativePath(canonicalRoot, path)
    canonicalTarget = await realpath(target)
    if (!sameFilesystemPath(canonicalTarget, target)) {
      throw new WorkspaceInspectorError(
        'workspace-path-invalid',
        `workspace path ${JSON.stringify(path)} contains a symbolic link`,
        path,
      )
    }
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

async function readDirectoryEntries(
  root: string,
  path: string,
  limit: number,
  signal: AbortSignal,
  detectOverflow = true,
): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const target = await containedPath(root, path, signal)
  let handle
  let directory
  try {
    handle = await open(target, READ_ONLY_NOFOLLOW_FLAGS | constants.O_DIRECTORY)
    await openedPathInfo(root, path, target, handle, signal, 'directory')
    const readTarget = process.platform === 'win32' ? target : `/dev/fd/${handle.fd}`
    directory = await opendir(readTarget)
    const entries: Dirent[] = []
    const readLimit = limit + (detectOverflow ? 1 : 0)
    let exhausted = false
    while (entries.length < readLimit) {
      signal.throwIfAborted()
      const entry = await directory.read()
      if (entry === null) {
        exhausted = true
        break
      }
      entries.push(entry)
    }
    if (process.platform === 'win32') {
      await openedPathInfo(root, path, target, handle, signal, 'directory')
    }
    const truncated = !exhausted && (detectOverflow ? entries.length > limit : entries.length === limit)
    return { entries: entries.slice(0, limit), truncated }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof WorkspaceInspectorError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') {
      throw new WorkspaceInspectorError('workspace-path-invalid', `workspace path ${JSON.stringify(path)} contains a symbolic link`, path)
    }
    if (code === 'ENOENT') {
      throw new WorkspaceInspectorError('workspace-entry-not-found', `workspace entry ${JSON.stringify(path)} was not found`, path)
    }
    if (code === 'ENOTDIR') {
      throw new WorkspaceInspectorError('workspace-entry-type-invalid', `workspace entry ${JSON.stringify(path)} is not a directory`, path)
    }
    throw new WorkspaceInspectorError('workspace-entry-not-readable', `workspace directory ${JSON.stringify(path)} cannot be read`, path)
  } finally {
    await directory?.close()
    await handle?.close()
  }
}

/**
 * Verify that an opened descriptor still names the contained lexical path.
 * @param root - registered canonical Workspace root.
 * @param path - Workspace-relative entry.
 * @param target - validated lexical target.
 * @param handle - opened no-follow descriptor.
 * @param signal - caller cancellation signal.
 * @param kind - required descriptor kind.
 * @returns descriptor metadata after identity validation.
 */
export async function openedPathInfo(
  root: string,
  path: string,
  target: string,
  handle: FileHandle,
  signal: AbortSignal,
  kind: 'file' | 'directory',
): Promise<Stats> {
  const info = await handle.stat()
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw new WorkspaceInspectorError('workspace-entry-type-invalid', `workspace entry ${JSON.stringify(path)} is not a ${kind}`, path)
  }
  const currentTarget = await containedPath(root, path, signal)
  const currentInfo = await stat(currentTarget)
  if (!sameFilesystemPath(currentTarget, target) || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) {
    throw new WorkspaceInspectorError('workspace-path-invalid', `workspace file ${JSON.stringify(path)} changed while opening`, path)
  }
  return info
}

/**
 * Fill a fixed buffer across legal short reads.
 * @param handle - opened regular-file descriptor.
 * @param buffer - destination buffer.
 * @param signal - caller cancellation signal.
 * @returns bytes read before the buffer filled or EOF arrived.
 */
export async function readIntoBuffer(handle: FileHandle, buffer: Buffer, signal: AbortSignal): Promise<number> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
    signal.throwIfAborted()
  }
  return offset
}

function entryKind(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): WorkspaceFileEntry['kind'] {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'directory'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

/**
 * List one workspace directory without name-based exclusions.
 * @param root - registered canonical Workspace root.
 * @param path - Workspace-relative directory.
 * @param signal - caller cancellation signal.
 * @returns the bounded, directory-first immediate children.
 */
export async function listWorkspaceFiles(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<{ path: string; entries: WorkspaceFileEntry[]; truncated: boolean }> {
  const result = await readDirectoryEntries(root, path, WORKSPACE_DIRECTORY_ENTRY_LIMIT, signal)
  signal.throwIfAborted()
  result.entries.sort((left, right) => {
    const leftDirectory = left.isDirectory() ? 0 : 1
    const rightDirectory = right.isDirectory() ? 0 : 1
    return leftDirectory - rightDirectory || left.name.localeCompare(right.name)
  })
  const entries = result.entries.map(entry => ({
    name: entry.name,
    path: path === '.' || path === '' ? entry.name : `${path.replace(/\/$/u, '')}/${entry.name}`,
    kind: entryKind(entry),
  }))
  return { path, entries, truncated: result.truncated }
}

/**
 * Search regular-file names recursively without following symbolic links.
 * @param root - registered canonical Workspace root.
 * @param query - case-insensitive file-name substring.
 * @param signal - caller cancellation signal.
 * @returns bounded matching files and whether either search limit was reached.
 */
export async function searchWorkspaceFiles(
  root: string,
  query: string,
  signal: AbortSignal,
): Promise<{ entries: WorkspaceFileEntry[]; truncated: boolean }> {
  const needle = query.trim().toLowerCase()
  const directories = ['.']
  const entries: WorkspaceFileEntry[] = []
  let scanned = 0
  let directoryIndex = 0
  while (directoryIndex < directories.length) {
    const path = directories[directoryIndex++] as string
    const remaining = WORKSPACE_FILE_SEARCH_SCAN_LIMIT - scanned
    if (remaining === 0) return { entries, truncated: true }
    const result = await readDirectoryEntries(root, path, remaining, signal, false)
    result.entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of result.entries) {
      signal.throwIfAborted()
      scanned++
      const childPath = path === '.' ? child.name : `${path}/${child.name}`
      if (child.isDirectory()) {
        directories.push(childPath)
      } else if (child.isFile() && child.name.toLowerCase().includes(needle)) {
        entries.push({ name: child.name, path: childPath, kind: 'file' })
        if (entries.length >= WORKSPACE_FILE_SEARCH_RESULT_LIMIT) return { entries, truncated: true }
      }
    }
    if (result.truncated) return { entries, truncated: true }
  }
  return { entries, truncated: false }
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

/**
 * Read a bounded UTF-8 text prefix from one canonically contained Workspace file.
 * @param root - registered canonical Workspace root.
 * @param path - Workspace-relative regular file.
 * @param signal - caller cancellation signal.
 * @returns UTF-8 content, full byte size, and truncation state.
 */
export async function readWorkspaceFile(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<{ path: string; content: string; bytes: number; truncated: boolean }> {
  const target = await containedPath(root, path, signal)
  let handle
  try {
    handle = await open(target, READ_FILE_FLAGS)
    const info = await openedPathInfo(root, path, target, handle, signal, 'file')
    const length = Math.min(info.size, WORKSPACE_FILE_BYTE_LIMIT)
    const buffer = Buffer.allocUnsafe(length)
    const bytesRead = await readIntoBuffer(handle, buffer, signal)
    const finalInfo = await handle.stat()
    if (bytesRead !== length || finalInfo.size !== info.size) {
      throw new WorkspaceInspectorError('workspace-entry-not-readable', `workspace file ${JSON.stringify(path)} changed while reading`, path)
    }
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
    if (code === 'ELOOP') {
      throw new WorkspaceInspectorError('workspace-path-invalid', `workspace path ${JSON.stringify(path)} contains a symbolic link`, path)
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new WorkspaceInspectorError('workspace-entry-not-found', `workspace file ${JSON.stringify(path)} was not found`, path)
    }
    throw new WorkspaceInspectorError('workspace-entry-not-readable', `workspace file ${JSON.stringify(path)} cannot be read`, path)
  } finally {
    await handle?.close()
  }
}

/**
 * Read one complete, bounded image or PDF for an in-browser object-URL preview.
 * @param root - registered canonical Workspace root.
 * @param path - Workspace-relative allowlisted image or PDF.
 * @param signal - caller cancellation signal.
 * @returns complete base64 data, media type, and byte size.
 */
export async function readWorkspaceBinary(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<{ path: string; dataBase64: string; mediaType: string; bytes: number }> {
  const target = await containedPath(root, path, signal)
  const mediaType = PREVIEW_MEDIA_TYPES[extname(path).toLowerCase()]
  if (mediaType === undefined) {
    throw new WorkspaceInspectorError(
      'workspace-file-preview-unsupported',
      `workspace file ${JSON.stringify(path)} is not a supported image or PDF`,
      path,
    )
  }
  let handle
  try {
    handle = await open(target, READ_FILE_FLAGS)
    const info = await openedPathInfo(root, path, target, handle, signal, 'file')
    if (info.size > WORKSPACE_BINARY_BYTE_LIMIT) {
      throw new WorkspaceInspectorError(
        'workspace-file-too-large',
        `workspace file ${JSON.stringify(path)} exceeds the binary preview limit`,
        path,
      )
    }
    const buffer = Buffer.allocUnsafe(info.size)
    const bytesRead = await readIntoBuffer(handle, buffer, signal)
    const finalInfo = await handle.stat()
    if (bytesRead !== info.size || finalInfo.size !== info.size) {
      throw new WorkspaceInspectorError('workspace-entry-not-readable', `workspace file ${JSON.stringify(path)} changed while reading`, path)
    }
    signal.throwIfAborted()
    return { path, dataBase64: buffer.toString('base64'), mediaType, bytes: bytesRead }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof WorkspaceInspectorError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') {
      throw new WorkspaceInspectorError('workspace-path-invalid', `workspace path ${JSON.stringify(path)} contains a symbolic link`, path)
    }
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

async function runGit(root: string, args: readonly string[], signal: AbortSignal, operation: string): Promise<GitResult> {
  const target = await containedPath(root, '.', signal)
  const handle = await open(target, READ_ONLY_NOFOLLOW_FLAGS | constants.O_DIRECTORY)
  try {
    await openedPathInfo(root, '.', target, handle, signal, 'directory')
    const descriptorRoot = process.platform !== 'win32'
    const gitRoot = descriptorRoot ? '/dev/fd/3' : target
    const operationSignal = abortSignal(signal)
    const environment: NodeJS.ProcessEnv = {
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    }
    for (const key of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
      if (process.env[key] !== undefined) environment[key] = process.env[key]
    }
    const result = await new Promise<GitResult>((resolvePromise, reject) => {
      const child = spawn('git', ['-C', gitRoot, '-c', 'core.fsmonitor=false', ...args], {
        env: environment,
        signal: operationSignal,
        stdio: descriptorRoot ? ['ignore', 'pipe', 'pipe', handle.fd] : ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const maxBuffer = WORKSPACE_DIFF_BYTE_LIMIT + 64 * 1024
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let overflow = false
      let processError: Error | undefined
      const append = (chunks: Buffer[], bytes: number, chunk: Buffer): number => {
        const remaining = Math.max(0, maxBuffer - bytes)
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        if (chunk.length > remaining) {
          overflow = true
          child.kill()
        }
        return bytes + chunk.length
      }
      const stdout = child.stdout as NonNullable<typeof child.stdout>
      const stderr = child.stderr as NonNullable<typeof child.stderr>
      stdout.on('data', (chunk: Buffer) => { stdoutBytes = append(stdoutChunks, stdoutBytes, chunk) })
      stderr.on('data', (chunk: Buffer) => { stderrBytes = append(stderrChunks, stderrBytes, chunk) })
      child.once('error', (error) => { processError = error })
      child.once('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8')
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        if (overflow) {
          resolvePromise({ stdout, stderr, overflow: true })
          return
        }
        if (code === 0) {
          resolvePromise({ stdout, stderr, overflow: false })
          return
        }
        if (operationSignal.aborted) {
          reject(signal.aborted
            ? signal.reason instanceof Error ? signal.reason : new Error('workspace Git operation was cancelled')
            : new WorkspaceInspectorError('workspace-git-failed', `Git ${operation} timed out`, undefined, operation))
          return
        }
        if (processError !== undefined) {
          reject(processError)
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
    if (!descriptorRoot) {
      await openedPathInfo(root, '.', target, handle, signal, 'directory')
    }
    return result
  } finally {
    await handle.close()
  }
}

async function assertGitRepository(root: string, signal: AbortSignal): Promise<void> {
  await containedPath(root, '.', signal)
  const [worktreeResult, gitDirectoryResult] = await Promise.all([
    runGit(root, ['rev-parse', '--path-format=absolute', '--show-toplevel'], signal, 'work-tree check'),
    runGit(root, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], signal, 'metadata check'),
  ])
  const removeLineEnding = (value: string): string => value.endsWith('\r\n')
    ? value.slice(0, -2)
    : value.endsWith('\n') ? value.slice(0, -1) : value
  const worktree = removeLineEnding(worktreeResult.stdout)
  const gitDirectory = removeLineEnding(gitDirectoryResult.stdout)
  if (worktree === '' || gitDirectory === '') {
    throw new WorkspaceInspectorError('workspace-git-not-repository', 'workspace is not inside a Git work tree')
  }
  let canonicalWorktree: string
  let canonicalGitDirectory: string
  try {
    [canonicalWorktree, canonicalGitDirectory] = await Promise.all([realpath(worktree), realpath(gitDirectory)])
  } catch {
    throw new WorkspaceInspectorError('workspace-git-failed', 'workspace Git metadata cannot be resolved', undefined, 'repository check')
  }
  const gitRelative = relative(root, canonicalGitDirectory)
  const gitContained = gitRelative === '' || (gitRelative !== '..' && !gitRelative.startsWith(`..${sep}`) && !isAbsolute(gitRelative))
  if (!sameFilesystemPath(root, canonicalWorktree) || !gitContained) {
    throw new WorkspaceInspectorError('workspace-git-failed', 'workspace Git repository escapes the registered root', undefined, 'repository check')
  }
}

function gitPath(root: string, path: string | undefined): string[] {
  if (path === undefined) return ['.']
  relativePath(root, path)
  return [path]
}

/**
 * Read porcelain status with untracked files expanded instead of directory-collapsed.
 * @param root - registered canonical Workspace root.
 * @param signal - caller cancellation signal.
 * @returns branch, bounded status entries, and truncation state.
 */
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

/**
 * Read a bounded Workspace-path commit history.
 * @param root - registered canonical Workspace root.
 * @param limit - requested maximum commit count.
 * @param signal - caller cancellation signal.
 * @returns parsed commits and whether more history exists.
 */
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

/**
 * Read a bounded working-tree or staged unified diff without external diff commands or textconv.
 * @param root - registered canonical Workspace root.
 * @param path - optional Workspace-relative path restriction.
 * @param staged - whether to diff the index instead of the working tree.
 * @param signal - caller cancellation signal.
 * @returns unified diff text and truncation state.
 */
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
