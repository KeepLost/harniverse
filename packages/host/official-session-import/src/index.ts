/**
 * The official-session import Remote: discovers official DeepSeek Harness
 * session logs under this machine's configured roots, reports each one's
 * import status against the archives already persisted here, and imports
 * selected logs — or an uploaded log — as archival sessions into a chosen
 * workspace or the workspace at the source's own working directory. Every
 * call runs on the machine the client targets, so a remote host scans and
 * imports into its own DSH home.
 *
 * @module @deepseek-ai/dsh-host-official-session-import
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ForeignLogError, ImportConflictError, type ForeignArtifactSummary } from '@deepseek-ai/dsh-session-import'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { discoverOfficialLogs, resolveSourceId } from './discovery.ts'
import type {
  OfficialImportOutcome, OfficialImportResult, OfficialImportTarget, OfficialSessionCandidate,
  OfficialSessionScan, OfficialSessionUnreadable,
} from './types.ts'

export type * from './types.ts'

/** Default ceiling for one log read from disk or accepted as an upload. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

/** Plugin configuration. */
export interface Config {
  /** Absolute directories holding official session logs, each laid out `<project>/<session>/session.vN.jsonl[.zstd]`. */
  roots: string[]
  /** Largest log, in bytes, read from disk or accepted as an upload. */
  maxArtifactBytes: number
}

/** One cached description, valid while the log keeps its size and mtime. */
interface CachedDescription {
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly summary: ForeignArtifactSummary
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Import status of one described log against the persisted session ids. */
function statusOf(summary: ForeignArtifactSummary, ids: readonly string[]): Pick<OfficialSessionCandidate, 'status' | 'archiveSessionId'> {
  if (ids.includes(summary.sessionId)) return { status: 'imported', archiveSessionId: summary.sessionId }
  const older = ids.find(id => id.startsWith(summary.lineage))
  return older === undefined ? { status: 'new' } : { status: 'updated', archiveSessionId: older }
}

/** Remote-only service importing official DeepSeek Harness sessions on the serving machine. */
export class OfficialSessionImport extends TypertRemoteService {
  static inject = ['sessionImport', 'sessionPersistence', 'workspaceRegistry']

  static Config: z<Config> = z.object({
    roots: z.array(z.string()).required(),
    maxArtifactBytes: z.natural().min(1).default(DEFAULT_MAX_ARTIFACT_BYTES),
  })

