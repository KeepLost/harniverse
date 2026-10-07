/**
 * Failures of the `chatBots` Remote and of the embedded bridge's startup.
 * @module @deepseek-ai/dsh-chat-manager/errors
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatBotErrorCode } from './types.ts'

/**
 * A `chatBots` call failure. The carrier's error vocabulary is closed, so the
 * wire code is the registered `chat-bot-failed` and the stable
 * {@link ChatBotErrorCode} rides in `details.reason`. Messages are Chinese and
 * never carry a secret.
 */
export class ChatBotError extends RemoteError<'chat-bot-failed'> {
  /** The stable reason a client discriminates on. */
  readonly reason: ChatBotErrorCode

  /**
   * @param reason - stable failure reason.
   * @param message - Chinese, secret-free explanation shown to the user.
   */
  constructor(reason: ChatBotErrorCode, message: string) {
    super('chat-bot-failed', message, { reason })
    this.name = 'ChatBotError'
    this.reason = reason
  }
}

/** The embedded bridge cannot start for an environmental reason the user can fix; `message` is Chinese and secret-free. */
export class BridgeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BridgeUnavailableError'
  }
}
