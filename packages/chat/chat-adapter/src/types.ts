/**
 * The single platform-neutral chat adapter contract shared by every IM and
 * mobile platform. Types only — no runtime code lives in this module.
 * @module @deepseek-ai/dsh-chat-adapter/types
 */

import type { Context } from '@deepseek-ai/cordis'

/** Open platform identity: shipped adapters use `telegram` and `feishu`. */
export type ChatPlatformId = 'telegram' | 'feishu' | (string & {})

/** Declarative capability set one adapter instance offers to the bridge core. */
export interface ChatAdapterCapabilities {
  /** Whether group chats reach this bot at all. */
  groupChats: boolean
  /** Whether the platform has threads/topics inside one chat. */
  threads: boolean
  /** Whether sent messages can be edited in place. */
  editOutbound: boolean
  /** Platform edit window in ms, or null when the platform imposes none. */
  editWindowMs: number | null
  /** Minimum spacing the platform tolerates between edits; the core throttles to it. */
  minEditIntervalMs: number
  /** Maximum characters of one text message; the core splits beyond it. */
  maxTextLength: number
  /** Text rendering dialect already applied to inbound `text` fields. */
  textFormat: 'plain' | 'telegram-html' | 'lark-md' | (string & {})
  /** Whether interaction prompts may use buttons; false degrades to text replies. */
  interactionButtons: boolean
  /** Whether the platform exposes message reactions. */
  reactions: boolean
  /** Whether an in-progress typing hint exists. */
  typingIndicator: boolean
  /** Whether inbound messages can carry files. */
  inboundFiles: boolean
  /** Whether the adapter can send files out. */
  outboundFiles: boolean
  /** Largest file the platform accepts, in bytes. */
  maxFileBytes: number
}

/** One resolved conversation position a message is routed to. */
export interface ChatRoute {
  kind: 'direct' | 'group'
  chatId: string
  threadId?: string
}

/** Platform-side identity of one chat participant. */
export interface ChatIdentity {
  userId: string
  alternateId?: string
  displayName?: string
  isBot: boolean
}

/** Reference to one inbound platform attachment, resolvable via {@link ChatAdapter.fetchAttachment}. */
export interface ChatAttachmentRef {
  attachmentId: string
  name?: string
  mediaType?: string
  bytes?: number
}

/** Normalized inbound event: message identity, edit/delete signals, and interaction callbacks. */
export type ChatInbound =
  | {
    type: 'message'
    messageId: string
    route: ChatRoute
    sender: ChatIdentity
    /** Whether the message addressed this bot (group mention, reply, or command prefix). */
    addressed: boolean
    replyToMessageId?: string
    /** Rendered body in the adapter's `capabilities.textFormat`. */
    text: string
    /** Decoration-stripped body; command parsing reads only this. */
    controlText: string
    attachments: ChatAttachmentRef[]
    platformTime: number
  }
  | {
    type: 'message-edited'
    messageId: string
    route: ChatRoute
    sender: ChatIdentity
    text: string
    controlText: string
    platformTime: number
  }
  | {
    type: 'message-deleted'
    messageId: string
    route: ChatRoute
    platformTime: number
  }
  | {
    type: 'interaction'
    interactionId: string
    actionId: string
    value?: string
    route: ChatRoute
    sender: ChatIdentity
  }

/** Inbound sink handed to {@link ChatAdapter.run}; resolving accepts the event and deduplication belongs to the core. */
export interface ChatInboundSink {
  accept(event: ChatInbound): Promise<void>
}

/** One outbound text message. */
export interface OutboundMessage {
  text: string
  replyToMessageId?: string
}

/** One outbound file delivery. */
export interface OutboundFile {
  filePath: string
  fileName: string
  mediaType?: string
  bytes: number
}

/** Reference to one sent message, usable for later edits, recall, or interaction settlement. */
export interface SentRef {
  messageId: string
  route: ChatRoute
}

/** One interaction prompt the core wants rendered with actionable choices. */
export interface InteractionPrompt {
  kind: 'approval' | 'question'
  body: string
  actions: Array<{ id: string; label: string }>
}

