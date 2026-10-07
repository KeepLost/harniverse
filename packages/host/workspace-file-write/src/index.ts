/**
 * Workspace-scoped user file editing (`ctx.workspaceFileWrite`): the Host
 * Remote behind the workbench editor. `open` reads a complete, decodable,
 * single-EOL, ≤1 MiB regular file inside a registered Workspace and returns
 * its `FsVersion` plus the decode decision; `save` restores the original
 * line-ending style and writes back through `ctx.fs.writeText` under a
 * version CAS, so the write inherits the local backend's per-target lock,
 * private staging, atomic publication, and mode/DACL preservation, and the
 * write-back reproduces the file's original encoding and byte order mark
 * through the backend's sticky decode decision. User saves bypass Agent
 * sandbox presets and approvals by design (the answering principal already
 * holds `harniverse.operate`); the hard path rules in `containment.ts` are
 * the boundary. Saves record no Agent observation, so an Agent's next
 * guarded write against the same file reports a stale version; the
 * commit-point event additionally injects a non-waking, path-only notice
 * into the Workspace's live sessions.
 * @module @deepseek-ai/dsh-workspace-file-write
 */

import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsTextEncoding } from '@deepseek-ai/dsh-fs'
import { encodeForWrite } from '@deepseek-ai/dsh-fs-codec'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: the workspaceRegistry Context merge (the WorkspaceId brand
// itself comes from the type-only subpath the Remote boundary requires).
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { canonicalTarget, canonicalTargetTolerant, containedRoot } from './containment.ts'
import type {
  WorkspaceFileOpenResult, WorkspaceFileSaveRequest, WorkspaceFileSaveResult, WorkspaceFileStatResult,
  WorkspaceFileWriteErrorCode,
} from './types.ts'

export type {
  WorkspaceFileEncodingSource, WorkspaceFileOpenResult, WorkspaceFileSaveRequest, WorkspaceFileSaveResult,
  WorkspaceFileStatResult, WorkspaceFileWriteErrorCode, WorkspaceFileWriteFailure,
} from './types.ts'

/** Plugin identity stamped on injected notices. */
export const SOURCE_ID = '@deepseek-ai/dsh-workspace-file-write'

/** Editable file bound shared by `open` and the save-side content check. */
export const WORKSPACE_EDIT_BYTE_LIMIT = 1024 * 1024

/** Live sessions one save may notify; a workspace with more running sessions still commits. */
const NOTICE_TARGET_LIMIT = 32

/** Minimum spacing between two notices for the same session and path. */
const NOTICE_DEDUPE_MS = 10_000

/** Committed saves remembered for `saveId` idempotency. */
const SAVE_ID_CACHE_LIMIT = 128

/** Acceptable `saveId` shape (mirrors the terminal-controller id policy). */
const SAVE_ID_PATTERN = /^[\w-]{1,128}$/u

/** Facts the commit-point event carries; published only after the write committed. */
export interface WorkspaceFileSavedEvent {
  readonly workspaceId: WorkspaceId
  /** Workspace-relative edited path. */
  readonly path: string
  /** `FsVersion` the write produced. */
  readonly version: string
  /** Byte size of the published content. */
  readonly bytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceFileWrite: WorkspaceFileWriteService
  }

  interface Events {
    /**
     * One user file edit committed through the workbench editor. Emitted at
     * the write's commit point only; listeners are synchronous recorders
     * whose failures the emitter logs rather than propagates.
     * @param event - the committed write's workspace/path/version facts.
     * @mode emit
     */
    'workspace-file/saved'(event: WorkspaceFileSavedEvent): void
  }
}

/** One settled line-ending analysis of decoded text. */
interface EolAnalysis {
  readonly eol: 'LF' | 'CRLF'
  readonly mixed: boolean
}

/** Count CRLF pairs and lone LF breaks without allocating split arrays. */
function analyzeEol(text: string): EolAnalysis {
  let crlf = 0
  let lf = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10 /* \n */) {
      if (index > 0 && text.charCodeAt(index - 1) === 13 /* \r */) crlf += 1
      else lf += 1
    }
  }
  return { eol: crlf > lf ? 'CRLF' : 'LF', mixed: crlf > 0 && lf > 0 }
}

/** The fallback decision for a backend that reports none: plain strict UTF-8. */
function fallbackDecision(eol: 'LF' | 'CRLF'): FsTextEncoding {
  return { encoding: 'utf-8', source: 'utf8', bom: false, eol }
}

/**
 * The workspace file-editing Remote. Methods are addressed by Workspace id
 * (never a Session): the workbench is a Workspace-scoped surface shared by
 * every session of that Workspace and usable with none of them running.
 */
