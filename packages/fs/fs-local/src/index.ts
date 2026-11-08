/**
 * Host-filesystem implementation of `ctx.fs`. Realpath-derived target identity makes aliases
 * share stale guards, and writes through a symlink update its target without replacing the link.
 * @module @deepseek-ai/dsh-fs-local
 */

import { Context } from '@deepseek-ai/cordis'
import { constants as bufferConstants } from 'node:buffer'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsMoveOutcome,
  FsPathInfo,
  FsReadTextOptions,
  FsTarget,
  FsTextEncoding,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import { encodingExists, hostPriors } from '@deepseek-ai/dsh-fs-codec'
import type { HostPriors } from '@deepseek-ai/dsh-fs-codec'
import {
  applyLiteralEdit,
  type PathInfo,
  encodeForWriteDecision,
  listDirectory,
  normalizeLineEndings,
  probe,
  probeNoFollow,
  readForEdit,
  readTextForDiff,
  removeFile,
  readWholeBytes,
  readWholeText,
  resolveLocalTarget,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomicBytes,
} from './fsio.ts'
import type { FsIoInternals, WholeBufferDecode } from './fsio.ts'

/** Configuration for the local filesystem backend. */
export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, capped by the
   * runtime's safe allocation/decode maximum. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
  /**
   * Extra iconv-lite encoding names tried (in order) after the host and
   * locale priors when decoding a file. Defaults to none; an unknown name
   * fails provider construction.
   */
  fallbackEncodings?: string[]
  /**
   * Whether reads may decode legacy (non-UTF-8) encodings at all. Defaults to
   * `true`; `false` limits reads to explicit encodings, BOMs, and strict UTF-8.
   */
  detect?: boolean
}

type ResolvedConfig = Required<Config>
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024
const MAX_DIFF_BASIS_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH,
)

/** One recorded decode decision, valid only for the version it was made at. */
interface EncodingRecord {
  version: FsVersion
  decision: FsTextEncoding
}

/**
 * The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
 * (a resolution default, NOT a containment boundary — see the filesystem
 * capability-seam Agent Note); enforce
 * containment with a stricter backend or a `tools/execute` permission plugin.
 */