  private readonly roots: readonly string[]
  private readonly maxArtifactBytes: number
  private readonly descriptions = new Map<string, CachedDescription>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'officialSessionImport')
    const relativeRoot = config.roots.find(root => !isAbsolute(root))
    if (relativeRoot !== undefined) {
      throw new TypeError(`official-session-import roots must be absolute, got ${JSON.stringify(relativeRoot)}`)
    }
    this.roots = [...config.roots]
    this.maxArtifactBytes = config.maxArtifactBytes
  }

  /**
   * Discover every importable official session under the configured roots.
   * Descriptions are cached per log while its size and mtime are unchanged,
   * so a repeated scan reads only logs that changed.
   * @param signal - cancellation between filesystem reads.
   * @returns the candidates, most recently updated first, and what could not be offered.
   */
  @Remote({ exportName: 'scan', requiredCapability: 'harniverse.operate' })
  async scan(signal?: AbortSignal): Promise<OfficialSessionScan> {
    const discovery = await discoverOfficialLogs(this.roots, signal)
    const unreadable: OfficialSessionUnreadable[] = discovery.failures
      .map(failure => ({ path: failure.path, reason: 'unreadable', message: failure.message }))
    const described: Array<{ sourceId: string; path: string; sizeBytes: number; summary: ForeignArtifactSummary }> = []
    const seen = new Set<string>()
    for (const log of discovery.logs) {
      signal?.throwIfAborted()
      seen.add(log.path)
      try {
        const info = await stat(log.path)
        if (info.size > this.maxArtifactBytes) {
          unreadable.push({ path: log.path, reason: 'too-large', message: `${String(info.size)} bytes exceeds the ${String(this.maxArtifactBytes)}-byte limit` })
          continue
        }
        const cached = this.descriptions.get(log.path)
        const summary = cached !== undefined && cached.sizeBytes === info.size && cached.mtimeMs === info.mtimeMs
          ? cached.summary
          : this.ctx.sessionImport.describe(await readFile(log.path))
        this.descriptions.set(log.path, { sizeBytes: info.size, mtimeMs: info.mtimeMs, summary })
        described.push({ sourceId: log.sourceId, path: log.path, sizeBytes: info.size, summary })
      } catch (error) {
        this.descriptions.delete(log.path)
        unreadable.push({ path: log.path, reason: error instanceof ForeignLogError ? 'invalid' : 'unreadable', message: message(error) })
      }
    }
    // Forget logs that disappeared, so the cache tracks what is on disk.
    for (const path of this.descriptions.keys()) if (!seen.has(path)) this.descriptions.delete(path)
    const ids = (await this.ctx.sessionPersistence.list(signal)).map(header => header.id)
    const items = described.map(({ sourceId, path, sizeBytes, summary }): OfficialSessionCandidate => ({
      sourceId,
      path,
      format: summary.format,
      sourceSessionId: summary.sourceSessionId,
      ...summary.sourceCwd === undefined ? {} : { sourceCwd: summary.sourceCwd },
      ...summary.title === undefined ? {} : { title: summary.title },
      ...summary.preview === undefined ? {} : { preview: summary.preview },
      turns: summary.turns,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      sizeBytes,
      ...statusOf(summary, ids),
    })).sort((a, b) => b.updatedAt - a.updatedAt || a.sourceId.localeCompare(b.sourceId))
    return { roots: [...this.roots], items, unreadable, maxArtifactBytes: this.maxArtifactBytes }
  }

  /**
   * Import discovered official sessions one after another.
   * @param sourceIds - source ids from a scan of this machine.
   * @param target - where the archives land.
   * @param signal - cancellation between imports.
   * @returns one outcome per requested source, in request order.
   */
  @Remote({ exportName: 'importSources', requiredCapability: 'harniverse.operate' })
  async importSources(sourceIds: string[], target: OfficialImportTarget, signal?: AbortSignal): Promise<OfficialImportResult[]> {
    const results: OfficialImportResult[] = []
    for (const sourceId of sourceIds) {
      signal?.throwIfAborted()
      results.push({ source: sourceId, outcome: await this.importSource(sourceId, target) })
    }
    return results
  }

  /**
   * Import one uploaded official session log.
   * @param fileName - the uploaded file's name, echoed in the result.
   * @param contentBase64 - the exact log bytes, base64-encoded.
   * @param target - where the archive lands.
   * @returns the outcome for the upload.
   */
  @Remote({ exportName: 'importUpload', requiredCapability: 'harniverse.operate' })
  async importUpload(fileName: string, contentBase64: string, target: OfficialImportTarget): Promise<OfficialImportResult> {
    const source = basename(fileName)
    // Reject before decoding: base64 carries three bytes per four characters.
    if (contentBase64.length > Math.ceil(this.maxArtifactBytes / 3) * 4) {
      return { source, outcome: this.tooLarge(contentBase64.length * 3 / 4) }
    }
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.length > this.maxArtifactBytes) return { source, outcome: this.tooLarge(bytes.length) }
    return { source, outcome: await this.importBytes(bytes, target) }
  }

  private tooLarge(size: number): OfficialImportOutcome {
    return { status: 'failed', reason: 'too-large', message: `${String(Math.ceil(size))} bytes exceeds the ${String(this.maxArtifactBytes)}-byte limit` }
  }

  private async importSource(sourceId: string, target: OfficialImportTarget): Promise<OfficialImportOutcome> {
    const path = resolveSourceId(this.roots, sourceId)
    if (path === undefined) return { status: 'failed', reason: 'source-missing', message: `unknown source ${JSON.stringify(sourceId)}` }
    let bytes: Buffer
    try {
      const info = await stat(path)
      if (info.size > this.maxArtifactBytes) return this.tooLarge(info.size)
      bytes = await readFile(path)
    } catch (error) {
      return { status: 'failed', reason: 'source-missing', message: message(error) }
    }
    return await this.importBytes(bytes, target)
  }

  private async importBytes(bytes: Uint8Array, target: OfficialImportTarget): Promise<OfficialImportOutcome> {
    let summary: ForeignArtifactSummary
    try {
      summary = this.ctx.sessionImport.describe(bytes)
    } catch (error) {
      return { status: 'failed', reason: 'invalid', message: message(error) }
    }
    const workspace = await this.targetWorkspace(target, summary)
    if (!('id' in workspace)) return workspace
    try {
      const imported = await this.ctx.sessionImport.import({ artifact: bytes, cwd: workspace.path })
      let attached = true
      try { await workspace.attachSession(imported.sessionId) } catch (error) {
        // Settlement already succeeded; the archive stays listed as Ungrouped.
        attached = false
        this.ctx.logger.warn(`imported archive ${imported.sessionId} could not join its workspace: ${message(error)}`)
      }
      return {
        status: 'imported',
        sessionId: imported.sessionId,
        workspaceId: workspace.id,
        attached,
        ...imported.title === undefined ? {} : { title: imported.title },
        mappedEvents: imported.mappedEvents,
        skippedEvents: imported.skippedEvents,
      }
    } catch (error) {
      if (error instanceof ImportConflictError) return { status: 'already-imported', sessionId: error.sessionId }
      return { status: 'failed', reason: error instanceof ForeignLogError ? 'invalid' : 'failed', message: message(error) }
    }
  }

  private async targetWorkspace(
    target: OfficialImportTarget,
    summary: ForeignArtifactSummary,
  ): Promise<Workspace | Extract<OfficialImportOutcome, { status: 'failed' }>> {
    if (target.kind === 'workspace') {
      return this.ctx.workspaceRegistry.get(target.workspaceId)
        ?? { status: 'failed', reason: 'workspace-unavailable', message: `workspace ${JSON.stringify(target.workspaceId)} not found` }
    }
    if (summary.sourceCwd === undefined) {
      return { status: 'failed', reason: 'workspace-unavailable', message: 'the official session recorded no working directory' }
    }
    try {
      // Registration is idempotent: an existing workspace at this path is reused.
      return await this.ctx.workspaceRegistry.create(summary.sourceCwd)
    } catch (error) {
      return { status: 'failed', reason: 'workspace-unavailable', message: `cannot use ${JSON.stringify(summary.sourceCwd)} as a workspace here: ${message(error)}` }
    }
  }
}

export default OfficialSessionImport
