/**
 * Host plugin importing a DeepSeek chat export (chat.deepseek.com
 * `deepseek_data-*.zip`) uploaded by the browser as stored DSH Sessions in a
 * chosen Workspace. The upload is processed in memory, settled through the
 * session-import discipline, and never written to disk beyond the imported
 * Sessions and their retained sources.
 * @module @deepseek-ai/dsh-host-deepseek-chat-import
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-import'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { importDeepseekChatExport } from './importer.ts'
import { createUploadRoute } from './upload.ts'
import type { ImportClaim } from './upload.ts'
import type { DeepseekChatImportLimits } from './types.ts'

export { ExportEntryError, ExportSourceError } from './archive.ts'
export { ExportConversationError } from './conversation.ts'
export type { ExportArchive } from './archive.ts'
export type { ConvertConversationOptions, ConvertedConversation } from './conversation.ts'
export type { DeepseekChatImportDependencies, DeepseekChatImportRequest, DeepseekChatImportWorkspace } from './importer.ts'
export type { ImportClaim, UploadRouteHandler } from './upload.ts'
export type {
  DeepseekChatImportFailureReason, DeepseekChatImportLimits, DeepseekChatImportLine, DeepseekChatImportResponse, DeepseekChatImportResult,
  DeepseekChatImportSkip,
} from './types.ts'

/** Deployment limits of the importer. */
export interface Config {
  /** Most Sessions one import writes, choosing the conversations the export index lists as most recently updated. */
  maxSessions: number
  /** Largest export archive, in bytes, one upload may carry; the whole archive is held in memory while it is imported. */
  maxUploadBytes: number
  /** Largest declared uncompressed size, in bytes, of one archive entry; larger entries are not decompressed. */
  maxEntryBytes: number
  /** Largest UTF-8 size, in bytes, of an imported title, matching the session-title service's limit of the composition. */
  maxTitleBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Upload route and Remote limits of the DeepSeek chat export importer. */
    deepseekChatImport: DeepseekChatImportService
  }
}

/** Serves the export upload route and the limits the browser checks first. */
export default class DeepseekChatImportService extends TypertRemoteService {
  static inject = ['sessionImport', 'workspaceRegistry']

  static Config: z<Config> = z.object({
    maxSessions: z.natural().min(1).default(1000),
    maxUploadBytes: z.natural().min(1).default(512 * 1024 * 1024),
    maxEntryBytes: z.natural().min(1).default(256 * 1024 * 1024),
    maxTitleBytes: z.natural().min(1).default(80),
  })

  /** The running import, which owns the single import slot. */
  private active: { readonly controller: AbortController; readonly settled: Promise<void> } | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'deepseekChatImport')
    ctx.effect(() => async () => {
      // Unloading cancels the running import and completes only after it stops writing.
      this.active?.controller.abort()
      await this.active?.settled
    }, 'deepseek-chat-import: running import')
  }

  /**
   * The upload route (UPLOAD_PATH from ./protocol.ts) the API proxy carrier serves:
   * one `harniverse.operate`-gated POST carries the complete archive, which is
   * buffered in memory, imported, and released when the import ends. The
   * answer streams `application/x-ndjson` progress lines and one outcome line.
   * @param request - the raw carrier request with the archive body.
   * @returns the streaming NDJSON response.
   */
  uploadRoute(request: Request): Promise<Response> {
    const route = createUploadRoute({
      maxUploadBytes: this.config.maxUploadBytes,
      claim: () => this.claim(),
      // The registry lookup validates the wire id; an unknown id answers undefined.
      workspace: id => this.ctx.workspaceRegistry.get(id as WorkspaceId),
      import: (archive, workspace, onProgress, signal) => importDeepseekChatExport({
        sessionImport: this.ctx.sessionImport,
        attachments: this.ctx.get('attachments'),
        workspaceRegistered: id => this.ctx.workspaceRegistry.get(id as WorkspaceId) !== undefined,
        createId: () => randomUUID(),
        warn: (message) => { this.ctx.logger.warn(message) },
      }, {
        archive,
        workspace,
        limits: {
          maxSessions: this.config.maxSessions,
          maxEntryBytes: this.config.maxEntryBytes,
          maxTitleBytes: this.config.maxTitleBytes,
        },
        onProgress,
      }, signal),
      failed: (error) => { this.ctx.logger.error('deepseek-chat-import: import failed', error) },
    })
    return route(request)
  }

  /**
   * Report the limits the browser checks before uploading.
   * @param signal - Client cancellation or Remote withdrawal.
   * @returns the largest accepted archive size.
   */
  @Remote({ exportName: 'limits', requiredCapability: 'harniverse.operate' })
  limits(signal?: AbortSignal): DeepseekChatImportLimits {
    signal?.throwIfAborted()
    return { maxUploadBytes: this.config.maxUploadBytes }
  }

  private claim(): ImportClaim | undefined {
    if (this.active !== undefined) return undefined
    const controller = new AbortController()
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>()
    this.active = { controller, settled }
    return {
      signal: controller.signal,
      release: () => {
        this.active = undefined
        settle()
      },
    }
  }
}
