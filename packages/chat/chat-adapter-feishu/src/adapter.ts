/**
 * The Feishu/Lark {@link ChatAdapter}: receives events over the long
 * connection, and sends every text as an updatable `lark_md` card. Failures are
 * classified into {@link ChatAdapterError} codes.
 * @module @deepseek-ai/dsh-chat-adapter-feishu/adapter
 */

import { readFile } from 'node:fs/promises'
import {
  ChatAdapterError,
  type ChatAdapter, type ChatAdapterCapabilities, type ChatAttachmentRef, type ChatInboundSink, type ChatRoute,
  type InteractionPrompt, type InteractionSettlement, type OutboundFile, type OutboundMessage, type SentRef,
} from '@deepseek-ai/dsh-chat-adapter'
import { FeishuApi, FeishuApiError } from './api.ts'
import { interactionCard, markdownCard, settledCard, type Card } from './cards.ts'
import { normalizeEvent, parseAttachmentId, type BotIdentity } from './normalize.ts'
import { FeishuConnection, type FetchLike, type SocketLike } from './runtime.ts'

/** What Feishu supports, as the bridge needs to know it. */
export const FEISHU_CAPABILITIES: ChatAdapterCapabilities = {
  groupChats: true,
  threads: false,
  editOutbound: true,
  // Message updates are allowed for 14 days.
  editWindowMs: 14 * 24 * 60 * 60 * 1_000,
  // Card updates allow about five per second per message; stay well under it.
  minEditIntervalMs: 1_000,
  maxTextLength: 8_000,
  textFormat: 'lark-md',
  interactionButtons: true,
  reactions: false,
  typingIndicator: false,
  inboundFiles: true,
  outboundFiles: true,
  // The file upload API accepts files up to 30 MB.
  maxFileBytes: 30 * 1024 * 1024,
}

const REMEMBERED_PROMPTS = 200

type Operation = 'run' | 'send' | 'edit' | 'download'

/** Adapter construction. */
export interface FeishuAdapterOptions {
  appId: string
  api: FeishuApi
  domain: string
  secret: () => Promise<string>
  fetch: FetchLike
  createSocket: (url: string) => SocketLike
  warn: (message: string, error: unknown) => void
}

/**
 * Classify a thrown value for the operation that raised it.
 * @param error - anything thrown while talking to Feishu.
 * @param operation - what was being attempted.
 * @returns the adapter error the bridge maps to user-visible behavior.
 */
export function classify(error: unknown, operation: Operation): ChatAdapterError {
  if (error instanceof ChatAdapterError) return error
  const failure = error instanceof FeishuApiError
    ? error
    : new FeishuApiError(error instanceof Error ? error.message : String(error), { transport: true, cause: error })
  const options = { cause: failure }
  if (failure.credentialRejected || failure.status === 401) return new ChatAdapterError('auth-failed', 'feishu', 'the app credentials were rejected', options)
  if (failure.status === 429) return new ChatAdapterError('rate-limited', 'feishu', 'rate limited', { ...options, retryAfterMs: (failure.retryAfterSeconds ?? 1) * 1_000 })
  if (failure.status === 413 || /too large|exceed/i.test(failure.message)) return new ChatAdapterError('file-too-large', 'feishu', failure.message, options)
  if (operation === 'run' || operation === 'download') return new ChatAdapterError('network', 'feishu', failure.message, options)
  return new ChatAdapterError(operation === 'edit' ? 'edit-failed' : 'send-failed', 'feishu', failure.message, options)
}

/** Feishu/Lark transport for one app. */
export class FeishuAdapter implements ChatAdapter {
  readonly platform = 'feishu'
  readonly botId: string
  readonly capabilities = FEISHU_CAPABILITIES

  private readonly prompts = new Map<string, string>()
  private bot: BotIdentity = {}

  constructor(private readonly options: FeishuAdapterOptions) {
    this.botId = options.appId
  }

  /** @inheritdoc */
  async run(sink: ChatInboundSink, signal: AbortSignal): Promise<void> {
    try {
      const info = await this.options.api.callBody<{ bot?: { open_id?: string } }>({ method: 'GET', path: '/open-apis/bot/v3/info', signal })
      this.bot = info.bot?.open_id === undefined ? {} : { openId: info.bot.open_id }
      await new FeishuConnection({
        appId: this.options.appId,
        secret: this.options.secret,
        domain: this.options.domain,
        fetch: this.options.fetch,
        createSocket: this.options.createSocket,
        warn: this.options.warn,
        onEvent: async (event) => {
          const inbound = normalizeEvent(event, this.bot)
          if (inbound !== undefined) await sink.accept(inbound)
        },
      }).run(signal)
    } catch (error) {
      if (signal.aborted) return
      throw classify(error, 'run')
    }
  }

