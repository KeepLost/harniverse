/** Shared catalog and request-local dependency types for DeepSeek protocols. */

import type { ModelModality, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { DeepSeekFileStore } from './file-store.ts'

/** Supported wire implementations. */
export type DeepSeekProtocol = 'chat-completions' | 'messages'

/** One optional model entry advertised by the direct-fetch adapter. */
export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to {@link DeepSeekConnectionOptions.maxTokens}. */
  maxTokens?: number
  /** Input modalities accepted by this exact configured route. */
  inputModalities?: ModelModality[]
  /**
   * Total-pixel budget for one request image, or the 512-by-512 `low`
   * preset; omission uses the full-detail default budget.
   */
  imagePixelBudget?: number | 'low'
  /** Maximum encoded bytes for one derived request image. */
  imageMaxBytes?: number
  /**
   * `'in-history'` declares that the endpoint reads the latest `system`
   * message at any position of the conversation as the complete effective
   * system prompt; omission means only a leading system message is read.
   */
  systemPromptUpdate?: 'in-history'
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface DeepSeekConnectionOptions {
  /** Wire protocol selected by plugin configuration. */
  protocol: DeepSeekProtocol
  /** Endpoint root compatible with the selected protocol. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-wide request-image byte budget before older images are omitted. */
  maxRequestFilesBytes: number
  /** Inline request-image byte budget after Files fallback. */
  maxInlineRequestImageBytes: number
  /** Maximum retained images in one provider request. */
  maxImagesPerRequest: number
  /** Raw image-byte offload quantum. */
  imageOffloadByteQuantum: number
  /** Inline image-byte offload quantum. */
  inlineImageOffloadByteQuantum: number
  /** Image-count offload quantum. */
  imageOffloadCountQuantum: number
  /** Files API resolution timeout. */
  filesApiTimeoutMs: number
  /** Requested remote file lifetime. */
  fileExpiresAfterSeconds: number
  /** Minimum remaining lifetime before an upload is refreshed. */
  fileRefreshMarginSeconds: number
  /** Number of old provider files deleted for one quota retry. */
  fileQuotaCleanupBatch: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for the dispatching {@link DeepSeekAdapter}: the operation-local resolution hooks the plugin owns. */
export interface DeepSeekAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => DeepSeekConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>
  /** Resolve the harness-home anonymous id shared with telemetry and feedback. */
  resolveUserId: () => AnonymousUserId
  /** Resolve durable attachments only for image-bearing requests. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Resolve the provider-local remote file cache. */
  resolveFiles?: () => DeepSeekFileStore
  /** Report unusable native Messages replay metadata without exposing content or signatures. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
}
