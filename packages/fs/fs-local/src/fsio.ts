/**
 * Cordis-free local filesystem mechanics. This provider layer returns validated UTF-8 text,
 * streams large files, and rejects binary data; line windows belong to `dsh-tool-fs`. Writes
 * stage an exclusive owner-only file in a private sibling directory and atomically publish it.
 * @module @deepseek-ai/dsh-fs-local/fsio
 */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, realpath, readdir, rename, rm, stat } from 'node:fs/promises'
import type { BigIntStats, Dirent, Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTextEncoding } from '@deepseek-ai/dsh-fs'
import {
  displayEncoding,
  encodeForWrite,
  sniffAndDecode,
  sniffBom,
} from '@deepseek-ai/dsh-fs-codec'
import type { HostPriors } from '@deepseek-ai/dsh-fs-codec'
import { copyFileDaclWin32, replaceFileWin32 } from './win32.ts'

const BINARY_SAMPLE_BYTES = 8192
// Bound one non-abortable FileHandle.read so cancellation is observed between chunks.
const DIFF_BASIS_READ_CHUNK_BYTES = 64 * 1024

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isEEXIST(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * A path component that is expected to be a directory is a regular file (e.g.
 * resolving `afile/child.txt` when `afile` is a file). Like `ENOENT`, the target
 * cannot exist — so the resolution/probe paths treat it as "absent" rather than
 * letting a raw Node error escape without the structured `FsError` taxonomy.
 */
function isENOTDIR(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTDIR'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/* v8 ignore start -- composes secondary cleanup-failure messages, which require a filesystem/kernel fault after the primary failure. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* v8 ignore stop */

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
}

function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

/**
 * `readFile` with the supplied signal, translating a mid-read `AbortError` into
 * the seam's structured `FsError('FS_ABORTED')` (Node rejects an aborted
 * `readFile` with a bare `AbortError`, which would otherwise escape the seam's
 * error taxonomy — the streaming/write paths translate it the same way).
 */
async function readFileAbortable(absolutePath: string, verb: 'read' | 'edit', signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(absolutePath, signal ? { signal } : {})
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a non-abort readFile rejection needs a permission/IO fault racing an open file. */
    if (!isAbortError(error)) throw error
    throw new FsError(`${verb} aborted`, 'FS_ABORTED')
  }
}

/** Opaque version token from high-resolution identity and freshness metadata. */
function versionOf(info: BigIntStats): FsVersion {
  return FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
}

/**
 * Test hook: lets specs pin the atomic-write temp names (to prove exclusive-open behavior without
 * a name race), override native boundaries, and observe the staged temp file before publication.
 */
export interface FsIoInternals {
  /** Override the host platform for native-publication unit coverage. */
  platform?: NodeJS.Platform
  /** Override the generated private staging-dir name (relative to the target dir). */
  tempDirName?: (writePath: string) => string
  /** Override the generated temp-file name (relative to the private staging dir). */
  tempName?: (writePath: string) => string
  /** Override the Win32 DACL copy boundary. */
  copyFileDacl?: (source: string, destination: string) => Promise<void>
  /** Override the Win32 security-preserving replacement boundary. */
  replaceFile?: (replaced: string, replacement: string) => Promise<void>
  /** Override the hard-link no-replace publication boundary. */
  linkFile?: (existingPath: string, newPath: string) => Promise<void>
  /** Override target inspection after guarded publication fails. */
  inspectPublicationTarget?: (path: string) => Promise<BigIntStats>
  /** Override staging-directory removal for commit-point failure coverage. */
  removeStagingDir?: (stagingDir: string) => Promise<void>
  /** Test hook after the temp file is written/synced but before final chmod+publication. */
  inspectTemp?: (paths: { stagingDir: string; tempPath: string }) => void | Promise<void>
  /** Test hook after raw-read stat preflight and before bounded content I/O. */
  inspectReadBytesAfterStat?: (target: LocalTarget) => void | Promise<void>
}

/** A resolved local path: the absolute path shown to callers and its realpath identity. */
export interface LocalTarget {
  /** Absolute path (symlinks not resolved) — used for display. */
  displayPath: string
  /** Realpath identity — used as the stable target key and the I/O path. */
  targetKey: FsTargetKey
}

/** Result of probing a path: null when it does not exist. */
export interface PathInfo {
  version: FsVersion
  mode: number
  type: 'file' | 'directory' | 'other'
  size: number
}

/** Result of probing a path without following the final symlink component. */
export interface PathLinkInfo {
  version: FsVersion
  mode: number
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
}

/** One local directory child with a resolved target and cheap metadata. */
export interface LocalDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: LocalTarget
  version?: FsVersion
  size?: number
}