/** Terminal state an earlier interaction prompt settled into. */
export type InteractionSettlement = 'answered' | 'expired' | 'superseded'

/**
 * One platform adapter. `run` drives the platform's long-poll or long
 * connection and resolves only when `signal` aborts; every outbound method
 * fails with {@link ChatAdapterError} carrying a classified code.
 */
export interface ChatAdapter {
  readonly platform: ChatPlatformId
  /** Stable bot instance identity unique within its platform. */
  readonly botId: string
  readonly capabilities: ChatAdapterCapabilities
  /** Long-poll or long-connection main loop; resolves only on abort. */
  run(sink: ChatInboundSink, signal: AbortSignal): Promise<void>
  /** Idempotent teardown of connections and temporary files. */
  stop(): Promise<void>
  send(route: ChatRoute, message: OutboundMessage): Promise<SentRef>
  /** Optional because platforms without message editing degrade to final-only output. */
  edit?(ref: SentRef, message: OutboundMessage): Promise<void>
  /** Platform-level delete; when absent the core degrades to a tombstone edit. */
  recall?(ref: SentRef): Promise<void>
  sendInteraction?(route: ChatRoute, prompt: InteractionPrompt): Promise<SentRef>
  settleInteraction?(ref: SentRef, state: InteractionSettlement): Promise<void>
  sendFile?(route: ChatRoute, file: OutboundFile): Promise<SentRef>
  fetchAttachment(ref: ChatAttachmentRef, maxBytes: number, signal: AbortSignal): Promise<{ stream: ReadableStream; mediaType: string }>
  setTyping?(route: ChatRoute): Promise<void>
  /** Direct-chat route for one user, when the platform can address them proactively. */
  directRoute(userId: string): ChatRoute | undefined
}

/** One credential or setting a platform needs before it can mount a bot. */
export interface ChatPlatformField {
  /** Stable key: 'token', 'appId', 'appSecret', 'baseUrl', 'domain'. */
  key: string
  /** Chinese product label. */
  label: string
  /** Secret fields are stored as credentials and never returned to a browser. */
  secret: boolean
  required: boolean
  placeholder?: string
  hint?: string
  /** Closed choice list; the UI renders a select. */
  options?: ReadonlyArray<{ value: string; label: string }>
}

/** Identity a platform reports for a validated bot. */
export interface ChatBotIdentity {
  botId: string
  displayName: string
}

/** One bot a host manages: its non-secret values and the credential names holding its secrets. */
export interface ChatManagedBot {
  /** Non-secret field values by field key (defaults already applied by the caller only for fields it was given). */
  values: Readonly<Record<string, string>>
  /** Credential name holding each secret field's value, by field key. */
  secretRefs: Readonly<Record<string, string>>
}

/**
 * What a platform provider tells a host about itself: the fields a user fills
 * in, how to validate them, and how to mount one adapter per managed bot. A
 * host stays generic over platforms by reading these descriptors from
 * `ctx.chatAdapters`.
 */
export interface ChatPlatformDescriptor {
  readonly platform: ChatPlatformId
  /** Channel name shown in the UI, e.g. 'Telegram', '飞书'. */
  readonly label: string
  readonly fields: readonly ChatPlatformField[]
  /**
   * Validate a full set of field values (secrets included, as typed) by calling the platform once.
   * Resolves the bot identity; rejects with ChatAdapterError (classified: auth-failed, network, ...) otherwise.
   * Must not log or echo secret values. Honors `signal`.
   */
  probe(values: Readonly<Record<string, string>>, signal: AbortSignal): Promise<ChatBotIdentity>
  /**
   * Mount exactly one adapter for a managed bot in the caller's scope: resolve secrets from `ctx.credentials`
   * through `bot.secretRefs`, fail the mount (throw) when a secret is unset/malformed, and register the adapter with
   * `ctx.effect(() => ctx.chatAdapters.register(adapter))`.
   */
  mount(ctx: Context, bot: ChatManagedBot): Promise<void>
}
