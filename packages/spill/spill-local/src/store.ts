/**
 * Cordis-free storage mechanics for the local spill backend: private
 * session-scoped directory selection, safe-name derivation, path-traversal
 * protection, opaque locator paging, and the exclusive owner-only write. Kept out of the service class
 * (like `dsh-bash-local`'s `run.ts`) so the filesystem behavior is unit-testable
 * without a `ctx`.
 *
 * @module @deepseek-ai/dsh-spill-local/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const LOCAL_LOCATOR_PREFIX = 'local-spill:v1:'
const CURSOR_PREFIX = 'v1:'
const MAX_READ_CHARS = 50_000

/**
 * The default spill root in durable Harniverse home storage. Session hashing,
 * unpredictable filenames, exclusive writes, and opaque locator validation
 * prevent traversal and planted-symlink redirects without exposing host paths.
 *
 * @returns The durable local artifact root.
 */
export function privateRoot(): string {
  return dshHomePath('artifacts', 'tool-results')
}

// Deliberately mirrors the JSONL path encoder, but keeps spill's empty-name
// policy (`""` -> `"~"`) local so storage backends stay decoupled.
/* jscpd:ignore-start */
/**
 * Encode an arbitrary string as one safe path segment, injectively over ALL JS
 * (UTF-16) strings. A session id / suggested name is untrusted input, so this
 * neutralizes `../`, absolute paths, NUL, and separators before any filesystem
 * use. Each code unit is kept literal (`[A-Za-z0-9._-]`, minus `~`) or escaped
 * as `~XXXX`; `~` is itself escaped, so the mapping is reversible and distinct
 * inputs never collide. The whole-segment tokens `.`/`..` are escaped so they
 * can never traverse. An empty string encodes to `~` (never an empty segment).
 * (Mirrors the JSONL persistence backend's `encodeSegment`.)
 *
 * @param raw The untrusted string to encode as one safe path segment.
 * @returns An injective, filesystem-safe single path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}
/* jscpd:ignore-end */

/**
 * The session-scoped directory: `<root>/session-<hash(sessionId)>`, a short stable hash.
 *
 * @param root The spill root directory.
 * @param sessionId The owning session id to hash into a stable directory name.
 * @returns The absolute session-scoped spill directory path.
 */
export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

/** Options for {@link saveTextFile} — the resolved root and the request fields the store needs. */
export interface SaveTextOptions {
  /** Caller-owned cancellation for directory admission and persistence. */
  signal: AbortSignal
  /** The spill root directory (configured or the lazy private default). */
  root: string
  /** The owning session id (scopes the directory). */
  sessionId: string
  /** Caller-suggested base name; sanitized to one safe segment before use. */
  suggestedName: string
  /** The full text to persist. */
  content: string
}

/** A written spill file. */
export interface SavedText {
  path: string
  bytes: number
}

/**
 * Build the short backend-owned locator persisted in tool-result events.
 * @param root The configured artifact root.
 * @param path The saved leaf path under one session directory.
 * @returns The opaque local spill locator.
 */
export function localLocator(root: string, path: string): string {
  const relativePath = relative(root, path)
  const dir = relativePath.split(sep)
  if (dir.length !== 2 || !dir[0]?.startsWith('session-') || dir[0].length !== 20 || dir[1] === '') {
    throw new Error('saved spill path is outside the expected session layout')
  }
  return `${LOCAL_LOCATOR_PREFIX}${dir[0].slice('session-'.length)}/${dir[1]}`
}

/** Resolve and validate a local locator without accepting paths or traversal. */
function pathForLocator(root: string, locator: string): string {
  const match = /^local-spill:v1:([0-9a-f]{12})\/([A-Za-z0-9._~-]+)$/.exec(locator)
  if (match === null) throw new Error('invalid local spill locator')
  const sessionHash = match[1]
  const fileName = match[2]
  if (sessionHash === undefined || fileName === undefined) throw new Error('invalid local spill locator')
  return join(root, `session-${sessionHash}`, fileName)
}

/** Parse a local UTF-8 byte cursor. */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const match = /^v1:(0|[1-9][0-9]*)$/.exec(cursor)
  const offset = match === null ? Number.NaN : Number(match[1])
  if (!Number.isSafeInteger(offset)) throw new Error('invalid local spill cursor')
  return offset
}

/** Decode the largest complete UTF-8 prefix, rejecting corrupt stored text. */
function decodeCompletePrefix(buffer: Buffer, eof: boolean): string {
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim++) {
    try {
      const candidate = buffer.subarray(0, buffer.length - trim)
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(candidate)
      if (trim > 0 && eof) throw new Error('stored spill artifact is not valid UTF-8')
      return decoded
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'stored spill artifact is not valid UTF-8') throw error
    }
  }
  throw new Error('stored spill artifact is not valid UTF-8')
}

