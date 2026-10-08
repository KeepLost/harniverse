/**
 * The Telegram {@link ChatAdapter}: long-polls `getUpdates`, normalizes each
 * update, and sends text, inline-keyboard prompts, edits, and files through the
 * Bot API. Failures are classified into {@link ChatAdapterError} codes.
 * @module @deepseek-ai/dsh-chat-adapter-telegram/adapter
 */

import { readFile } from 'node:fs/promises'
import {
  ChatAdapterError,
  type ChatAdapter, type ChatAdapterCapabilities, type ChatAttachmentRef, type ChatInboundSink,
  type ChatRoute, type InteractionPrompt, type InteractionSettlement, type OutboundFile, type OutboundMessage, type SentRef,
} from '@deepseek-ai/dsh-chat-adapter'
import { TelegramApi, TelegramApiError } from './api.ts'
import { callbackQueryId, normalizeUpdate, outboundMessageId, type BotIdentity } from './normalize.ts'

/** What Telegram supports, as the bridge needs to know it. */
export const TELEGRAM_CAPABILITIES: ChatAdapterCapabilities = {
  groupChats: true,
  threads: true,
  editOutbound: true,
  editWindowMs: null,
  // Telegram tolerates about one edit per second per chat.
  minEditIntervalMs: 1_000,
  maxTextLength: 4_096,
  textFormat: 'plain',
  interactionButtons: true,
  reactions: false,
  typingIndicator: true,
  inboundFiles: true,
  outboundFiles: true,
  maxFileBytes: 50 * 1024 * 1024,
}

/** Download ceiling of the Bot API `getFile`. */
const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024
/** Telegram rejects `callback_data` longer than this. */
const CALLBACK_DATA_MAX_BYTES = 64
/** Interaction bodies remembered so a settled prompt can be rewritten. */
const REMEMBERED_PROMPTS = 200

type Operation = 'poll' | 'send' | 'edit' | 'download'

/** Adapter construction. */
export interface TelegramAdapterOptions {
  botId: string
  api: TelegramApi
  pollTimeoutSeconds: number
  warn: (message: string, error: unknown) => void
}

/**
 * Classify a thrown value for the operation that raised it.
 * @param error - anything thrown while talking to Telegram.
 * @param operation - what was being attempted.
 * @returns the adapter error the bridge maps to user-visible behavior.
 */
export function classify(error: unknown, operation: Operation): ChatAdapterError {
  if (error instanceof ChatAdapterError) return error
  const failure = error instanceof TelegramApiError
    ? error
    : new TelegramApiError(error instanceof Error ? error.message : String(error), { transport: true, cause: error })
  const code = failure.providerCode ?? failure.status
  const options = { cause: failure }
  if (code === 401) return new ChatAdapterError('auth-failed', 'telegram', 'the bot token was rejected', options)
  if (code === 409 && operation === 'poll') return new ChatAdapterError('poll-conflict', 'telegram', 'another instance is polling this bot', options)
  if (code === 429) {
    return new ChatAdapterError('rate-limited', 'telegram', 'rate limited', { ...options, retryAfterMs: (failure.retryAfterSeconds ?? 1) * 1_000 })
  }
  if (code === 413 || /too (?:big|large)/i.test(failure.message)) return new ChatAdapterError('file-too-large', 'telegram', failure.message, options)
  if (operation === 'poll' || operation === 'download') return new ChatAdapterError('network', 'telegram', failure.message, options)
  return new ChatAdapterError(operation === 'edit' ? 'edit-failed' : 'send-failed', 'telegram', failure.message, options)
}

/** Telegram transport for one bot. */
export class TelegramAdapter implements ChatAdapter {
  readonly platform = 'telegram'
  readonly botId: string
  readonly capabilities = TELEGRAM_CAPABILITIES

  private readonly api: TelegramApi
  private readonly pollTimeoutSeconds: number
  private readonly warn: TelegramAdapterOptions['warn']
  private readonly prompts = new Map<string, string>()
  private bot: BotIdentity
  private offset: number | undefined
  private running: AbortController | undefined

  constructor(options: TelegramAdapterOptions) {
    this.botId = options.botId
    this.api = options.api
    this.pollTimeoutSeconds = options.pollTimeoutSeconds
    this.warn = options.warn
    this.bot = { id: options.botId }
  }

  /** @inheritdoc */
  async run(sink: ChatInboundSink, signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    this.running = controller
    const stop = AbortSignal.any([signal, controller.signal])
    try {
      const me = await this.api.call<{ id: number; username?: string }>('getMe', {}, { signal: stop })
      this.bot = { id: String(me.id), ...me.username === undefined ? {} : { username: me.username } }
      while (!stop.aborted) {
        const updates = await this.api.getUpdates(this.offset, this.pollTimeoutSeconds, stop)
        for (const update of updates) await this.deliver(update, sink)
      }
    } catch (error) {
      if (stop.aborted) return
      throw classify(error, 'poll')
    } finally {
      this.running = undefined
    }
  }

  private async deliver(update: unknown, sink: ChatInboundSink): Promise<void> {
    const event = normalizeUpdate(update, this.bot)
    try {
      if (event !== undefined) await sink.accept(event)
    } catch (error) {
      // A handler failure must not wedge the poll loop on one update.
      this.warn('the bridge rejected an inbound event; skipping it', error)
    }
    const id = (update as { update_id?: unknown }).update_id
    if (typeof id === 'number') this.offset = id + 1
    const query = callbackQueryId(update)
    if (query !== undefined) await this.api.call('answerCallbackQuery', { callback_query_id: query }).catch(() => undefined)
  }

