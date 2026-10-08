/**
 * Conversation keys and the per-conversation serial queue. Inbound messages of
 * one conversation never run concurrently; different conversations do.
 * @module @deepseek-ai/dsh-chat-bridge/router
 */

import type { ChatRoute } from '@deepseek-ai/dsh-chat-adapter'

/**
 * Key of one conversation on one bot.
 * @param botId - bot instance id.
 * @param route - the conversation route.
 * @returns `botId:kind:chatId[:threadId]`.
 */
export function conversationKey(botId: string, route: ChatRoute): string {
  return `${botId}:${route.kind}:${route.chatId}${route.threadId === undefined ? '' : `:${route.threadId}`}`
}

/** Observation points around each queued task. */
export interface QueueHooks {
  start(key: string): void
  end(key: string): void
}

/** Serial execution per key. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly hooks: QueueHooks) {}

  /**
   * Run `task` after every earlier task of the same key settled.
   * @param key - serialization key.
   * @param task - the work.
   * @returns the task's result; a failure does not block later tasks.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(async () => {
      this.hooks.start(key)
      try {
        return await task()
      } finally {
        this.hooks.end(key)
      }
    })
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}