/**
 * Resolve a path to its absolute display path and realpath identity. For a missing target,
 * realpath the nearest existing ancestor and append the missing suffix, preserving identity
 * across symlinked ancestors before and after creation.
 * @param cwd - base directory a relative `path` resolves against.
 * @param path - absolute or relative path; empty/whitespace-only throws `FS_NOT_FOUND`.
 * @returns the absolute display path plus the realpath-derived stable target key.
 */
export async function resolveLocalTarget(cwd: string, path: string): Promise<LocalTarget> {
  if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = resolve(cwd, path)
  try {
    // Prefer the file's own realpath (resolves a symlinked file to its target).
    return { displayPath, targetKey: FsTargetKey(await realpath(displayPath)) }
  } catch (error: unknown) {
    // A path component is a file, not a directory (e.g. "afile/child.txt" where
    // "afile" is a regular file): the target can neither exist nor be created,
    // so surface the structured taxonomy instead of a raw Node ENOTDIR.
    /* v8 ignore next -- Windows reports this case as ENOENT and repairs it in the ancestor walk below. */
    if (isENOTDIR(error)) throw new FsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
    /* v8 ignore next -- non-ENOENT realpath failure needs a permission/IO fault; ENOENT falls through to ancestor resolution. */
    if (!isENOENT(error)) throw error
  }
  // File absent: realpath the nearest existing ancestor and re-append the
  // missing suffix (the file basename plus any not-yet-created intermediate
  // dirs), so the key is stable across creation of those dirs.
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      // On Windows, realpath of a regular file succeeds where POSIX returns
      // ENOTDIR (the OS reports ENOENT for `regular-file/child`, not ENOTDIR).
      // Stat the ancestor to restore the semantic distinction: a non-directory
      // ancestor means the target passes through a file and can never be created.
      /* v8 ignore start -- native Windows coverage exercises this repair; POSIX reports ENOTDIR before this point. */
      if (process.platform === 'win32') {
        const parentInfo = await stat(realAncestor)
        if (!parentInfo.isDirectory()) {
          throw new FsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
        }
      }
      /* v8 ignore stop */
      return { displayPath, targetKey: FsTargetKey(join(realAncestor, ...missing)) }
    } catch (error: unknown) {
      /* v8 ignore next -- native Windows coverage exercises the FsError raised by the repair above. */
      if (error instanceof FsError) throw error
      /* v8 ignore next -- a non-ENOENT realpath failure needs a permission/IO fault. */
      if (!isENOENT(error)) throw error
      const parent = dirname(ancestor)
      /* v8 ignore next -- the filesystem root always realpaths, so the walk terminates before parent === ancestor. */
      if (parent === ancestor) return { displayPath, targetKey: FsTargetKey(displayPath) }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function pathType(info: Stats | BigIntStats): PathInfo['type'] {
  if (info.isFile()) return 'file'
  /* v8 ignore else -- Windows has no special-entry fixture for the non-directory branch. */
  if (info.isDirectory()) return 'directory'
  /* v8 ignore next -- the corresponding special-entry return is covered on POSIX. */
  return 'other'
}

function pathLinkType(info: Stats | BigIntStats): PathLinkInfo['type'] {
  if (info.isSymbolicLink()) return 'symlink'
  return pathType(info)
}

async function probeStats<T extends Stats | BigIntStats>(
  absolutePath: string,
  readStats: (path: string) => Promise<T>,
): Promise<T | null> {
  try {
    return await readStats(absolutePath)
  } catch (error: unknown) {
    // ENOENT (no such file) and ENOTDIR (a parent segment is a file) both mean
    // the target is absent; any other metadata failure is a real permission/IO
    // fault.
    /* v8 ignore next -- a non-ENOENT/ENOTDIR metadata failure needs a permission/IO fault; surface it. */
    if (!isENOENT(error) && !isENOTDIR(error)) throw error
    return null
  }
}

/**
 * Probe a path for its version, mode, type, and size. Null if absent.
 * @param absolutePath - the path to stat (typically a target key; symlinks are followed).
 * @returns the metadata, or null when the path — or a parent segment — does not exist.
 */
export async function probe(absolutePath: string): Promise<PathInfo | null> {
  const info = await probeStats(absolutePath, path => stat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathType(info),
    size: Number(info.size),
  }
}

/**
 * Probe a path without following the final symlink component.
 * @param absolutePath - the path entry to inspect with `lstat` semantics.
 * @returns path-entry metadata, or null when the entry is absent.
 */
export async function probeNoFollow(absolutePath: string): Promise<PathLinkInfo | null> {
  const info = await probeStats(absolutePath, path => lstat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathLinkType(info),
    size: Number(info.size),
  }
}

// --- Directory listing ---

function listingIoError(displayPath: string, error: unknown): FsError {
  /* v8 ignore next -- defensive pass-through for races where a child resolver has already produced a structured FsError. */
  if (error instanceof FsError) return error
  /* v8 ignore next -- requires the listed target/parent to disappear between successful preflight and listing/child resolution. */
  if (isENOENT(error) || isENOTDIR(error)) return new FsError(`cannot list "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  /* v8 ignore next -- Windows chmod does not deny directory listing; POSIX covers permission translation. */
  if (isPermissionError(error)) return new FsError(`cannot list "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  return new FsError(`cannot list "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

async function resolveListedChildTarget(parent: LocalTarget, name: string): Promise<LocalTarget> {
  const identity = await resolveLocalTarget(parent.targetKey, name)
  return { displayPath: join(parent.displayPath, name), targetKey: identity.targetKey }
}

/**
 * List direct children of a directory in stable name order. Each child includes
 * a resolved target plus stat metadata when still available; file contents are
 * never read.
 * @param target - the resolved directory to list; a missing or non-directory target throws.
 * @param signal - aborts the listing, checked between children (`FS_ABORTED`).
 * @returns one entry per direct child, sorted by name.
 */
export async function listDirectory(target: LocalTarget, signal?: AbortSignal): Promise<LocalDirEntry[]> {
  throwIfAborted(signal, 'list')
  let info: PathInfo | null
  try {
    info = await probe(target.targetKey)
  } catch (error: unknown) {
    throw listingIoError(target.displayPath, error)
  }
  if (!info) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')

  let entries: Dirent[]
  try {
    entries = await readdir(target.targetKey, { withFileTypes: true, encoding: 'utf8' })
  } catch (error: unknown) {
    /* v8 ignore next -- requires permission/kernel failure from readdir after a successful directory stat. */
    throw listingIoError(target.displayPath, error)
  }
  throwIfAborted(signal, 'list')

  const result: LocalDirEntry[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal, 'list')
    try {
      const childTarget = await resolveListedChildTarget(target, entry.name)
      const childInfo = await probe(childTarget.targetKey)
      result.push({
        name: entry.name,
        type: childInfo?.type ?? 'other',
        target: childTarget,
        ...(childInfo ? { version: childInfo.version } : {}),
        ...(childInfo?.type === 'file' ? { size: childInfo.size } : {}),
      })
    } catch (error: unknown) {
      throw listingIoError(join(target.displayPath, entry.name), error)
    }
    throwIfAborted(signal, 'list')
  }
  return result
}

// --- Reading ---

function notTextError(verb: 'read' | 'edit', displayPath: string): FsError {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

function decodeUtf8Stream(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  verb: 'read' | 'edit',
  displayPath: string,
): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

/** Decode inputs for one whole buffer: priors, configured fallbacks, and read controls. */
export interface BufferDecodeInput {
  /** Explicit iconv-lite encoding name requested by the caller. */
  encoding?: string
  /** Restrict the walk to the UTF family (BOM or strict UTF-8) with no legacy guessing. */
  utfOnly?: boolean
  /** Provider-resolved host priors; `{}` when nothing is derivable. */
  priors: HostPriors
  /** Configured fallback encoding names (already validated at construction). */
  fallbackEncodings: readonly string[]
  /** Legacy auto-detection toggle. */
  detect: boolean
  /** Sticky decision recorded for this exact file version, already resolved by the caller. */
  sticky?: { encoding: string; bom: boolean }
  /** NUL-gate sample length for the UTF arms (default `BINARY_SAMPLE_BYTES`; legacy arms always gate whole-buffer). */
  binarySampleBytes?: number
}

/** A provider read: decode inputs plus the sticky/onSettled plumbing keyed by file version. */
export interface WholeBufferDecode extends BufferDecodeInput {
  /** Resolve the sticky decision recorded for the file's current version. */
  stickyFor?: (version: FsVersion) => { encoding: string; bom: boolean } | undefined
  /** Receive the settled decision with the version it was decoded at. */
  onSettled?: (decision: FsTextEncoding, version: FsVersion) => void
}

/** A decoded whole buffer plus the decision that produced it. */
export interface DecodedBuffer {
  text: string
  decision: FsTextEncoding
}

function reReadHint(displayPath: string, encoding: string): string {
  return `re-read with an explicit encoding, e.g. read({"file_path":"${displayPath}","encoding":"${encoding}"})`
}

/**
 * Decode one whole buffer through the codec's ordered candidate walk and map
 * the rejection reasons onto the seam's `FS_NOT_TEXT` taxonomy. Binary files
 * keep the historical message verbatim; every other rejection names the
 * viable candidates and a copyable re-read call.
 * @param buffer - the complete file buffer.
 * @param input - decode inputs; `utfOnly` drops every legacy arm.
 * @param verb - operation verb for error messages.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the decoded text (BOM bytes stripped) and its decision.
 */
export function decodeWholeBuffer(
  buffer: Uint8Array,
  input: BufferDecodeInput,
  verb: 'read' | 'edit',
  displayPath: string,
): DecodedBuffer {
  const outcome = sniffAndDecode(buffer, {
    ...(input.utfOnly === true ? {} : { explicit: input.encoding }),
    priors: input.priors,
    fallbackEncodings: input.fallbackEncodings,
    detect: input.utfOnly === true ? false : input.detect,
    ...(input.sticky === undefined || input.utfOnly === true ? {} : { sticky: input.sticky }),
    ...(input.binarySampleBytes === undefined ? {} : { binarySampleBytes: input.binarySampleBytes }),
  })
  if (outcome.ok) {
    const decision: FsTextEncoding = {
      encoding: outcome.decision.encoding,
      source: outcome.decision.source,
      bom: outcome.decision.bom,
      eol: outcome.decision.eol,
    }
    return { text: outcome.text, decision }
  }
  if (outcome.reason === 'binary') {
    throw new FsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  const candidateList = outcome.candidates.map(encoding => displayEncoding(encoding)).join(', ')
  /* v8 ignore start -- the probe list's total pages (KOI8-R decodes any NUL-free byte
   * soup) leave no reachable zero-candidate rejection, so the empty-candidate arms below stay ignored. */
  if (outcome.reason === 'explicit') {
    const fallbackHint = outcome.candidates[0] ?? 'utf-8'
    throw new FsError(
      `cannot ${verb} "${displayPath}": not decodable as ${displayEncoding(outcome.encoding ?? '')}`
      + (outcome.candidates.length > 0 ? `; viable encodings: ${candidateList}` : '')
      + `; ${reReadHint(displayPath, fallbackHint)}`,
      'FS_NOT_TEXT',
    )
  }
  const firstCandidate = outcome.candidates[0]
  if (firstCandidate !== undefined) {
    throw new FsError(
      `cannot ${verb} "${displayPath}": invalid text; viable encodings: ${candidateList}; ${reReadHint(displayPath, firstCandidate)}`,
      'FS_NOT_TEXT',
    )
  }
  throw notTextError(verb, displayPath)
  /* v8 ignore stop */
}

async function statRegularFile(target: LocalTarget, verb: 'read', signal?: AbortSignal): Promise<BigIntStats> {
  throwIfAborted(signal, verb)
  let info: BigIntStats
  try {
    info = await stat(target.targetKey, { bigint: true })
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a non-ENOENT stat failure needs a permission/IO fault; only the not-found path is reachable in tests. */
    if (!isENOENT(error)) throw error
    throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (!info.isFile()) throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return info
}

/** Read at most `limit` prefix bytes from a file, abortably. */
async function readPrefix(absolutePath: string, limit: number, signal: AbortSignal | undefined): Promise<Buffer> {
  const stream = createReadStream(absolutePath, { end: limit - 1, ...signal ? { signal } : {} })
  const chunks: Buffer[] = []
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    /* v8 ignore start -- a mid-prefix abort needs cancellation racing an active read;
     * any other failure needs a fault racing the open after a successful stat. */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
    /* v8 ignore stop */
  }
  return Buffer.concat(chunks)
}

/** Length of a possibly-incomplete trailing UTF-8 sequence to exclude from a strict prefix check. */
function trailingIncompleteUtf8Length(bytes: Uint8Array): number {
  const last = bytes.length - 1
  if (last < 0) return 0
  const lastByte = bytes[last] as number
  const isContinuation = (byte: number): boolean => byte >= 0x80 && byte <= 0xbf
  const announcedLength = (lead: number): number => lead >= 0xf0 && lead <= 0xf4 ? 4
    : lead >= 0xe0 && lead <= 0xef ? 3
      : lead >= 0xc2 && lead <= 0xdf ? 2
        : 1
  if (!isContinuation(lastByte)) return announcedLength(lastByte) > 1 ? 1 : 0
  let index = last
  /* v8 ignore next -- the right operand only evaluates with a longer run than one trailing byte. */
  while (index > 0 && isContinuation(bytes[index - 1] as number)) index -= 1
  if (index === 0) return bytes.length
  const lead = bytes[index - 1] as number
  return bytes.length - (index - 1) < announcedLength(lead) ? bytes.length - (index - 1) : 0
}

/** Whether a bounded prefix is compatible with strict UTF-8 (a trailing partial sequence is trimmed). */
function isUtf8Prefix(bytes: Buffer): boolean {
  const end = bytes.length - trailingIncompleteUtf8Length(bytes)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
    return true
  } catch {
    return false
  }
}

/** Chunk a decoded whole-buffer text for streaming consumers. */
function* chunkDecodedText(text: string): Iterable<string> {
  const size = 64 * 1024
  for (let start = 0; start < text.length; start += size) {
    yield text.slice(start, start + size)
  }
}

/** Dominant line-ending style of the start of a decoded text. */
function detectEolOf(text: string): 'LF' | 'CRLF' {
  const sample = text.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = Math.max(0, sample.split('\n').length - 1 - crlf)
  return crlf > lf ? 'CRLF' : 'LF'
}

/**
 * Read a whole regular text file into a single decoded string. Rejects
 * non-regular files, NUL-sampled binaries, and buffers no candidate can
 * decode cleanly; a supplied {@link WholeBufferDecode} carries the provider's
 * priors and read controls.
 * @param target - the resolved file to read.
 * @param signal - aborts the read (`FS_ABORTED`).
 * @param decode - provider decode inputs; omitted uses empty priors with detection on.
 * @returns the full decoded text (BOM bytes stripped, no normalization).
 */
export async function readWholeText(
  target: LocalTarget,
  signal?: AbortSignal,
  decode: WholeBufferDecode = { priors: {}, fallbackEncodings: [], detect: true },
): Promise<string> {
  const info = await statRegularFile(target, 'read', signal)
  const raw = await readFileAbortable(target.targetKey, 'read', signal)
  throwIfAborted(signal, 'read')
  const version = versionOf(info)
  const sticky = decode.stickyFor?.(version)
  const { text, decision } = decodeWholeBuffer(
    raw,
    { ...decode, ...(sticky === undefined ? {} : { sticky }) },
    'read',
    target.displayPath,
  )
  decode.onSettled?.(decision, version)
  return text
}

/**
 * Read a whole regular file as raw bytes with no decoding or binary rejection.
 * `maxBytes` bounds the complete content: the stat size short-circuits an
 * oversized file before any content I/O, and the stream reads at most one byte
 * beyond the cap so a file growing after stat cannot cause unbounded buffering.
 * @param target - the resolved file to read.
 * @param signal - aborts the read (`FS_ABORTED`).
 * @param maxBytes - inclusive byte cap on the complete content (`FS_TOO_LARGE`).
 * @param internals - test seam for a deterministic post-stat growth race.
 * @returns the full raw content, at most `maxBytes` long.
 */
export async function readWholeBytes(
  target: LocalTarget,
  signal: AbortSignal | undefined,
  maxBytes: number,
  internals: FsIoInternals = {},
): Promise<Uint8Array> {
  const info = await statRegularFile(target, 'read', signal)
  if (info.size > maxBytes) {
    throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
  }  await internals.inspectReadBytesAfterStat?.(target)
  const stream = createReadStream(target.targetKey, {
    end: maxBytes,
    ...signal ? { signal } : {},
  })
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a mid-stream abort needs cancellation racing an active read; pre-abort is deterministic. */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }
  return Buffer.concat(chunks, bytes)
}

/**
 * Stream a whole regular text file as decoded text chunks. The bounded prefix
 * (first {@link BINARY_SAMPLE_BYTES} bytes) is sniffed first: clean UTF-8
 * streams chunk-by-chunk exactly like the historical fast path, while a
 * prefix that fails strict UTF-8 (or carries a UTF-16 BOM, an explicit
 * encoding request, or any non-UTF decision input) degrades to one
 * whole-buffer decode whose text is then chunked — the memory bound is the
 * file size, matching the edit read.
 * @param target - the resolved file to stream.
 * @param signal - aborts the stream, including between chunks (`FS_ABORTED`).
 * @param decode - provider decode inputs; omitted uses empty priors with detection on.
 * @returns decoded text chunks in file order; chunk boundaries carry no meaning.
 */
export async function* streamWholeText(
  target: LocalTarget,
  signal?: AbortSignal,
  decode: WholeBufferDecode = { priors: {}, fallbackEncodings: [], detect: true },
): AsyncIterable<string> {
  const info = await statRegularFile(target, 'read', signal)
  const version = versionOf(info)
  const prefix = await readPrefix(target.targetKey, BINARY_SAMPLE_BYTES, signal)
  const bom = sniffBom(prefix)
  const needsWholeBuffer = prefix.includes(0)
    || (bom !== undefined && bom.encoding !== 'utf-8')
    || decode.encoding !== undefined
    || !isUtf8Prefix(prefix)
  if (needsWholeBuffer) {
    throwIfAborted(signal, 'read')
    const raw = await readFileAbortable(target.targetKey, 'read', signal)
    throwIfAborted(signal, 'read')
    const sticky = decode.stickyFor?.(version)
    const { text, decision } = decodeWholeBuffer(
      raw,
      { ...decode, ...(sticky === undefined ? {} : { sticky }) },
      'read',
      target.displayPath,
    )
    decode.onSettled?.(decision, version)
    yield* chunkDecodedText(text)
    return
  }
  const stream = createReadStream(target.targetKey, signal ? { signal } : {})
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let headSample = ''
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const decoded = decodeUtf8Stream(decoder, chunk, 'read', target.displayPath)
      if (headSample.length < 4096) headSample += decoded
      yield decoded
    }
    yield decodeUtf8Stream(decoder, undefined, 'read', target.displayPath)
  } catch (error: unknown) {
    /* v8 ignore next 4 -- mid-stream errors need an abort/IO fault racing the loop; pre-abort is caught by throwIfAborted. */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }
  decode.onSettled?.(
    { encoding: 'utf-8', source: bom !== undefined ? 'bom' : 'utf8', bom: bom !== undefined, eol: detectEolOf(headSample) },
    version,
  )
}