  /** @inheritdoc */
  stop(): Promise<void> {
    this.running?.abort()
    return Promise.resolve()
  }

  private async operate<T>(operation: Operation, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      throw classify(error, operation)
    }
  }

  private target(route: ChatRoute): Record<string, unknown> {
    return { chat_id: Number(route.chatId), ...route.threadId === undefined ? {} : { message_thread_id: Number(route.threadId) } }
  }

  /** @inheritdoc */
  send(route: ChatRoute, message: OutboundMessage): Promise<SentRef> {
    const replyTo = message.replyToMessageId === undefined ? undefined : outboundMessageId(message.replyToMessageId)
    return this.operate('send', async () => {
      const sent = await this.api.call<{ message_id: number }>('sendMessage', {
        ...this.target(route),
        text: message.text,
        link_preview_options: { is_disabled: true },
        ...replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } },
      })
      return { messageId: String(sent.message_id), route }
    })
  }

  /** @inheritdoc */
  edit(ref: SentRef, message: OutboundMessage): Promise<void> {
    return this.operate('edit', async () => {
      try {
        await this.api.call('editMessageText', {
          ...this.target(ref.route), message_id: Number(ref.messageId), text: message.text, link_preview_options: { is_disabled: true },
        })
      } catch (error) {
        // Re-sending identical text is not an error for a caller streaming the same content twice.
        if (!(error instanceof TelegramApiError && /message is not modified/i.test(error.message))) throw error
      }
    })
  }

  /** @inheritdoc */
  recall(ref: SentRef): Promise<void> {
    return this.operate('send', async () => {
      await this.api.call('deleteMessage', { chat_id: Number(ref.route.chatId), message_id: Number(ref.messageId) })
    })
  }

  /** @inheritdoc */
  sendInteraction(route: ChatRoute, prompt: InteractionPrompt): Promise<SentRef> {
    for (const action of prompt.actions) {
      if (Buffer.byteLength(action.id, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
        return Promise.reject(new ChatAdapterError('send-failed', 'telegram', `action id "${action.id}" exceeds ${String(CALLBACK_DATA_MAX_BYTES)} bytes`))
      }
    }
    return this.operate('send', async () => {
      const sent = await this.api.call<{ message_id: number }>('sendMessage', {
        ...this.target(route),
        text: prompt.body,
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: prompt.actions.map(action => [{ text: action.label, callback_data: action.id }]) },
      })
      const ref = { messageId: String(sent.message_id), route }
      this.prompts.set(`${route.chatId}:${ref.messageId}`, prompt.body)
      if (this.prompts.size > REMEMBERED_PROMPTS) {
        for (const oldest of this.prompts.keys()) {
          this.prompts.delete(oldest)
          break
        }
      }
      return ref
    })
  }

  /** @inheritdoc */
  settleInteraction(ref: SentRef, state: InteractionSettlement): Promise<void> {
    const key = `${ref.route.chatId}:${ref.messageId}`
    const body = this.prompts.get(key)
    this.prompts.delete(key)
    return this.operate('edit', async () => {
      // Editing the text without a reply_markup removes the keyboard.
      await this.api.call('editMessageText', {
        ...this.target(ref.route), message_id: Number(ref.messageId), text: `${body ?? ''}${body === undefined ? '' : '\n\n'}(${state})`,
        link_preview_options: { is_disabled: true },
      })
    })
  }

  /** @inheritdoc */
  sendFile(route: ChatRoute, file: OutboundFile): Promise<SentRef> {
    return this.operate('send', async () => {
      const form = new FormData()
      form.append('chat_id', route.chatId)
      if (route.threadId !== undefined) form.append('message_thread_id', route.threadId)
      form.append('document', new Blob([await readFile(file.filePath)], { type: file.mediaType ?? 'application/octet-stream' }), file.fileName)
      const sent = await this.api.call<{ message_id: number }>('sendDocument', form, { timeoutMs: 120_000 })
      return { messageId: String(sent.message_id), route }
    })
  }

  /** @inheritdoc */
  async fetchAttachment(
    ref: ChatAttachmentRef,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ stream: ReadableStream; mediaType: string }> {
    const cap = Math.min(maxBytes, DOWNLOAD_LIMIT_BYTES)
    const { response, body, size } = await this.operate('download', () => this.api.download(ref.attachmentId, signal))
    const declared = size ?? Number(response.headers.get('content-length') ?? Number.NaN)
    if (declared > cap) {
      await body.cancel()
      throw new ChatAdapterError('file-too-large', 'telegram', `attachment is larger than ${String(cap)} bytes`)
    }
    let received = 0
    const limited = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > cap) throw new ChatAdapterError('file-too-large', 'telegram', `attachment is larger than ${String(cap)} bytes`)
        controller.enqueue(chunk)
      },
    }))
    return { stream: limited, mediaType: ref.mediaType ?? response.headers.get('content-type') ?? 'application/octet-stream' }
  }

  /** @inheritdoc */
  async setTyping(route: ChatRoute): Promise<void> {
    await this.operate('send', async () => { await this.api.call('sendChatAction', { ...this.target(route), action: 'typing' }) })
  }

  /** @inheritdoc */
  directRoute(userId: string): ChatRoute {
    return { kind: 'direct', chatId: userId }
  }
}
