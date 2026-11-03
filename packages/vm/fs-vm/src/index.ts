/**
 * Filesystem provider for one execution world (`ctx.vm`): every target,
 * path, and byte belongs to the world's interior — the host never touches a
 * host filesystem here. Implements the `FileSystem` contract over the world
 * seam's eight filesystem operations, with the guard windows (stale-version
 * writes, literal edits) serialized per target and mutations checked against
 * the per-call sandbox policy host-side, because the world's agent offers no
 * policy enforcement of its own.
 *
 * World-shaped semantics that differ from the local backend are recorded in
 * this package's README (Known Limitations): identity is lexical (no symlink
 * resolution across the seam), the freshness token carries the wire stat's
 * granularity, writes are UTF-8 and preserve no prior legacy encoding or
 * mode, and `lstat` cannot distinguish a symlink.
 * @module @deepseek-ai/dsh-fs-vm
 */

import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsReadTextOptions,
  FsTarget,
  FsTextEncoding,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { GuestFsError } from '@deepseek-ai/dsh-vm'
import type { GuestEntry, GuestStat, VmWorldFs } from '@deepseek-ai/dsh-vm'

/** Guest errno code to the stable filesystem failure code. */
const ERROR_CODES: Record<string, FsErrorCode> = {
  ENOENT: 'FS_NOT_FOUND',
  ENOTDIR: 'FS_NOT_DIRECTORY',
  EISDIR: 'FS_NOT_REGULAR_FILE',
  EFBIG: 'FS_TOO_LARGE',
  EACCES: 'FS_PERMISSION_DENIED',
  EPERM: 'FS_PERMISSION_DENIED',
}

/** Relabel one world stat kind into the contract's type vocabulary. */
function fsType(kind: GuestStat['kind']): FsInfo['type'] {
  return kind === 'file' ? 'file' : 'directory'
}

/** Freshness token of one world stat: kind, size, and the wire's mtime. */
function versionOf(stat: GuestStat): FsVersion {
  return FsVersion(`${stat.kind}:${String(stat.size)}:${String(stat.mtimeMs)}`)
}