/** Require one storage directory to be a private, process-owned real directory. */
async function validatePrivateDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`)
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or world access`)
  }
}

/** Walk one absolute directory path without following symlinks in any component. */
async function ensureRealDirectoryPath(path: string, create: boolean): Promise<void> {
  const absolute = resolve(path)
  const anchor = parse(absolute).root
  let current = anchor
  for (const segment of relative(anchor, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment)
    let stat
    try {
      stat = await lstat(current)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error
      await mkdir(current, { mode: 0o700 }).catch((mkdirError: unknown) => {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      })
      stat = await lstat(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('spill storage path component must be a real directory')
    }
  }
}

/** Validate the root and one direct private session directory before leaf I/O. */
async function validateStoragePath(root: string, sessionPath: string): Promise<void> {
  await ensureRealDirectoryPath(root, false)
  await ensureRealDirectoryPath(sessionPath, false)
  await validatePrivateDirectory(root, 'spill root')
  await validatePrivateDirectory(sessionPath, 'spill session directory')
  const [realRoot, realSession] = await Promise.all([realpath(root), realpath(sessionPath)])
  if (dirname(realSession) !== realRoot) throw new Error('spill session directory is outside the configured root')
}

/**
 * Read a bounded Unicode page from one validated local artifact.
 * @param options The root, opaque locator, optional cursor, page bound, and cancellation signal.
 * @returns The exact page and a continuation cursor when unread text remains.
 */
export async function readTextFile(options: {
  signal: AbortSignal
  root: string
  locator: string
  cursor?: string
  maxChars: number
}): Promise<{ text: string; nextCursor?: string }> {
  options.signal.throwIfAborted()
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1 || options.maxChars > MAX_READ_CHARS) {
    throw new Error(`spill read maxChars must be an integer from 1 to ${MAX_READ_CHARS}`)
  }
  const offset = parseCursor(options.cursor)
  const path = pathForLocator(options.root, options.locator)
  await validateStoragePath(options.root, dirname(path))
  options.signal.throwIfAborted()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    options.signal.throwIfAborted()
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('local spill locator does not identify a regular file')
    if (offset > stat.size) throw new Error('local spill cursor exceeds artifact length')
    if (offset === stat.size) return { text: '' }

    const boundary = Buffer.allocUnsafe(1)
    await handle.read(boundary, 0, 1, offset)
    const boundaryByte = boundary[0]
    if (boundaryByte === undefined) throw new Error('local spill cursor could not be read')
    if ((boundaryByte & 0xc0) === 0x80) throw new Error('local spill cursor is not at a UTF-8 boundary')

    const wanted = Math.min(stat.size - offset, options.maxChars * 4 + 4)
    const bytes = Buffer.allocUnsafe(wanted)
    let read = 0
    while (read < wanted) {
      options.signal.throwIfAborted()
      const chunk = await handle.read(bytes, read, wanted - read, offset + read)
      if (chunk.bytesRead === 0) break
      read += chunk.bytesRead
    }
    const eof = offset + read === stat.size
    const decoded = decodeCompletePrefix(bytes.subarray(0, read), eof)
    let text = ''
    let count = 0
    for (const codePoint of decoded) {
      if (count === options.maxChars) break
      text += codePoint
      count++
    }
    const nextOffset = offset + Buffer.byteLength(text, 'utf8')
    return nextOffset < stat.size
      ? { text, nextCursor: `${CURSOR_PREFIX}${nextOffset}` }
      : { text }
  } finally {
    await handle.close()
  }
}

/**
 * Write `content` to a fresh file under the session-scoped directory and return
 * its path + byte length. The filename is a random hex prefix plus the
 * sanitized `suggestedName`, so it is unpredictable (defeats symlink planting in
 * a shared root) AND stays readable. The open is exclusive + owner-only
 * (`'wx', 0o600`): it fails on any existing path — symlink or not — so a
 * pre-planted target cannot redirect the write.
 *
 * @param options The resolved root and request fields required to save the file.
 * @returns The written file path and UTF-8 byte length.
 */
export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  options.signal.throwIfAborted()
  const dir = sessionDir(options.root, options.sessionId)
  await ensureRealDirectoryPath(options.root, true)
  await validatePrivateDirectory(options.root, 'spill root')
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  await validateStoragePath(options.root, dir)
  options.signal.throwIfAborted()
  const safeName = encodeSegment(options.suggestedName)
  const path = join(dir, `${randomBytes(6).toString('hex')}-${safeName}`)
  const bytes = Buffer.byteLength(options.content, 'utf8')
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(options.content, { signal: options.signal })
  } finally {
    await handle.close()
  }
  return { path, bytes }
}