// --- Writing ---

async function removeStagingDirOrThrow(
  stagingDir: string,
  originalError: unknown,
  removeStagingDir: (path: string) => Promise<void>,
): Promise<never> {
  try {
    await removeStagingDir(stagingDir)
  } catch (cleanupError: unknown) {
    /* v8 ignore next 1 -- cleanup failure here needs a second filesystem fault after the primary write failure. */
    throw new FsError(`write failed (${errorMessage(originalError)}) and temp cleanup failed (${errorMessage(cleanupError)})`, 'FS_NOT_FOUND', { cause: originalError })
  }
  throw originalError
}

async function throwGuardedCreateFailure(
  error: unknown,
  absolutePath: string,
  displayPath: string,
  inspectPublicationTarget: (path: string) => Promise<BigIntStats>,
): Promise<never> {
  let existing: BigIntStats | undefined
  try {
    existing = await inspectPublicationTarget(absolutePath)
  } catch (metadataError: unknown) {
    if (!isENOENT(metadataError) && !isENOTDIR(metadataError)) {
      throw new FsError(`cannot write "${displayPath}": ${errorMessage(metadataError)}`, 'FS_IO_ERROR', { cause: metadataError })
    }
  }

  // Link errno values vary by platform and filesystem. Inspect the target entry
  // after failure so a collision is not confused with missing hard-link support.
  if (existing !== undefined) {
    if (!existing.isFile()) {
      throw new FsError(`cannot write "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE', { cause: error })
    }
    throw new FsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  if (isEEXIST(error)) {
    throw new FsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  throw new FsError(`cannot write "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * Atomically replace a file through a private, synced staging file in the same directory.
 * POSIX protects the staging directory and file with `0o700` and `0o600`. A new Windows file
 * inherits the destination directory's DACL; a replacement copies the existing target's DACL
 * onto the empty temp before writing and preserves the target descriptor at publication.
 * @param absolutePath - destination; missing parent directories are created.
 * @param content - the full UTF-8 text to write.
 * @param mode - existing destination's POSIX mode to preserve, or `undefined` for a new file;
 * inert as a mode on Windows but identifies replacement security semantics.
 * @param signal - cancellation checked before final publication.
 * @param internals - Test hook for pinning temp names and observing the staged file.
 * @param createIfAbsent - when provided, publish with a hard-link no-replace
 * primitive; a concurrent creator's file is preserved and this write is
 * rejected with `FS_NOT_OBSERVED` using the supplied display path.
 */
export function writeFileAtomic(
  absolutePath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  internals: FsIoInternals = {},
  createIfAbsent?: { displayPath: string },
): Promise<void> {
  return writeFileAtomicBytes(absolutePath, Buffer.from(content, 'utf8'), mode, signal, internals, createIfAbsent)
}

/**
 * Byte-publishing variant of {@link writeFileAtomic} for write-backs that
 * must reproduce a file's original encoding and byte order mark exactly.
 * @param absolutePath - destination; missing parent directories are created.
 * @param bytes - the exact bytes to publish.
 * @param mode - existing destination's POSIX mode to preserve, or `undefined` for a new file.
 * @param signal - cancellation checked before final publication.
 * @param internals - Test hook for pinning temp names and observing the staged file.
 * @param createIfAbsent - when provided, publish with a hard-link no-replace primitive.
 */
export async function writeFileAtomicBytes(
  absolutePath: string,
  bytes: Uint8Array,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  internals: FsIoInternals = {},
  createIfAbsent?: { displayPath: string },
): Promise<void> {
  throwIfAborted(signal, 'write')
  const directory = dirname(absolutePath)
  await mkdir(directory, { recursive: true })

  throwIfAborted(signal, 'write')
  const stagingDirName = internals.tempDirName?.(absolutePath) ?? `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmpdir`
  const stagingDir = join(directory, stagingDirName)
  const tempName = internals.tempName?.(absolutePath) ?? `${basename(absolutePath)}.tmp`
  const tempPath = join(stagingDir, tempName)
  const platform = internals.platform ?? process.platform
  const copyFileDacl = internals.copyFileDacl ?? copyFileDaclWin32
  const replaceFile = internals.replaceFile ?? replaceFileWin32
  const linkFile = internals.linkFile ?? link
  const inspectPublicationTarget = internals.inspectPublicationTarget
    ?? (path => lstat(path, { bigint: true }))
  const removeStagingDir = internals.removeStagingDir
    ?? (path => rm(path, { recursive: true, force: true }))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let stagingCreated = false
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    stagingCreated = true
    await chmod(stagingDir, 0o700)

    handle = await open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    if (platform === 'win32' && mode !== undefined) {
      await copyFileDacl(absolutePath, tempPath)
    }
    await handle.writeFile(bytes, { ...signal ? { signal } : {} })
    await handle.sync()
    await internals.inspectTemp?.({ stagingDir, tempPath })
    if (mode !== undefined) await handle.chmod(mode)
    await handle.close()
    handle = undefined

    throwIfAborted(signal, 'write')
    if (createIfAbsent !== undefined) {
      try {
        await linkFile(tempPath, absolutePath)
      } catch (error: unknown) {
        await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget)
      }
    } else if (platform === 'win32' && mode !== undefined) {
      try {
        await replaceFile(absolutePath, tempPath)
      } catch (error: unknown) {
        // If the observed target disappears during staging, the protected DACL
        // already copied to the temp remains authoritative for recreation.
        if (!isENOENT(error)) throw error
        await rename(tempPath, absolutePath)
      }
    } else {
      await rename(tempPath, absolutePath)
    }
    try {
      await removeStagingDir(stagingDir)
    } catch (_committedStagingCleanupFailure) {
      // The target is committed; owner-only staging residue cannot turn that write into a failure.
    }
  } catch (error: unknown) {
    /* v8 ignore next -- abort-mid-write needs a writeFile/signal race; the non-abort (rename/open) side is tested. */
    let failure: unknown = isAbortError(error) ? new FsError('write aborted', 'FS_ABORTED') : error
    /* v8 ignore next 8 -- reached only if writeFile/sync throws with the handle open (IO fault); close-failure is a double fault. */
    if (handle) {
      try {
        await handle.close()
      } catch (closeError: unknown) {
        failure = new FsError(`write failed (${errorMessage(failure)}) and temp close failed (${errorMessage(closeError)})`, 'FS_NOT_FOUND', { cause: failure })
      }
    }
    if (!stagingCreated) throw failure
    return removeStagingDirOrThrow(stagingDir, failure, removeStagingDir)
  }
}

// --- Editing ---

/** Line ending style detected before LF normalization. */
export type LineEndings = 'LF' | 'CRLF'

/**
 * Collapse CRLF to LF — the canonical in-memory form every edit/diff basis
 * uses. Lone `\r` bytes (not followed by `\n`) are left untouched.
 * @param content - decoded text in whatever line-ending style the file had.
 * @returns the text with every `\r\n` pair replaced by `\n`.
 */
function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * Convert LF-normalized content back to the line-ending style detected at read
 * time, for write-back. `LF` returns the content unchanged; `CRLF` re-normalizes
 * first so an already-CRLF sequence is never doubled to `\r\r\n`.
 * @param content - the LF-normalized (edited) text.
 * @param lineEndings - the original file's style, as detected by {@link readForEdit}.
 * @returns the text in the original file's line-ending style.
 */
function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Read and decode a file for editing: rejects binaries (whole-buffer NUL gate,
 * except a UTF-16 BOM), returns LF-normalized content, the original
 * line-ending style, and the decode decision a write-back must reproduce.
 * @param absolutePath - the file to read (typically a target key).
 * @param displayPath - the caller-facing path used in error messages.
 * @param signal - aborts the read (`FS_ABORTED`).
 * @param decode - decode inputs with an already-resolved sticky decision.
 * @returns the LF-normalized content, the detected style, and the decision.
 */
export async function readForEdit(
  absolutePath: string,
  displayPath: string,
  signal?: AbortSignal,
  decode: BufferDecodeInput = { priors: {}, fallbackEncodings: [], detect: true },
): Promise<{ content: string; lineEndings: LineEndings; decision: FsTextEncoding }> {
  throwIfAborted(signal, 'edit')
  const buffer = await readFileAbortable(absolutePath, 'edit', signal)
  throwIfAborted(signal, 'edit')
  const { text, decision } = decodeWholeBuffer(
    buffer,
    { ...decode, binarySampleBytes: Number.MAX_SAFE_INTEGER },
    'edit',
    displayPath,
  )
  return { content: normalizeLineEndings(text), lineEndings: detectLineEndings(text), decision }
}

/**
 * Encode edited text back to the file's original bytes, refusing characters
 * the encoding cannot represent (`FS_UNMAPPABLE`) before any staging happens.
 * @param text - the complete restored (edited) text.
 * @param decision - the read-time decision whose encoding and BOM reproduce.
 * @param verb - operation verb for error messages.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the exact bytes to publish.
 */
export function encodeForWriteDecision(
  text: string,
  decision: FsTextEncoding,
  verb: 'write' | 'edit',
  displayPath: string,
): Uint8Array {
  const outcome = encodeForWrite(text, decision.encoding, { bom: decision.bom })
  if (outcome.ok) return outcome.bytes
  const { unmappable } = outcome
  const hex = unmappable.codePoint.toString(16).toUpperCase().padStart(4, '0')
  throw new FsError(
    `cannot ${verb} "${displayPath}": ${unmappable.char} (U+${hex}) at ${unmappable.line}:${unmappable.column} cannot be encoded in ${displayEncoding(decision.encoding)}`,
    'FS_UNMAPPABLE',
  )
}

/**
 * Best-effort overwrite diff basis. Binary, undecodable, a file at/above the byte limit,
 * or a file deleted/made unreadable after the caller's preflight returns `null` so the write
 * still succeeds and presentation falls back to a whole-file diff. The bound is enforced on
 * the opened descriptor rather than a prior path stat, so concurrent external replacement or
 * size changes cannot make this helper buffer more than `maxBytes`. A legacy-encoded file
 * yields its decoded basis AND the decision, so the guarded overwrite can write back in the
 * file's original encoding.
 * @param absolutePath - the file to read (typically a target key).
 * @param maxBytes - exclusive upper bound for bytes held as the contextual-diff basis.
 * @param signal - aborts the read (`FS_ABORTED`); cancellation propagates, unlike I/O failure.
 * @param decode - decode inputs with an already-resolved sticky decision.
 * @returns the LF-normalized text with its decision, or nulls for a non-regular, at/above-limit,
 * binary, undecodable, descriptor-size-changed, or unreadable file.
 */
export async function readTextForDiff(
  absolutePath: string,
  maxBytes: number,
  signal?: AbortSignal,
  decode: BufferDecodeInput = { priors: {}, fallbackEncodings: [], detect: true },
): Promise<{ basis: string | null; decision: FsTextEncoding | null }> {
  throwIfAborted(signal, 'read')
  try {
    const handle = await open(absolutePath, 'r')
    let buffer: Buffer
    let total = 0
    let openedSize = 0
    try {
      throwIfAborted(signal, 'read')
      const info = await handle.stat()
      throwIfAborted(signal, 'read')
      if (!info.isFile()) return { basis: null, decision: null }
      if (info.size >= maxBytes) return { basis: null, decision: null }
      openedSize = info.size
      // One extra byte detects growth after stat without retaining per-read backing buffers.
      buffer = Buffer.allocUnsafe(openedSize + 1)
      while (total < buffer.length) {
        throwIfAborted(signal, 'read')
        const length = Math.min(buffer.length - total, DIFF_BASIS_READ_CHUNK_BYTES)
        const { bytesRead } = await handle.read(buffer, total, length, null)
        if (bytesRead === 0) break
        total += bytesRead
      }
    } finally {
      await handle.close()
    }
    throwIfAborted(signal, 'read')
    if (total !== openedSize) return { basis: null, decision: null }
    try {
      const { text, decision } = decodeWholeBuffer(
        buffer.subarray(0, total),
        { ...decode, binarySampleBytes: Number.MAX_SAFE_INTEGER },
        'read',
        absolutePath,
      )
      return { basis: normalizeLineEndings(text), decision }
    } catch (error: unknown) {
      // An undecodable prior file costs only the optional basis (the historical
      // best-effort contract); the write itself proceeds. decodeWholeBuffer
      // raises only FS_NOT_TEXT here, so the rethrow guards future codes.
      /* v8 ignore start */
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return { basis: null, decision: null }
      throw error
      /* v8 ignore stop */
    }
  } catch (error: unknown) {
    // Cancellation is the caller's intent and still propagates.
    if (error instanceof FsError) throw error
    // A descriptor-phase errno — deleted or made unreadable after the caller's
    // preflight, or a faulted read — costs only the optional basis: a committed
    // write must not fail for a presentation-only pre-read.
    if (error instanceof Error && 'code' in error) return { basis: null, decision: null }
    throw error
  }
}

/**
 * Apply a literal replacement to LF-normalized content. Empty or missing search text throws
 * `FS_EDIT_NOT_FOUND`; multiple matches throw `FS_AMBIGUOUS_EDIT` unless `replaceAll` is true.
 * @param content - the current file content, already LF-normalized.
 * @param oldString - literal text to find; CRLF inside it is normalized to LF before
 *   matching.
 * @param newString - literal replacement text, normalized the same way.
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the edited LF-normalized content plus how many occurrences were replaced.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

export { normalizeLineEndings, restoreLineEndings }
