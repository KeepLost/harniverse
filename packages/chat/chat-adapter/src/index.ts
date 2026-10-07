/**
 * Service Definition for the unified chat adapter capability seam
 * (`ctx.chatAdapters`). Every IM or mobile platform registers one
 * {@link ChatAdapter}; the bridge core consumes the registry and never a
 * concrete platform. Registrations are effects: `register` returns its
 * disposer and providers install through `ctx.effect`.
 * @module @deepseek-ai/dsh-chat-adapter
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { chatAdapterKey } from './key.ts'
import type { ChatAdapter, ChatPlatformId } from './types.ts'

export type {
  ChatAdapter,
  ChatAdapterCapabilities,
  ChatAttachmentRef,
  ChatIdentity,
  ChatInbound,
  ChatInboundSink,
  ChatPlatformId,
  ChatRoute,
  InteractionPrompt,
  InteractionSettlement,
  OutboundFile,
  OutboundMessage,
  SentRef,
} from './types.ts'
export { ChatAdapterError, type ChatAdapterErrorCode } from './error.ts'
export { chatAdapterKey } from './key.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatAdapters: ChatAdapters
  }

  interface Events {
    /**
     * An adapter became resolvable in the registry.
     * @param adapter - the registered adapter.
     * @mode emit
     */
    'chat-adapter/registered'(adapter: ChatAdapter): void
    /**
     * An adapter left the registry; its `run` loop must stop.
     * @param adapter - the adapter that no longer resolves.
     * @mode emit
     */
    'chat-adapter/unregistered'(adapter: ChatAdapter): void
  }
}

/**
 * The chat adapter registry. Owns the set of mounted adapters keyed by
 * `platform:botId`; a duplicate key fails loud and every registration's
 * disposer removes exactly its own entry.
 */
export default class ChatAdapters extends Service {
  private readonly adapters = new Map<string, ChatAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'chatAdapters')
  }

  /**
   * Register one adapter for the lifetime of the calling effect scope.
   * `chat-adapter/registered` fires after the entry is readable and
   * `chat-adapter/unregistered` after it is gone.
   * @param adapter - the platform adapter to mount.
   * @returns the exact Cordis effect disposer; calling it twice is harmless.
   * @throws when `platform:botId` is already registered.
   */
  register(adapter: ChatAdapter): () => void {
    const key = chatAdapterKey(adapter.platform, adapter.botId)
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: ChatAdapters) {
      if (this.adapters.has(key)) throw new Error(`chatAdapters: ${key} is already registered`)
      this.adapters.set(key, adapter)
      yield () => {
        this.adapters.delete(key)
        this.ctx.emit('chat-adapter/unregistered', adapter)
      }
      this.ctx.emit('chat-adapter/registered', adapter)
    }.bind(this), 'chatAdapters.register()')
  }

  /**
   * Read one registered adapter.
   * @param platform - adapter platform id.
   * @param botId - adapter bot instance id.
   * @returns the adapter, or undefined while unregistered.
   */
  get(platform: ChatPlatformId, botId: string): ChatAdapter | undefined {
    return this.adapters.get(chatAdapterKey(platform, botId))
  }

  /**
   * Snapshot every mounted adapter.
   * @returns adapters in registration order.
   */
  list(): readonly ChatAdapter[] {
    return [...this.adapters.values()]
  }
}
