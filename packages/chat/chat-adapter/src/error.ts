/**
 * Classified adapter failure. The bridge core maps each {@link ChatAdapterErrorCode}
 * to user-visible behavior instead of retrying blind.
 * @module @deepseek-ai/dsh-chat-adapter/error
 */

import type { ChatPlatformId } from './types.ts'

/** Closed classification of everything a platform transport can fail with. */
export type ChatAdapterErrorCode =
  | 'auth-failed'
  | 'rate-limited'
  | 'send-failed'
  | 'edit-failed'
  | 'file-too-large'
  | 'file-type'
  | 'poll-conflict'
  | 'network'

/** Adapter-thrown error carrying the classification the core routes on. */
export class ChatAdapterError extends Error {
  /** Classification the bridge core maps to user-visible behavior. */
  readonly code: ChatAdapterErrorCode
  /** Platform-advised backoff in ms, when provided (HTTP 429 `retry_after`). */
  readonly retryAfterMs?: number

  constructor(code: ChatAdapterErrorCode, platform: ChatPlatformId, message: string, options?: { retryAfterMs?: number; cause?: unknown }) {
    super(`chat-adapter(${platform}): ${message}`, options)
    this.code = code
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}