/** LF-normalized text: the shared diff basis of write and edit outcomes. */
function lf(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

/** Strict UTF-8 decode with BOM handling; bytes that do not round-trip are not text. */
function decodeUtf8(bytes: Uint8Array, displayPath: string): { text: string; bom: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
  const body = bom ? bytes.subarray(3) : bytes
  const text = Buffer.from(body).toString('utf8')
  if (Buffer.compare(Buffer.from(text, 'utf8'), Buffer.from(body)) !== 0) {
    throw new FsError(`"${displayPath}" is not UTF-8 text`, 'FS_NOT_TEXT')
  }
  return { text, bom }
}

/** Dominant line-ending style of decoded text. */
function eolOf(text: string): FsTextEncoding['eol'] {
  return text.includes('\r\n') ? 'CRLF' : 'LF'
}

/** Apply one literal edit with the contract's match discipline. */
function applyLiteralEdit(original: string, edit: FsEditRequest, displayPath: string): string {
  const count = original.split(edit.oldString).length - 1
  if (count === 0) throw new FsError(`oldString not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  if (count > 1 && !edit.replaceAll) throw new FsError(`oldString matches ${String(count)} times in "${displayPath}"`, 'FS_AMBIGUOUS_EDIT')
  return edit.replaceAll ? original.replaceAll(edit.oldString, edit.newString) : original.replace(edit.oldString, edit.newString)
}

/** Serves the `FileSystem` seam over one execution world's interior. */
export class VmFileSystem extends FileSystem {
  static inject = ['vm', 'sandboxPolicy']
  private readonly locks = new Map<string, Promise<unknown>>()
  private tempCounter = 0

  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode
  }

  private get fs(): VmWorldFs {
    return this.ctx.vm.fs
  }

  /** Run `op` with exclusive access to one target key (FIFO per key). */
  private async withLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    const run = prior.then(op, op)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  private async wrap<T>(displayPath: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op()
    } catch (error) {
      if (error instanceof FsError) throw error
      if (error instanceof GuestFsError) {
        throw new FsError(`"${displayPath}": ${error.message}`, ERROR_CODES[error.code] ?? 'FS_IO_ERROR', { cause: error })
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    if (!path.startsWith('/')) {
      const base = opts?.cwd
      if (base === undefined) {
        throw new FsError('world paths must be absolute (no world default working directory exists); pass a cwd', 'FS_NOT_FOUND')
      }
      return await this.resolve(posix.join(base, path), opts)
    }
    const normalized = posix.normalize(path)
    return { targetKey: FsTargetKey(normalized), displayPath: normalized }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = posix.relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    return this.wrap(target.displayPath, async () => {
      const stat = await this.statInside(target)
      if (stat === undefined) return undefined
      return { version: versionOf(stat), type: fsType(stat.kind), ...(stat.kind === 'file' ? { size: stat.size } : {}) }
    })
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const target = await this.resolve(path, opts?.cwd === undefined ? undefined : { cwd: opts.cwd })
    return this.wrap(target.displayPath, async () => {
      const stat = await this.statInside(target)
      if (stat === undefined) return undefined
      return { version: versionOf(stat), type: fsType(stat.kind), ...(stat.kind === 'file' ? { size: stat.size } : {}) }
    })
  }

  override async readText(target: FsTarget, signal?: AbortSignal, opts?: FsReadTextOptions): Promise<string> {
    let text = ''
    for await (const chunk of await this.streamText(target, signal, opts)) text += chunk
    return text
  }

  override async streamText(target: FsTarget, signal?: AbortSignal, opts?: FsReadTextOptions): Promise<AsyncIterable<string>> {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    if (opts?.encoding !== undefined && opts.encoding !== 'utf-8' && opts.encoding !== 'utf8') {
      throw new FsError(`world files decode as UTF-8 only; refusing encoding "${opts.encoding}"`, 'FS_NOT_TEXT')
    }
    const bytes = await this.wrap(target.displayPath, () => this.fs.readFile(this.processPath(target)))
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    const { text, bom } = decodeUtf8(bytes, target.displayPath)
    const decision: FsTextEncoding = {
      encoding: 'utf-8',
      source: opts?.encoding !== undefined ? 'explicit' : 'utf8',
      bom,
      eol: eolOf(text),
    }
    opts?.onDecision?.(decision)
    const decoded = text
    return {
      // oxlint-disable-next-line typescript/require-await -- the async generator IS the AsyncIterable contract; one chunk needs no await.
      async *[Symbol.asyncIterator]() {
        yield decoded
      },
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    return this.wrap(target.displayPath, async () => {
      const stat = await this.fs.stat(this.processPath(target))
      if (stat.kind !== 'file') throw new FsError(`"${target.displayPath}" is not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (stat.size > maxBytes) throw new FsError(`"${target.displayPath}" exceeds ${String(maxBytes)} bytes`, 'FS_TOO_LARGE')
      return await this.fs.readFile(this.processPath(target))
    })
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (signal?.aborted) throw new FsError('list aborted', 'FS_ABORTED')
    return this.wrap(target.displayPath, async () => {
      const entries: readonly GuestEntry[] = await this.fs.list(this.processPath(target))
      return entries.map((entry) => {
        const child = posix.join(this.processPath(target), entry.name)
        return {
          name: entry.name,
          type: fsType(entry.kind),
          target: { targetKey: FsTargetKey(child), displayPath: child },
        }
      })
    })
  }

  /**
   * Write text inside the world under the host-checked per-call sandbox policy.
   * @param target - resolved world target.
   * @param content - the full new text (stored as UTF-8).
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before the world write; a completed write is not rolled back.
   * @param policy - the per-call sandbox policy; omit to resolve the deployment default.
   * @returns the write outcome with an LF-normalized diff basis.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    policy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.withLock(this.processPath(target), () => this.wrap(target.displayPath, async () => {
      this.enforcePolicy(target, policy ?? this.ctx.sandboxPolicy.resolve())
      if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
      const existing = await this.statInside(target)
      if (existing !== undefined && existing.kind !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (existing === undefined) {
          throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        }
        if (versionOf(existing) !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      const before = existing === undefined ? null : await this.diffBasis(target)
      await this.writeAtomic(target, Buffer.from(content, 'utf8'), signal)
      const after = await this.statInside(target)
      /* v8 ignore next 3 -- the post-write stat losing the file requires a concurrent world-side unlink between write and stat. */
      if (after === undefined) {
        return { operation: existing !== undefined ? 'update' : 'create', version: FsVersion(`missing:${String(target.targetKey)}`), before: null, after: lf(content) }
      }
      return { operation: existing !== undefined ? 'update' : 'create', version: versionOf(after), before, after: lf(content) }
    }))
  }

  /**
   * Apply one literal edit inside the world under the host-checked policy.
   * @param target - resolved world target.
   * @param edit - the old/new strings and replaceAll selection.
   * @param expected - the version guard for the edit; omit for unconditional.
   * @param signal - aborts before the world write; a completed edit is not rolled back.
   * @param policy - the per-call sandbox policy; omit to resolve the deployment default.
   * @returns the edit outcome with LF-normalized before/after text.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    policy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.withLock(this.processPath(target), () => this.wrap(target.displayPath, async () => {
      this.enforcePolicy(target, policy ?? this.ctx.sandboxPolicy.resolve())
      if (signal?.aborted) throw new FsError('edit aborted', 'FS_ABORTED')
      const existing = await this.statInside(target)
      if (existing === undefined) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.kind !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected !== undefined && versionOf(existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const bytes = await this.fs.readFile(this.processPath(target))
      const original = lf(decodeUtf8(bytes, target.displayPath).text)
      const normalizedEdit: FsEditRequest = { ...edit, oldString: lf(edit.oldString), newString: lf(edit.newString) }
      const edited = lf(applyLiteralEdit(original, normalizedEdit, target.displayPath))
      await this.writeAtomic(target, Buffer.from(edited, 'utf8'), signal)
      const after = await this.statInside(target)
      /* v8 ignore next 2 -- same concurrent-unlink window as the write path. */
      const version = after === undefined ? FsVersion(`missing:${String(target.targetKey)}`) : versionOf(after)
      return { version, before: original, after: edited }
    }))
  }

  /** Policy is host-checked: the world's agent has no enforcement of its own. */
  private enforcePolicy(target: FsTarget, policy: SandboxExecutionPolicy): void {
    if (policy.mode === 'danger-full-access') return
    if (policy.mode === 'read-only') {
      throw new FsError(`"${target.displayPath}" is read-only in the world (sandbox mode read-only)`, 'FS_SANDBOX_DENIED')
    }
    const root = posix.normalize(policy.workspaceRoot)
    const path = this.processPath(target)
    if (path !== root && !path.startsWith(root === '/' ? '/' : `${root}/`)) {
      throw new FsError(`"${target.displayPath}" is outside the world's workspace root ${root}`, 'FS_SANDBOX_DENIED')
    }
  }

  private async statInside(target: FsTarget): Promise<GuestStat | undefined> {
    try {
      return await this.fs.stat(this.processPath(target))
    } catch (error) {
      if (error instanceof GuestFsError && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Best-effort contextual-diff basis: the current text, or null when absent/too large/not text. */
  private async diffBasis(target: FsTarget): Promise<string | null> {
    try {
      const bytes = await this.fs.readFile(this.processPath(target))
      return lf(decodeUtf8(bytes, target.displayPath).text)
    } catch (error) {
      if (error instanceof GuestFsError && (error.code === 'ENOENT' || error.code === 'EFBIG')) return null
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw error
    }
  }

  /** Write-through-temp then rename: the world's own atomic replace. */
  private async writeAtomic(target: FsTarget, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
    this.tempCounter += 1
    const temp = `${this.processPath(target)}.dsh-${String(Date.now())}-${String(this.tempCounter)}`
    await this.fs.writeFile(temp, bytes)
    if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
    await this.fs.rename(temp, this.processPath(target))
  }
}

export default VmFileSystem