export class WorkspaceFileWriteService extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'fs']

  /** Committed save outcomes by `saveId`, bounded FIFO. */
  private readonly saveOutcomes = new Map<string, WorkspaceFileSaveResult>()

  /** Last notice instant per `${sessionId}\u0000${path}`, for the spacing bound. */
  private readonly noticeSentAt = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'workspaceFileWrite')
    ctx.effect(() => () => {
      this.saveOutcomes.clear()
      this.noticeSentAt.clear()
    }, 'workspace-file-write: idempotency cache teardown')
    ctx.on('workspace-file/saved', (event) => {
      deliverEditNotices(
        {
          workspaceRegistry: ctx.workspaceRegistry,
          agents: ctx.get('agents') as Parameters<typeof deliverEditNotices>[0]['agents'],
          logger: ctx.logger,
        },
        event,
        this.noticeSentAt,
      )
    })
  }

  /**
   * Read one complete editable file (`harniverse.operate`).
   * @param workspaceId - registered Workspace owning the file.
   * @param path - workspace-relative file path.
   * @param signal - request cancellation.
   * @returns LF-normalized content with its version and decode decision.
   */
  @Remote({ exportName: 'open', requiredCapability: 'harniverse.operate' })
  async open(workspaceId: WorkspaceId, path: string, signal: AbortSignal): Promise<WorkspaceFileOpenResult> {
    const { target } = await this.resolveTarget(workspaceId, path)
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.statFile(target, signal)
      if (before === undefined) {
        throw new RemoteError<WorkspaceFileWriteErrorCode>('not-found', `workspace file ${JSON.stringify(path)} was not found`, {})
      }
      if (before.type !== 'file') {
        throw new RemoteError<WorkspaceFileWriteErrorCode>('not-regular', `workspace entry ${JSON.stringify(path)} is not a regular file`, {})
      }
      if (before.size !== undefined && before.size > WORKSPACE_EDIT_BYTE_LIMIT) {
        throw new RemoteError<WorkspaceFileWriteErrorCode>(
          'too-large',
          `workspace file ${JSON.stringify(path)} is ${String(before.size)} bytes, above the ${String(WORKSPACE_EDIT_BYTE_LIMIT)}-byte editing limit`,
          {},
        )
      }
      let decision: FsTextEncoding | undefined
      let text: string
      try {
        text = await this.ctx.fs.readText(target, signal, {
          onDecision: (settled) => { decision = settled },
        })
      } catch (error: unknown) {
        throw this.readRefusal(error, path)
      }
      const after = await this.statFile(target, signal)
      if (after === undefined || after.version !== before.version) continue
      const analysis = analyzeEol(text)
      if (analysis.mixed) {
        throw new RemoteError<WorkspaceFileWriteErrorCode>(
          'mixed-eol',
          `workspace file ${JSON.stringify(path)} mixes CRLF and LF line endings`,
          {},
        )
      }
      const settled = decision ?? fallbackDecision(analysis.eol)
      signal.throwIfAborted()
      return {
        content: analysis.eol === 'CRLF' ? text.replaceAll('\r\n', '\n') : text,
        version: before.version,
        bytes: before.size ?? Buffer.byteLength(text, 'utf8'),
        encoding: settled.encoding,
        encodingSource: settled.source,
        bom: settled.bom,
        eol: analysis.eol,
      }
    }
    throw new RemoteError<WorkspaceFileWriteErrorCode>('changed', `workspace file ${JSON.stringify(path)} changed while opening`, {})
  }

  /**
   * Probe one editable path's authoritative version (`harniverse.operate`).
   * The editor calls this after a watch frame; the watch frame's own version
   * string is a different format and must never be compared with this one.
   * @param workspaceId - registered Workspace owning the file.
   * @param path - workspace-relative file path.
   * @param signal - request cancellation.
   * @returns the file's `FsVersion`, or `absent` when the path is gone.
   */
  @Remote({ exportName: 'stat', requiredCapability: 'harniverse.operate' })
  async stat(workspaceId: WorkspaceId, path: string, signal: AbortSignal): Promise<WorkspaceFileStatResult> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new RemoteError<WorkspaceFileWriteErrorCode>('workspace-unknown', `unknown workspace ${JSON.stringify(String(workspaceId))}`, {})
    }
    const contained = await containedRoot(workspace.path, path)
    const canonical = await canonicalTargetTolerant(contained)
    if (canonical === undefined) return { absent: true }
    const target = await this.ctx.fs.resolve(canonical)
    const info = await this.statFile(target, signal)
    if (info === undefined) return { absent: true }
    if (info.type !== 'file') {
      throw new RemoteError<WorkspaceFileWriteErrorCode>('not-regular', `workspace entry ${JSON.stringify(path)} is not a regular file`, {})
    }
    return { version: info.version }
  }

  /**
   * Save one edited file under a version CAS on the editor's observed
   * version (`harniverse.operate`). The original encoding, byte order mark,
   * and line-ending style are re-derived from the file on disk inside the
   * CAS window, never trusted from the wire; a file that changed after the
   * editor's open refuses with `stale-version` and the current version.
   * @param workspaceId - registered Workspace owning the file.
   * @param path - workspace-relative file path.
   * @param request - LF content, the base version, and the idempotency id.
   * @param signal - request cancellation; a committed write survives it.
   * @returns the version the write produced.
   */
  @Remote({ exportName: 'save', requiredCapability: 'harniverse.operate' })
  async save(
    workspaceId: WorkspaceId,
    path: string,
    request: WorkspaceFileSaveRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceFileSaveResult> {
    if (!SAVE_ID_PATTERN.test(request.saveId)) {
      throw new RemoteError<WorkspaceFileWriteErrorCode>('path-invalid', 'invalid save identity', {})
    }
    const committed = this.saveOutcomes.get(request.saveId)
    if (committed !== undefined) return committed
    const { target, policy, event } = await this.resolveTarget(workspaceId, path)
    const present = await this.statFile(target, signal)
    if (present === undefined) {
      throw new RemoteError<WorkspaceFileWriteErrorCode>('not-found', `workspace file ${JSON.stringify(path)} was not found`, {})
    }
    // Re-decode the on-disk file the CAS still guards: the decision
    // reproduces the open-time encoding and BOM (a successful CAS proves the
    // bytes did not move), and its line-ending style is the one to restore.
    let disk: string
    let decision: FsTextEncoding | undefined
    try {
      disk = await this.ctx.fs.readText(target, signal, {
        onDecision: (settled) => { decision = settled },
      })
    } catch (error: unknown) {
      throw this.readRefusal(error, path)
    }
    const analysis = analyzeEol(disk)
    const settled = decision ?? fallbackDecision(analysis.eol)
    const restored = analysis.eol === 'CRLF'
      ? request.content.replaceAll('\r\n', '\n').split('\n').join('\r\n')
      : request.content
    const encoded = encodeForWrite(restored, settled.encoding, { bom: settled.bom })
    if (!encoded.ok) {
      const { unmappable } = encoded
      const hex = unmappable.codePoint.toString(16).toUpperCase().padStart(4, '0')
      throw new RemoteError<WorkspaceFileWriteErrorCode>(
        'unmappable',
        `${unmappable.char} (U+${hex}) at line ${String(unmappable.line)} column ${String(unmappable.column)} cannot be encoded in the file's original encoding`,
        {},
      )
    }
    if (encoded.bytes.byteLength > WORKSPACE_EDIT_BYTE_LIMIT) {
      throw new RemoteError<WorkspaceFileWriteErrorCode>(
        'too-large',
        `the encoded save is ${String(encoded.bytes.byteLength)} bytes, above the ${String(WORKSPACE_EDIT_BYTE_LIMIT)}-byte editing limit`,
        {},
      )
    }
    try {
      const outcome = await this.ctx.fs.writeText(
        target,
        restored,
        { kind: 'replaceIfVersion', version: FsVersion(request.baseVersion) },
        signal,
        policy,
      )
      const result: WorkspaceFileSaveResult = { version: outcome.version }
      this.saveOutcomes.set(request.saveId, result)
      if (this.saveOutcomes.size > SAVE_ID_CACHE_LIMIT) {
        const oldest = this.saveOutcomes.keys().next().value
        /* v8 ignore next -- the map just crossed a positive bound, so its
           iterator always yields a key; the guard only satisfies noUncheckedIndexedAccess. */
        if (oldest !== undefined) this.saveOutcomes.delete(oldest)
      }
      this.ctx.emit('workspace-file/saved', { ...event, version: outcome.version, bytes: encoded.bytes.byteLength })
      return result
    } catch (error: unknown) {
      throw await this.writeRefusal(error, path, target, signal)
    }
  }

  /**
   * Resolve a Workspace id and request path to the guarded fs target: the
   * registry's canonical root, the lexical path rules, the canonical
   * (symlink-free) target, and the `workspace-write` policy rooted at the
   * canonical workspace directory.
   */
  private async resolveTarget(
    workspaceId: WorkspaceId,
    path: string,
  ): Promise<{ target: FsTarget; policy: SandboxExecutionPolicy; event: Omit<WorkspaceFileSavedEvent, 'version' | 'bytes'> }> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new RemoteError<WorkspaceFileWriteErrorCode>('workspace-unknown', `unknown workspace ${JSON.stringify(String(workspaceId))}`, {})
    }
    const contained = await containedRoot(workspace.path, path)
    const canonical = await canonicalTarget(contained)
    const target = await this.ctx.fs.resolve(canonical)
    return {
      target,
      policy: { mode: 'workspace-write', workspaceRoot: contained.root },
      event: { workspaceId, path: contained.relative },
    }
  }

  /** Stat through the fs seam so version tokens stay the backend's own. */
  private async statFile(target: FsTarget, signal: AbortSignal | undefined): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    const info = await this.ctx.fs.stat(target, signal)
    signal?.throwIfAborted()
    return info
  }

  /** Map an fs read failure onto the typed refusal vocabulary. */
  private readRefusal(error: unknown, path: string): RemoteError<WorkspaceFileWriteErrorCode> {
    if (error instanceof FsError && error.code === 'FS_NOT_TEXT') {
      return new RemoteError<WorkspaceFileWriteErrorCode>(
        'not-text',
        `workspace file ${JSON.stringify(path)} is not decodable text`,
        {},
        { cause: error },
      )
    }
    return new RemoteError<WorkspaceFileWriteErrorCode>(
      'io',
      `workspace file ${JSON.stringify(path)} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      {},
      { cause: error },
    )
  }

  /** Map a CAS write failure onto the typed refusal vocabulary. */
  private async writeRefusal(
    error: unknown,
    path: string,
    target: FsTarget,
    signal: AbortSignal | undefined,
  ): Promise<RemoteError<WorkspaceFileWriteErrorCode>> {
    if (error instanceof FsError && error.code === 'FS_STALE_VERSION') {
      const current = await this.statFile(target, signal).catch(() => undefined)
      const details = current !== undefined ? { currentVersion: current.version } : {}
      return new RemoteError<WorkspaceFileWriteErrorCode>(
        'stale-version',
        `workspace file ${JSON.stringify(path)} changed since it was read`,
        details,
        { cause: error },
      )
    }
    if (error instanceof FsError && error.code === 'FS_UNMAPPABLE') {
      return new RemoteError<WorkspaceFileWriteErrorCode>('unmappable', error.message, {}, { cause: error })
    }
    return new RemoteError<WorkspaceFileWriteErrorCode>(
      'io',
      `workspace file ${JSON.stringify(path)} cannot be written: ${error instanceof Error ? error.message : String(error)}`,
      {},
      { cause: error },
    )
  }
}

/**
 * Inject the path-only, non-waking notice into the Workspace's live
 * sessions. Failures are logged: a notice is advisory, never a reason to
 * report a committed save as failed.
 * @param deps - the registry, agents, and logger faces the notice path reads.
 * @param event - the committed save the notice describes.
 * @param sentAt - the service's per session+path spacing map.
 */
export function deliverEditNotices(
  deps: {
    workspaceRegistry: { get(id: WorkspaceId): { path: string } | undefined }
    agents: { list(): Iterable<{ id: string; session: { header: { cwd?: string } }; inject(message: UserMessage): void }> } | undefined
    logger: { warn(message: string): void }
  },
  event: WorkspaceFileSavedEvent,
  sentAt: Map<string, number>,
): void {
  const agents = deps.agents
  if (agents === undefined) return
  const workspacePath = deps.workspaceRegistry.get(event.workspaceId)?.path
  if (workspacePath === undefined) return
  let targets = 0
  const now = Date.now()
  for (const agent of agents.list()) {
    if (targets >= NOTICE_TARGET_LIMIT) break
    const cwd = agent.session.header.cwd
    if (cwd === undefined) continue
    let canonical: string
    try {
      canonical = realpathSync.native(cwd)
    } catch {
      continue
    }
    if (canonical !== workspacePath) continue
    const key = `${agent.id}\u0000${event.path}`
    const last = sentAt.get(key)
    if (last !== undefined) {
      if (now - last < NOTICE_DEDUPE_MS) continue
    }
    sentAt.set(key, now)
    targets += 1
    try {
      agent.inject(noticeMessage(event.path))
    } catch (error: unknown) {
      deps.logger.warn(`workspace-file-write: could not queue an edit notice: ${String(error)}`)
    }
  }
}

/**
 * The model-facing, path-only notice text.
 * @param path - the workspace-relative path the user saved.
 * @returns the notice sentence naming the path.
 */
export function noticeText(path: string): string {
  return `The user saved an edit to ${JSON.stringify(path)} in the workbench editor. `
    + 'Your earlier view of that file may be stale; read it again before editing it or relying on its earlier contents.'
}

/**
 * Build the injected inbox message for one saved path.
 * @param path - the workspace-relative path the user saved.
 * @returns the plugin-sourced system-injection message carrying the notice.
 */
export function noticeMessage(path: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: noticeText(path) }],
    source: { kind: 'plugin', plugin: SOURCE_ID, form: 'system-injection', path },
  })
}

export default WorkspaceFileWriteService
