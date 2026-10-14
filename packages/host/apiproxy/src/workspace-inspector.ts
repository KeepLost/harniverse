import { spawn } from 'node:child_process'
import { constants, type Dirent, type Stats } from 'node:fs'
import { open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { hostPriors, sniffAndDecode, utf8BoundaryEnd } from '@deepseek-ai/dsh-fs-codec'
import {
  compileGlobFilter, WORKSPACE_SEARCH_DEFAULT_EXCLUDES,
} from './api/workspace-glob.ts'

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
/** Maximum changed paths returned by one Git commit inspection. */
export const WORKSPACE_GIT_COMMIT_FILE_LIMIT = 500

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

/**
 * Optional glob scoping for one recursive search.
 *
 * Patterns follow the workspace glob contract (workspace-glob.ts): a pattern
 * without `/` filters basenames at any depth, one with `/` filters the whole
 * relative path, and a trailing `/` covers a directory subtree.
 */
export interface WorkspaceSearchFilters {
  /** Only files matching one of these patterns are returned; absent means every file. */
  include?: readonly string[]
  /**
   * Files and directory subtrees matching one of these patterns are skipped.
   * Absent or empty applies WORKSPACE_SEARCH_DEFAULT_EXCLUDES instead.
   */
  exclude?: readonly string[]
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

/** One decorated ref pointing at a commit, as `--decorate=full` reports it. */
export interface WorkspaceGitCommitRef {
  kind: 'head' | 'local' | 'remote' | 'tag' | 'other'
  name: string
  current: boolean
}

/** One bounded Git history row. */
export interface WorkspaceGitCommit {
  hash: string
  shortHash: string
  authorName: string
  authorEmail: string
  authoredAt: string
  subject: string
  parents: string[]
  refs: WorkspaceGitCommitRef[]
}

/** One changed path of a commit's first-parent diff. */
export interface WorkspaceGitCommitFile {
  path: string
  previousPath?: string
  status: 'A' | 'C' | 'D' | 'M' | 'R' | 'T'
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

/**
 * Resolve one workspace-relative request path to its absolute lexical target,
 * refusing NUL bytes, absolute inputs, and targets that escape the root.
 * @param root - registered canonical Workspace root.
 * @param path - workspace-relative request path ('' or '.' address the root).
 * @returns the absolute lexical target under the root.
 */
export function relativePath(root: string, path: string): string {
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

/**
 * Compare two absolute paths under the host platform's case rules.
 * @param left - one absolute path.
 * @param right - the other absolute path.
 * @returns whether both name the same filesystem path.
 */
export function sameFilesystemPath(left: string, right: string): boolean {
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
  /* v8 ignore next 3 -- containment fence over a resolver that answered out of
     tree: relativePath already confined the target to the canonical root and
     the symlink check above proved the canonical form equals it. */
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
    const descriptorPath = process.platform === 'linux'
    const readTarget = descriptorPath ? `/dev/fd/${handle.fd}` : target
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
    if (!descriptorPath) {
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
 * @param filters - optional include/exclude globs; an absent or empty exclude
 *   list applies the default dependency and build-output skips.
 * @returns bounded matching files and whether either search limit was reached.
 */
export async function searchWorkspaceFiles(
  root: string,
  query: string,
  signal: AbortSignal,
  filters: WorkspaceSearchFilters = {},
): Promise<{ entries: WorkspaceFileEntry[]; truncated: boolean }> {
  const needle = query.trim().toLowerCase()
  // Caller excludes replace the defaults rather than adding to them: a user who
  // writes an exclude list is scoping the search deliberately, and a hidden
  // extra list would make `dist/**` unsearchable with no way to opt out.
  const include = compileGlobFilter(filters.include, 'pass')
  const exclude = compileGlobFilter(
    filters.exclude === undefined || filters.exclude.length === 0
      ? WORKSPACE_SEARCH_DEFAULT_EXCLUDES
      : filters.exclude,
    'reject',
  )
  const directories = ['.']
  const entries: WorkspaceFileEntry[] = []
  let scanned = 0
  let directoryIndex = 0
  while (directoryIndex < directories.length) {
    const path = directories[directoryIndex++] as string
    // A directory that fills the remaining budget reports itself truncated and
    // returns below, so the budget is still positive on every entry here.
    const remaining = WORKSPACE_FILE_SEARCH_SCAN_LIMIT - scanned
    const result = await readDirectoryEntries(root, path, remaining, signal, false)
    result.entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of result.entries) {
      signal.throwIfAborted()
      scanned++
      const childPath = path === '.' ? child.name : `${path}/${child.name}`
      if (child.isDirectory()) {
        // Prune here rather than at match time: an excluded tree must not cost
        // scan budget, and an anchored include list makes the rest unreachable.
        if (exclude.matchesDirectory(childPath) || !include.mayContainMatch(childPath)) continue
        directories.push(childPath)
      } else if (
        child.isFile()
        && child.name.toLowerCase().includes(needle)
        && include.matches(childPath)
        && !exclude.matches(childPath)
      ) {
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
  /* v8 ignore next 2 -- reaching this needs four consecutive undecodable bytes at a diff truncation point. */
  throw new WorkspaceInspectorError('workspace-file-binary', 'workspace file is not valid UTF-8 text')
}

/**
 * Cut a truncated read at a sequence boundary so no decoder sees half of a
 * character: UTF-16 reads align to code units, everything else to the shared
 * UTF-8 boundary (which also never splits a dangling legacy lead).
 */
function trimIncompleteTail(bytes: Uint8Array, truncated: boolean): Uint8Array {
  if (!truncated) return bytes
  if (bytes.length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return bytes.subarray(0, bytes.length - (bytes.length - 2) % 2)
  }
  return bytes.subarray(0, utf8BoundaryEnd(bytes))
}

/** The result of one decoded preview read: content plus the decision that produced it. */
export interface WorkspaceTextPreview {
  path: string
  content: string
  bytes: number
  truncated: boolean
  encoding: string
  encodingSource: 'explicit' | 'sticky' | 'bom' | 'utf8' | 'host' | 'locale' | 'fallback'
  bom: boolean
  eol: 'LF' | 'CRLF'
}

/**
 * Read a bounded text prefix from one canonically contained Workspace file,
 * decoded through the shared codec: BOMs, strict UTF-8, the host-locale
 * legacy prior, or an explicitly named encoding. NUL bytes without a UTF-16
 * BOM reject as binary; a truncated read is cut at the last newline so no
 * partial sequence reaches a decoder.
 * @param root - registered canonical Workspace root.
 * @param path - Workspace-relative regular file.
 * @param signal - caller cancellation signal.
 * @param opts - optional explicit iconv-lite encoding name to re-open with.
 * @returns decoded content, full byte size, truncation state, and the decision.
 */
export async function readWorkspaceFile(
  root: string,
  path: string,
  signal: AbortSignal,
  opts: { encoding?: string } = {},
): Promise<WorkspaceTextPreview> {
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
    const truncated = info.size > bytesRead
    const sample = trimIncompleteTail(buffer.subarray(0, bytesRead), truncated)
    const outcome = sniffAndDecode(sample, {
      ...(opts.encoding === undefined ? {} : { explicit: opts.encoding }),
      priors: await hostPriors(),
    })
    if (!outcome.ok) {
      const requested = opts.encoding ?? ''
      /* v8 ignore start -- the probe list's total pages leave no reachable zero-candidate rejection. */
      const detail = outcome.reason === 'explicit'
        ? `workspace file ${JSON.stringify(path)} is not decodable as ${requested}`
        : outcome.candidates.length > 0
          ? `workspace file ${JSON.stringify(path)} is not decodable text (viable encodings: ${outcome.candidates.join(', ')})`
          : `workspace file ${JSON.stringify(path)} is not valid text`
      /* v8 ignore stop */
      throw new WorkspaceInspectorError('workspace-file-binary', detail, path)
    }
    return {
      path,
      content: outcome.text,
      bytes: info.size,
      truncated,
      encoding: outcome.decision.encoding,
      encodingSource: outcome.decision.source,
      bom: outcome.decision.bom,
      eol: outcome.decision.eol,
    }
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
    const descriptorRoot = process.platform === 'linux'
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
        if (operationSignal.aborted) {
          reject(signal.aborted
            ? signal.reason instanceof Error ? signal.reason : new Error('workspace Git operation was cancelled')
            : new WorkspaceInspectorError('workspace-git-failed', `Git ${operation} timed out`, undefined, operation))
          return
        }
        if (code === 0) {
          resolvePromise({ stdout, stderr, overflow: false })
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
 * @returns branch, its optional upstream with ahead/behind counts, bounded status
 *   entries, and truncation state.
 */
export async function workspaceGitStatus(
  root: string,
  signal: AbortSignal,
): Promise<{
  branch: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  entries: WorkspaceGitStatusEntry[]
  truncated: boolean
}> {
  await assertGitRepository(root, signal)
  const result = await runGit(root, [
    'status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all', '--ignored=no', '--', '.',
  ], signal, 'status')
  const records = result.stdout.split('\0')
  // `split` always yields at least one element, so the leading branch record
  // and the upstream split below are both definite.
  const branchRecord = records.shift() as string
  const branchText = branchRecord.startsWith('## ') ? branchRecord.slice(3) : ''
  const branch = branchText.startsWith('No commits yet on ')
    ? branchText.slice('No commits yet on '.length)
    : branchText === 'HEAD (no branch)' || branchText === ''
      ? null
      : branchText.split('...')[0] as string
  let upstream: string | null = null
  let ahead: number | null = null
  let behind: number | null = null
  const separator = branchText.indexOf('...')
  if (separator !== -1) {
    const section = branchText.slice(separator + 3)
    const bracket = / \[[^\]]*\]$/.exec(section)
    const upstreamName = bracket === null ? section : section.slice(0, bracket.index)
    /* v8 ignore next 2 -- porcelain always names the upstream after '...'; an empty name is malformed input. */
    if (upstreamName !== '') {
      upstream = upstreamName
      ahead = 0
      behind = 0
      if (bracket !== null) {
        for (const marker of bracket[0].slice(2, -1).split(', ')) {
          if (marker.startsWith('ahead ')) ahead = Number(marker.slice('ahead '.length))
          else if (marker.startsWith('behind ')) behind = Number(marker.slice('behind '.length))
        }
      }
    }
  }
  const entries: WorkspaceGitStatusEntry[] = []
  for (let index = 0; index < records.length && entries.length < WORKSPACE_GIT_STATUS_LIMIT; index++) {
    const record = records[index]
    if (record === undefined || record === '') continue
    // A non-empty record always has its first column; a truncated one may stop
    // before the second.
    const indexStatus = record[0] as string
    const worktreeStatus = record[1] ?? ' '
    const path = record.slice(3)
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const originalPath = renamed ? records[++index] : undefined
    entries.push({ path, indexStatus, worktreeStatus, ...(originalPath === undefined ? {} : { originalPath }) })
  }
  const nonEmptyRecords = records.filter(record => record !== '').length
  return {
    branch,
    upstream,
    ahead,
    behind,
    entries,
    truncated: result.overflow || nonEmptyRecords > entries.length + entries.filter(entry => entry.originalPath !== undefined).length,
  }
}

function parseGitDecoration(value: string): WorkspaceGitCommitRef[] {
  if (value === '') return []
  const refs: WorkspaceGitCommitRef[] = []
  for (const token of value.split(', ')) {
    if (token === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD', current: true })
      continue
    }
    const arrow = token.indexOf(' -> ')
    if (arrow !== -1) {
      refs.push({ kind: 'head', name: 'HEAD', current: true })
      refs.push(...decoratedRef(token.slice(arrow + 4), true))
      continue
    }
    if (token.startsWith('tag: ')) {
      const ref = token.slice('tag: '.length)
      /* v8 ignore next -- --decorate=full always emits refs/-prefixed tag names, so the fallback never runs. */
      refs.push({ kind: 'tag', name: ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : stripRefPrefix(ref), current: false })
      continue
    }
    refs.push(...decoratedRef(token, false))
  }
  return refs
}

function decoratedRef(ref: string, current: boolean): WorkspaceGitCommitRef[] {
  if (ref.startsWith('refs/heads/')) return [{ kind: 'local', name: ref.slice('refs/heads/'.length), current }]
  /* v8 ignore next -- remotes is the last namespace log --decorate emits, so this condition never falls through. */
  if (ref.startsWith('refs/remotes/')) return [{ kind: 'remote', name: ref.slice('refs/remotes/'.length), current }]
  /* v8 ignore next 2 -- log --decorate emits only HEAD, heads, tags, and remotes; the arm keeps the wire type total. */
  return [{ kind: 'other', name: stripRefPrefix(ref), current: false }]
}

/* v8 ignore next 3 -- reachable only through the ignored other arm; the passthrough guards malformed output. */
function stripRefPrefix(ref: string): string {
  return ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref
}

/**
 * Read a bounded, unsimplified commit history of the Workspace repository:
 * merges are listed, so a listed commit's parent is either listed or lies
 * beyond the window.
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
    'log', '-z', `--max-count=${String(boundedLimit + 1)}`, '--topo-order', '--decorate=full',
    '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%P%x00%D',
  ], signal, 'commit history')
  const fields = result.stdout.split('\0')
  const commits: WorkspaceGitCommit[] = []
  for (let index = 0; index + 7 < fields.length; index += 8) {
    const commitFields = fields.slice(index, index + 8) as [string, string, string, string, string, string, string, string]
    const [hash, shortHash, authorName, authorEmail, authoredAt, subject, parentsText, decoration] = commitFields
    /* v8 ignore next -- a complete 8-field record always carries a non-empty hash; only a corrupt stream breaks here. */
    if (hash === '') break
    commits.push({
      hash,
      shortHash,
      authorName,
      authorEmail,
      authoredAt,
      subject,
      parents: parentsText === '' ? [] : parentsText.split(' '),
      refs: parseGitDecoration(decoration),
    })
  }
  return { commits: commits.slice(0, boundedLimit), truncated: result.overflow || commits.length > boundedLimit }
}

const GIT_COMMIT_HASH = /^[0-9a-f]{40}$/u

function gitCommitHash(hash: string): string {
  if (!GIT_COMMIT_HASH.test(hash)) {
    throw new WorkspaceInspectorError(
      'workspace-git-failed',
      'Git commit hash must be a full 40-character lowercase hex SHA',
      undefined,
      'commit hash validation',
    )
  }
  return hash
}

async function gitCommitParents(root: string, hash: string, signal: AbortSignal): Promise<string[]> {
  const result = await runGit(root, ['rev-list', '--parents', '-n1', hash], signal, 'commit parent lookup')
  const fields = result.stdout.trim().split(' ')
  return fields.slice(1)
}

/**
 * Read one commit's changed paths against its first parent (or the empty tree
 * for a root commit), with rename and copy detection.
 * @param root - registered canonical Workspace root.
 * @param hash - full 40-character hex SHA of the commit.
 * @param signal - caller cancellation signal.
 * @returns bounded changed paths and truncation state.
 */
export async function workspaceGitCommitFiles(
  root: string,
  hash: string,
  signal: AbortSignal,
): Promise<{ files: WorkspaceGitCommitFile[]; truncated: boolean }> {
  gitCommitHash(hash)
  await assertGitRepository(root, signal)
  const parents = await gitCommitParents(root, hash, signal)
  const result = await runGit(root, parents.length === 0
    ? ['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--name-status', '-M', hash]
    : ['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '-M', parents[0] as string, hash], signal, 'commit file listing')
  const records = result.stdout.split('\0')
  const files: WorkspaceGitCommitFile[] = []
  let truncated = false
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record === undefined || record === '') continue
    if (files.length >= WORKSPACE_GIT_COMMIT_FILE_LIMIT) {
      truncated = true
      break
    }
    const status = record.replace(/[0-9]+$/u, '') as WorkspaceGitCommitFile['status']
    const paired = status === 'R' || status === 'C'
    const previousPath = paired ? records[++index] : undefined
    /* v8 ignore next -- diff-tree -z records end on complete groups; only a byte-cap cut could split one. */
    const path = records[++index] ?? ''
    files.push({ path, status, ...(previousPath === undefined ? {} : { previousPath }) })
  }
  return { files, truncated: truncated || result.overflow }
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
    '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--relative', ...(staged ? ['--cached'] : []), '--', ...gitPath(root, path),
  ], signal, 'diff')
  const truncated = result.overflow || Buffer.byteLength(result.stdout) > WORKSPACE_DIFF_BYTE_LIMIT
  return { diff: truncateUtf8(result.stdout, WORKSPACE_DIFF_BYTE_LIMIT), truncated }
}

/**
 * Read one commit's unified patch for a single Workspace-relative path,
 * differring against the first parent (or the empty tree for a root commit).
 * A path the commit did not touch answers with an empty diff rather than an error.
 * @param root - registered canonical Workspace root.
 * @param hash - full 40-character hex SHA of the commit.
 * @param path - Workspace-relative path restriction.
 * @param signal - caller cancellation signal.
 * @returns unified diff text and truncation state.
 */
export async function workspaceGitCommitDiff(
  root: string,
  hash: string,
  path: string,
  signal: AbortSignal,
): Promise<{ diff: string; truncated: boolean }> {
  gitCommitHash(hash)
  await assertGitRepository(root, signal)
  relativePath(root, path)
  const parents = await gitCommitParents(root, hash, signal)
  const target = parents.length === 0 ? ['--root', hash] : [parents[0] as string, hash]
  const result = await runGit(root, [
    '--literal-pathspecs', 'diff-tree', '-r', '-p', '--no-commit-id', '--no-ext-diff', '--no-textconv', '-M', ...target, '--', path,
  ], signal, 'commit diff')
  const truncated = result.overflow || Buffer.byteLength(result.stdout) > WORKSPACE_DIFF_BYTE_LIMIT
  return { diff: truncateUtf8(result.stdout, WORKSPACE_DIFF_BYTE_LIMIT), truncated }
}
