/** DeepSeek Files API upload reuse and bounded quota recovery. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFilesClient, isFilesQuotaError } from './files-api.ts'
import type { DeepSeekFileId } from './file-id.ts'
import { deepSeekFileScope, DeepSeekUploadIndex } from './upload-index.ts'
import type { DeepSeekUploadRecord } from './upload-index.ts'

/** Provider chat limit for one image even when referenced by file id. */
export const MAX_CHAT_IMAGE_BYTES = 32 * 1024 * 1024

/** Provider policy controlling remote file lifetime and quota recovery. */
export interface DeepSeekFilePolicy {
  expiresAfterSeconds: number
  refreshMarginSeconds: number
  quotaCleanupBatch: number
}

/** Endpoint and credential snapshot used for one Files operation. */
export interface DeepSeekFileConnection {
  baseURL: string
  apiKey: string
}

/** Cached or newly uploaded provider file mapping. */
export interface DeepSeekFileReference {
  record: DeepSeekUploadRecord
  uploaded: boolean
}

interface FileStoreOptions {
  index?: DeepSeekUploadIndex
  now?: () => number
  fetch?: typeof fetch
}

function extension(mediaType: RequestImageAttachment['mediaType']): 'png' | 'jpeg' | 'webp' | 'gif' {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpeg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}

function filename(version: RequestImageAttachment): string {
  const attachment = String(version.attachment.attachmentId).slice(7, 23)
  const variant = String(version.variantId).slice(7, 15)
  return `dsh-${attachment}-${variant}.${extension(version.mediaType)}`
}

/** User-scoped durable file-id reuse for one DeepSeek route. */
export class DeepSeekFileStore {
  private readonly index: DeepSeekUploadIndex
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch | undefined
  private readonly inflight = new Map<string, Promise<DeepSeekFileReference>>()

  constructor(options: FileStoreOptions = {}) {
    this.index = options.index ?? new DeepSeekUploadIndex()
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch
  }

  private client(connection: DeepSeekFileConnection): DeepSeekFilesClient {
    return new DeepSeekFilesClient({
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
      ...this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl },
    })
  }

  /** Resolve a reusable provider file or upload one request-image version.
   * @param version - bounded request image.
   * @param connection - endpoint and credential snapshot.
   * @param policy - expiry and quota policy.
   * @param signal - optional cancellation signal.
   * @returns the cached or newly uploaded file mapping.
   */
  ensureUploaded(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    signal?.throwIfAborted()
    if (version.bytes > MAX_CHAT_IMAGE_BYTES) {
      return Promise.reject(new LlmError('DeepSeek chat image exceeds the 32 MiB per-image limit.', 'INVALID_REQUEST'))
    }
    const scope = deepSeekFileScope(connection.baseURL, connection.apiKey)
    const key = `${scope}\0${version.variantId}`
    const active = this.inflight.get(key)
    if (active !== undefined) return this.wait(active, signal)
    const operation = this.ensureUploadedOnce(version, connection, scope, policy, signal)
    this.inflight.set(key, operation)
    // A live key is always returned above rather than replaced, so this entry
    // is still the one being settled.
    void operation.finally(() => { this.inflight.delete(key) }).catch(() => {})
    return this.wait(operation, signal)
  }

  private async wait(
    operation: Promise<DeepSeekFileReference>,
    signal?: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    signal?.throwIfAborted()
    if (signal === undefined) return operation
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('DeepSeek file wait aborted', { cause: signal.reason }))
      }
      signal.addEventListener('abort', abort, { once: true })
      void operation.then((value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error('DeepSeek file wait failed', { cause: error }))
      })
    })
  }

  private async ensureUploadedOnce(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    scope: ReturnType<typeof deepSeekFileScope>,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<DeepSeekFileReference> {
    const now = this.now()
    const marginMs = policy.refreshMarginSeconds * 1_000
    const cached = await this.index.get(scope, version.variantId, now, marginMs)
    if (cached !== undefined) return { record: cached, uploaded: false }
    const client = this.client(connection)
    const upload = async (): Promise<DeepSeekUploadRecord> => {
      const file = await client.upload({
        data: version.data,
        mediaType: version.mediaType,
        filename: filename(version),
        expiresAfterSeconds: policy.expiresAfterSeconds,
        ...signal === undefined ? {} : { signal },
      })
      if (file.bytes !== version.data.byteLength) {
        throw new LlmError('DeepSeek Files API upload response does not match the submitted image.', 'INVALID_RESPONSE')
      }
      return {
        scope,
        attachmentId: version.attachment.attachmentId,
        variantId: version.variantId,
        fileId: file.id,
        bytes: file.bytes,
        createdAt: file.createdAt,
        expiresAt: file.expiresAt,
      }
    }
    let candidate: DeepSeekUploadRecord
    try {
      candidate = await upload()
    } catch (error) {
      if (!isFilesQuotaError(error)) throw error
      await this.cleanupQuota(client, policy.quotaCleanupBatch, signal)
      candidate = await upload()
    }
    const committed = await this.index.commit(candidate, this.now(), marginMs)
    return { record: committed.record, uploaded: committed.accepted }
  }

  private async cleanupQuota(client: DeepSeekFilesClient, limit: number, signal?: AbortSignal): Promise<void> {
    const page = await client.list({ order: 'asc', limit, ...signal === undefined ? {} : { signal } })
    for (const file of page.data.slice(0, limit)) {
      if (file.filename.startsWith('dsh-')) await client.delete(file.id, signal).catch(() => {})
    }
  }

  /** Remove one matching provider mapping from the local index.
   * @param scope - endpoint/API-key scope.
   * @param variantId - request-image variant.
   * @param fileId - provider file id.
   */
  async invalidate(scope: ReturnType<typeof deepSeekFileScope>, variantId: RequestImageAttachment['variantId'], fileId: DeepSeekFileId): Promise<void> {
    await this.index.remove(scope, variantId, fileId)
  }

  /** Remove all local mappings for one endpoint/API-key scope.
   * @param scope - endpoint/API-key scope to clear.
   */
  async clear(scope: ReturnType<typeof deepSeekFileScope>): Promise<void> {
    await this.index.clear(scope)
  }
}