export class LocalFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
    fallbackEncodings: z.array(z.string()).default([]),
    detect: z.boolean().default(true),
  })

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig
  /** Test hook forwarded to fsio for atomic-publication boundaries. */
  internals: FsIoInternals = {}
  /**
   * Test seam replacing host-prior resolution (deterministic legacy-decode
   * coverage without a legacy-locale host).
   */
  resolvePriors: () => Promise<HostPriors> = () => hostPriors()
  /** Per-targetKey tail promise: serializes mutating ops so the read→guard→write
   * window can't interleave, making concurrent writes/edits deterministically
   * ordered (one wins, the rest see the new version and reject as stale). */
  private locks = new Map<string, Promise<unknown>>()
  /** Decode decisions by target key, invalidated by version drift (HMR-cleared). */
  private encodingRecords = new Map<string, EncodingRecord>()
  private priorsPromise: Promise<HostPriors> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as ResolvedConfig
    if (!Number.isSafeInteger(resolved.diffBasisMaxBytes)
      || resolved.diffBasisMaxBytes <= 0
      || resolved.diffBasisMaxBytes > MAX_DIFF_BASIS_BYTES) {
      throw new Error(`fs-local: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
    }
    const invalid = resolved.fallbackEncodings.filter(name => !encodingExists(name))
    if (invalid.length > 0) {
      throw new Error(`fs-local: fallbackEncodings contains unknown encoding names: ${invalid.join(', ')}`)
    }
    this.config = resolved
    ctx.effect(() => () => {
      // Drop every recorded decode decision on disposal so a reloaded provider
      // starts clean (HMR safety), mirroring the observation policy's teardown.
      this.encodingRecords.clear()
    }, 'fs-local encoding-decision teardown')
  }

  private priors(): Promise<HostPriors> {
    this.priorsPromise ??= this.resolvePriors()
    return this.priorsPromise
  }

  /** Decode inputs for one read; the sticky decision resolves per file version. */
  private async decodeOptions(opts: FsReadTextOptions | undefined): Promise<Omit<WholeBufferDecode, 'stickyFor' | 'onSettled'>> {
    return {
      ...opts?.encoding === undefined ? {} : { encoding: opts.encoding },
      ...opts?.utfOnly === undefined ? {} : { utfOnly: opts.utfOnly },
      priors: await this.priors(),
      fallbackEncodings: this.config.fallbackEncodings,
      detect: this.config.detect,
    }
  }

  private recordDecision(targetKey: string, version: FsVersion, decision: FsTextEncoding): void {
    this.encodingRecords.set(targetKey, { version, decision })
  }

  private stickyFor(targetKey: string): (version: FsVersion) => FsTextEncoding | undefined {
    return (version) => {
      const record = this.encodingRecords.get(targetKey)
      return record !== undefined && record.version === version ? record.decision : undefined
    }
  }

  /** Run `op` with exclusive access to `targetKey` (FIFO per key). */
  private async withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    // Keep the chain alive but swallow this op's result/throw for the *next* waiter.
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) {
        this.locks.delete(targetKey)
      }
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const local = await resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    return { targetKey: local.targetKey, displayPath: local.displayPath }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const info = await probe(target.targetKey)
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const info = await probeNoFollow(resolve(opts?.cwd ?? this.config.cwd, path))
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal, opts?: FsReadTextOptions): Promise<string> {
    const base = await this.decodeOptions(opts)
    return readWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, {
      ...base,
      stickyFor: this.stickyFor(String(target.targetKey)),
      onSettled: (decision, version) => {
        this.recordDecision(String(target.targetKey), version, decision)
        opts?.onDecision?.(decision)
      },
    })
  }

  override streamText(target: FsTarget, signal?: AbortSignal, opts?: FsReadTextOptions): Promise<AsyncIterable<string>> {
    return this.streamTextDecoded(target, signal, opts)
  }

  private async streamTextDecoded(
    target: FsTarget,
    signal: AbortSignal | undefined,
    opts: FsReadTextOptions | undefined,
  ): Promise<AsyncIterable<string>> {
    const base = await this.decodeOptions(opts)
    return streamWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, {
      ...base,
      stickyFor: this.stickyFor(String(target.targetKey)),
      onSettled: (decision, version) => {
        this.recordDecision(String(target.targetKey), version, decision)
        opts?.onDecision?.(decision)
      },
    })
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return readWholeBytes({ displayPath: target.displayPath, targetKey: target.targetKey }, signal, maxBytes, this.internals)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await listDirectory({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
    return entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: { targetKey: entry.target.targetKey, displayPath: entry.target.displayPath },
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      if (existing && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      if (expected?.kind === 'replaceIfVersion') {
        // Stale guard: the file must still exist at the version the owner observed.
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        // createIfAbsent onto an existing file: a blind overwrite — require a read first.
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      // No expectation means an unconditional but still atomic write.

      // Capture an optional contextual-diff basis before the write. The bounded
      // reader checks the opened file itself, so an external replacement after
      // `probe()` cannot turn this best-effort presentation read into an
      // unbounded allocation. Either side at/above the configured limit yields
      // `before: null`; consumers retain their whole-file fallback. A decodable
      // legacy file also yields its decision, which drives the write-back
      // encoding; otherwise a prior sticky record for this exact version does.
      const diffable = existing !== null
        && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes
      const stickyDecision = existing !== null ? this.stickyFor(String(target.targetKey))(existing.version) : undefined
      const diffBasis = diffable
        ? await readTextForDiff(target.targetKey, this.config.diffBasisMaxBytes, signal, {
          priors: await this.priors(),
          fallbackEncodings: this.config.fallbackEncodings,
          detect: this.config.detect,
          ...(stickyDecision === undefined ? {} : { sticky: stickyDecision }),
        })
        : { basis: null as string | null, decision: null as FsTextEncoding | null }
      const decision: FsTextEncoding | undefined = diffBasis.decision ?? stickyDecision
      const bytes = decision !== undefined
        ? encodeForWriteDecision(content, { ...decision, source: 'sticky' }, 'write', target.displayPath)
        : Buffer.from(content, 'utf8')
      await writeFileAtomicBytes(
        target.targetKey,
        bytes,
        existing?.mode,
        signal,
        this.internals,
        expected?.kind === 'createIfAbsent' ? { displayPath: target.displayPath } : undefined,
        target.displayPath,
      )
      const after = await probe(target.targetKey)
      if (decision !== undefined && after !== null) {
        this.recordDecision(String(target.targetKey), after.version, { ...decision, source: 'sticky' })
      }
      return {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(after, target),
        before: diffBasis.basis,
        // LF-normalized to share the diff basis with `before` (also LF): a CRLF
        // overwrite must not read as every line changed. Line-ending restoration
        // is a storage detail the applied-hunk diff ignores.
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      // Stale guard before literal matching: an edit based on an old read reports
      // FS_STALE_VERSION, not FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT against newer content.
      // Missing targets use the same stale code on guarded and unconditional edit paths.
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      // expected === undefined: unconditional edit of the current content — no
      // version guard. Still inside the per-target lock, so the read→match→write
      // window is serialized and atomic.
      if (expected && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const stickyDecision = this.stickyFor(String(target.targetKey))(existing.version)
      const original = await readForEdit(target.targetKey, target.displayPath, signal, {
        priors: await this.priors(),
        fallbackEncodings: this.config.fallbackEncodings,
        detect: this.config.detect,
        ...(stickyDecision === undefined ? {} : { sticky: stickyDecision }),
      })
      const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const content = restoreLineEndings(edited.content, original.lineEndings)
      const bytes = encodeForWriteDecision(content, original.decision, 'edit', target.displayPath)
      await writeFileAtomicBytes(target.targetKey, bytes, existing.mode, signal, this.internals, undefined, target.displayPath)
      const after = await probe(target.targetKey)
      /* v8 ignore next 3 -- the post-write probe finding the file absent requires a concurrent unlink between rename and stat. */
      if (after !== null) {
        this.recordDecision(String(target.targetKey), after.version, { ...original.decision, source: 'sticky' })
      }
      return {
        version: this.versionAfterWrite(after, target),
        // The LF-normalized before/after text (the applied-hunk diff basis);
        // line-ending restoration is a storage detail the diff ignores.
        before: original.content,
        after: edited.content,
      }
    })
  }

  override async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await this.requireFile(target, expected, 'patch')
      const stickyDecision = this.stickyFor(String(target.targetKey))(existing.version)
      const original = await readForEdit(target.targetKey, target.displayPath, signal, {
        priors: await this.priors(),
        fallbackEncodings: this.config.fallbackEncodings,
        detect: this.config.detect,
        ...(stickyDecision === undefined ? {} : { sticky: stickyDecision }),
      })
      const after = this.patchContent(target, original.content, hunks)
      const bytes = encodeForWriteDecision(restoreLineEndings(after, original.lineEndings), original.decision, 'edit', target.displayPath)
      await writeFileAtomicBytes(target.targetKey, bytes, existing.mode, signal, this.internals, undefined, target.displayPath)
      const probed = await probe(target.targetKey)
      /* v8 ignore next 3 -- the post-write probe finding the file absent requires a concurrent unlink between rename and stat. */
      if (probed !== null) {
        this.recordDecision(String(target.targetKey), probed.version, { ...original.decision, source: 'sticky' })
      }
      return { version: this.versionAfterWrite(probed, target), before: original.content, after }
    })
  }

  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsDeleteOutcome> {
    return this.withLock(target.targetKey, async () => {
      await this.requireFile(target, expected, 'delete')
      const before = await readTextForDiff(target.targetKey, this.config.diffBasisMaxBytes, signal, {
        priors: await this.priors(),
        fallbackEncodings: this.config.fallbackEncodings,
        detect: this.config.detect,
      })
      if (signal?.aborted) throw new FsError('delete aborted', 'FS_ABORTED')
      await this.internals.inspectBeforeMutation?.(target)
      if (signal?.aborted) throw new FsError('delete aborted', 'FS_ABORTED')
      await removeFile(target.targetKey, target.displayPath, this.internals)
      return { before: before.basis }
    })
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: {
      hunks?: readonly PatchHunk[]
      expectedSource?: { version: FsVersion }
      expectedDestination?: FsWriteIntent
    },
    signal?: AbortSignal,
  ): Promise<FsMoveOutcome> {
    if (source.targetKey === destination.targetKey) {
      throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
    }
    return this.withLocks([source.targetKey, destination.targetKey], async () => {
      const sourceInfo = await this.requireFile(source, options.expectedSource, 'move')
      const existing = await this.writeTarget(destination, options.expectedDestination)
      const stickyDecision = this.stickyFor(String(source.targetKey))(sourceInfo.version)
      const original = await readForEdit(source.targetKey, source.displayPath, signal, {
        priors: await this.priors(),
        fallbackEncodings: this.config.fallbackEncodings,
        detect: this.config.detect,
        ...(stickyDecision === undefined ? {} : { sticky: stickyDecision }),
      })
      const after = options.hunks === undefined ? original.content : this.patchContent(source, original.content, options.hunks)
      const bytes = encodeForWriteDecision(restoreLineEndings(after, original.lineEndings), original.decision, 'edit', source.displayPath)
      // The destination basis only matters when the published text itself fits
      // the diff budget; an over-limit move cannot pair with a bounded before.
      const before = existing !== null && Buffer.byteLength(after, 'utf8') < this.config.diffBasisMaxBytes
        ? await readTextForDiff(destination.targetKey, this.config.diffBasisMaxBytes, signal, {
          priors: await this.priors(),
          fallbackEncodings: this.config.fallbackEncodings,
          detect: this.config.detect,
        })
        : { basis: null as string | null }
      if (signal?.aborted) throw new FsError('move aborted', 'FS_ABORTED')
      await this.internals.inspectBeforeMutation?.(source)
      if (signal?.aborted) throw new FsError('move aborted', 'FS_ABORTED')
      // After this checkpoint, complete both effects and report them even if cancellation arrives.
      await writeFileAtomicBytes(
        destination.targetKey,
        bytes,
        sourceInfo.mode,
        undefined,
        { ...this.internals, existingDestination: existing !== null },
        options.expectedDestination?.kind === 'createIfAbsent' ? { displayPath: destination.displayPath } : undefined,
        destination.displayPath,
      )
      const outcome: FsWriteOutcome = {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(await probe(destination.targetKey), destination),
        before: before.basis,
        after: normalizeLineEndings(after),
      }
      const sourceBefore = Buffer.byteLength(original.content, 'utf8') < this.config.diffBasisMaxBytes ? original.content : null
      try {
        await removeFile(source.targetKey, source.displayPath, this.internals)
      } catch (error) {
        // removeFile maps I/O failures; unexpected defects must still reject.
        if (!(error instanceof FsError)) throw error
        return { sourceBefore, destination: outcome, sourceDeleted: false, sourceFailure: { code: error.code, message: error.message } }
      }
      return { sourceBefore, destination: outcome, sourceDeleted: true }
    })
  }

  /** Run `op` holding every key, acquired in canonical order to avoid deadlock. */
  private withLocks<T>(targetKeys: readonly string[], op: () => Promise<T>): Promise<T> {
    const keys = [...new Set(targetKeys)].sort()
    const run = (index: number): Promise<T> => {
      const key = keys[index]
      return key === undefined ? op() : this.withLock(key, () => run(index + 1))
    }
    return run(0)
  }

  private async writeTarget(target: FsTarget, expected?: FsWriteIntent): Promise<PathInfo | null> {
    const existing = await probe(target.targetKey)
    if (existing && existing.type !== 'file') {
      throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (expected?.kind === 'replaceIfVersion') {
      // Stale guard: the file must still exist at the version the owner observed.
      if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      if (existing.version !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    } else if (expected?.kind === 'createIfAbsent' && existing) {
      // createIfAbsent onto an existing file: a blind overwrite — require a read first.
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    return existing
  }

  private async requireFile(target: FsTarget, expected: { version: FsVersion } | undefined, verb: string): Promise<PathInfo> {
    const existing = await probe(target.targetKey)
    if (!existing) throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    if (existing.type !== 'file') throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected && existing.version !== expected.version) {
      throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    return existing
  }

  private patchContent(target: FsTarget, before: string, hunks: readonly PatchHunk[]): string {
    const result = applyHunks(before, hunks)
    if (!result.ok) {
      throw new FsError(`cannot patch "${target.displayPath}": hunk at patch line ${result.failure.hunkLineNumber} (${result.failure.stage}) does not match`, 'FS_PATCH_MISMATCH')
    }
    return result.after
  }

  /* v8 ignore next 5 -- the post-write probe finding the file absent requires a
   * concurrent unlink between rename and stat; fall back to a sentinel version. */
  private versionAfterWrite(after: { version: FsVersion } | null, target: FsTarget): FsVersion {
    if (after) return after.version
    return FsVersion(`missing:${target.targetKey}`)
  }
}

export default LocalFileSystem