  /** @inheritdoc */
  stop(): Promise<void> {
    return Promise.resolve()
  }

  private async operate<T>(operation: Operation, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      throw classify(error, operation)
    }
  }

  private async post(route: ChatRoute, type: 'interactive' | 'file', content: unknown, replyTo?: string): Promise<SentRef> {
    const body = { msg_type: type, content: JSON.stringify(content) }
    const sent = replyTo === undefined
      ? await this.options.api.call<{ message_id: string }>({
        method: 'POST', path: '/open-apis/im/v1/messages',
        query: { receive_id_type: route.chatId.startsWith('ou_') ? 'open_id' : 'chat_id' },
        json: { receive_id: route.chatId, ...body },
      })
      : await this.options.api.call<{ message_id: string }>({
        method: 'POST', path: `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`, json: body,
      })
    return { messageId: sent.message_id, route }
  }

  private patch(ref: SentRef, card: Card): Promise<unknown> {
    return this.options.api.call({ method: 'PATCH', path: `/open-apis/im/v1/messages/${encodeURIComponent(ref.messageId)}`, json: { content: JSON.stringify(card) } })
  }

  /** @inheritdoc */
  send(route: ChatRoute, message: OutboundMessage): Promise<SentRef> {
    return this.operate('send', () => this.post(route, 'interactive', markdownCard(message.text), message.replyToMessageId))
  }

  /** @inheritdoc */
  edit(ref: SentRef, message: OutboundMessage): Promise<void> {
    return this.operate('edit', async () => { await this.patch(ref, markdownCard(message.text)) })
  }

  /** @inheritdoc */
  recall(ref: SentRef): Promise<void> {
    return this.operate('send', async () => { await this.options.api.call({ method: 'DELETE', path: `/open-apis/im/v1/messages/${encodeURIComponent(ref.messageId)}` }) })
  }

  /** @inheritdoc */
  sendInteraction(route: ChatRoute, prompt: InteractionPrompt): Promise<SentRef> {
    return this.operate('send', async () => {
      const ref = await this.post(route, 'interactive', interactionCard(prompt))
      this.prompts.set(ref.messageId, prompt.body)
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
    const body = this.prompts.get(ref.messageId)
    this.prompts.delete(ref.messageId)
    return this.operate('edit', async () => { await this.patch(ref, settledCard(body, state)) })
  }

  /** @inheritdoc */
  sendFile(route: ChatRoute, file: OutboundFile): Promise<SentRef> {
    return this.operate('send', async () => {
      const form = new FormData()
      form.append('file_type', 'stream')
      form.append('file_name', file.fileName)
      form.append('file', new Blob([await readFile(file.filePath)], { type: file.mediaType ?? 'application/octet-stream' }), file.fileName)
      const uploaded = await this.options.api.call<{ file_key: string }>({ method: 'POST', path: '/open-apis/im/v1/files', form, timeoutMs: 120_000 })
      return this.post(route, 'file', { file_key: uploaded.file_key })
    })
  }

  /** @inheritdoc */
  async fetchAttachment(
    ref: ChatAttachmentRef,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ stream: ReadableStream; mediaType: string }> {
    const parts = parseAttachmentId(ref.attachmentId)
    if (parts === undefined) throw new ChatAdapterError('network', 'feishu', `attachment id ${JSON.stringify(ref.attachmentId)} is not a Feishu resource`)
    const cap = Math.min(maxBytes, FEISHU_CAPABILITIES.maxFileBytes)
    const response = await this.operate('download', () => this.options.api.download(parts.messageId, parts.key, parts.type, signal))
    if (Number(response.headers.get('content-length') ?? Number.NaN) > cap) {
      await response.body?.cancel()
      throw new ChatAdapterError('file-too-large', 'feishu', `attachment is larger than ${String(cap)} bytes`)
    }
    if (response.body === null) throw new ChatAdapterError('network', 'feishu', 'the download returned no body')
    let received = 0
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > cap) throw new ChatAdapterError('file-too-large', 'feishu', `attachment is larger than ${String(cap)} bytes`)
        controller.enqueue(chunk)
      },
    }))
    return { stream, mediaType: ref.mediaType ?? response.headers.get('content-type') ?? 'application/octet-stream' }
  }

  /** @inheritdoc */
  directRoute(userId: string): ChatRoute {
    return { kind: 'direct', chatId: userId }
  }
}
