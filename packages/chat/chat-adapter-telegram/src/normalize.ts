/**
 * Telegram update normalization into the unified `ChatInbound` union.
 *
 * Mention detection and bot-mention stripping follow dsh-im
 * (`src/channels/telegram/telegram-runtime.mjs`), MIT License, Copyright (c)
 * 2026 xmanrui; see THIRD_PARTY_NOTICES.md.
 * @module @deepseek-ai/dsh-chat-adapter-telegram/normalize
 */

import type { ChatAttachmentRef, ChatIdentity, ChatInbound, ChatRoute } from '@deepseek-ai/dsh-chat-adapter'

/** The bot an update is addressed to. */
export interface BotIdentity {
  /** Numeric Telegram bot id as a string. */
  id: string
  /** Bot username without the `@`, when known. */
  username?: string
}

type Dict = Record<string, unknown>

function dict(value: unknown): Dict {
  return typeof value === 'object' && value !== null ? value as Dict : {}
}

/** A string or number rendered as text; any other value becomes the empty string. */
function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined
}

/**
 * Compose the stable message id the bridge de-duplicates on. Telegram message
 * ids are unique only within a chat, so the chat id is part of the id.
 * @param chatId - Telegram chat id.
 * @param messageId - Telegram message id.
 * @returns `<chatId>:<messageId>`.
 */
export function inboundMessageId(chatId: number | string, messageId: number | string): string {
  return `${String(chatId)}:${String(messageId)}`
}

/**
 * Extract the Telegram message id from a bridge-visible id.
 * @param id - either a bare Telegram message id or `<chatId>:<messageId>`.
 * @returns the numeric message id, or undefined when malformed.
 */
export function outboundMessageId(id: string): number | undefined {
  const tail = id.slice(id.lastIndexOf(':') + 1)
  return /^\d+$/.test(tail) ? Number(tail) : undefined
}

function identity(user: unknown): ChatIdentity | undefined {
  const from = dict(user)
  const id = integer(from.id)
  if (id === undefined) return undefined
  const name = [from.first_name, from.last_name].filter((part): part is string => typeof part === 'string' && part.trim() !== '').map(part => part.trim()).join(' ')
  const displayName = name === '' ? (typeof from.username === 'string' ? from.username : undefined) : name
  return { userId: String(id), isBot: from.is_bot === true, ...displayName === undefined ? {} : { displayName } }
}

function routeOf(message: Dict): ChatRoute | undefined {
  const chat = dict(message.chat)
  const chatId = integer(chat.id)
  if (chatId === undefined || (chat.type !== 'private' && chat.type !== 'group' && chat.type !== 'supergroup')) return undefined
  const thread = integer(message.message_thread_id)
  return chat.type === 'private'
    ? { kind: 'direct', chatId: String(chatId) }
    : { kind: 'group', chatId: String(chatId), ...thread === undefined ? {} : { threadId: String(thread) } }
}

function mentions(text: unknown, entities: unknown, username: string | undefined): boolean {
  if (username === undefined || typeof text !== 'string' || !Array.isArray(entities)) return false
  return entities.some((entry) => {
    const entity = dict(entry)
    const offset = integer(entity.offset)
    const length = integer(entity.length)
    return entity.type === 'mention' && offset !== undefined && length !== undefined
      && text.slice(offset, offset + length).toLowerCase() === `@${username.toLowerCase()}`
  })
}

/**
 * Remove the bot's own mention from text so command parsing sees `/cmd args`.
 * @param text - message text or caption.
 * @param username - bot username.
 * @returns the text without `/cmd@bot` suffix and `@bot` mentions, trimmed.
 */
export function stripBotMention(text: string, username: string | undefined): string {
  if (username === undefined) return text.trim()
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .replace(new RegExp(`^(/[A-Za-z0-9_]+)@${escaped}\\b`, 'i'), '$1')
    .replace(new RegExp(`(^|\\s)@${escaped}(?![A-Za-z0-9_])`, 'gi'), '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function attachmentsOf(message: Dict): ChatAttachmentRef[] {
  const refs: ChatAttachmentRef[] = []
  const photos = Array.isArray(message.photo) ? message.photo.map(dict) : []
  const photo = photos.at(-1)
  if (photo !== undefined && typeof photo.file_id === 'string') {
    const bytes = integer(photo.file_size)
    refs.push({ attachmentId: photo.file_id, name: 'photo.jpg', mediaType: 'image/jpeg', ...bytes === undefined ? {} : { bytes } })
  }
  const document = dict(message.document)
  if (typeof document.file_id === 'string') {
    const bytes = integer(document.file_size)
    refs.push({
      attachmentId: document.file_id,
      ...typeof document.file_name === 'string' ? { name: document.file_name } : {},
      ...typeof document.mime_type === 'string' ? { mediaType: document.mime_type } : {},
      ...bytes === undefined ? {} : { bytes },
    })
  }
  return refs
}

/**
 * Normalize one Telegram update.
 * @param update - a raw `Update` object.
 * @param bot - the receiving bot.
 * @returns the normalized event, or undefined for updates the bridge does not consume
 * (channel posts, membership changes, malformed updates).
 */
export function normalizeUpdate(update: unknown, bot: BotIdentity): ChatInbound | undefined {
  const body = dict(update)
  if (body.callback_query !== undefined) {
    const callback = dict(body.callback_query)
    const message = dict(callback.message)
    const route = routeOf(message)
    const sender = identity(callback.from)
    const messageId = integer(message.message_id)
    if (typeof callback.id !== 'string' || typeof callback.data !== 'string' || route === undefined || sender === undefined || messageId === undefined) return undefined
    return { type: 'interaction', interactionId: callback.id, actionId: callback.data, route, sender }
  }
  const edited = body.edited_message !== undefined
  const message = dict(edited ? body.edited_message : body.message)
  const route = routeOf(message)
  const sender = identity(message.from)
  const messageId = integer(message.message_id)
  if (route === undefined || sender === undefined || messageId === undefined) return undefined
  const raw = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : ''
  const entities = typeof message.text === 'string' ? message.entities : message.caption_entities
  const controlText = stripBotMention(raw, bot.username)
  const id = inboundMessageId(route.chatId, messageId)
  const platformTime = (integer(message.date) ?? 0) * 1_000
  if (edited) return { type: 'message-edited', messageId: id, route, sender, text: raw, controlText, platformTime }
  const replyTo = dict(message.reply_to_message)
  const replyFrom = dict(replyTo.from)
  const replyMessageId = integer(replyTo.message_id)
  const command = /^\/[A-Za-z0-9_]+(?:@([A-Za-z0-9_]+))?/.exec(raw)
  const addressed = route.kind === 'direct'
    || scalar(replyFrom.id) === bot.id
    || mentions(raw, entities, bot.username)
    // A command prefix is addressed to this bot when it names no bot or names this one.
    || (command !== null && (command[1] === undefined || command[1].toLowerCase() === bot.username?.toLowerCase()))
  return {
    type: 'message', messageId: id, route, sender, addressed,
    ...replyMessageId === undefined ? {} : { replyToMessageId: inboundMessageId(route.chatId, replyMessageId) },
    text: raw, controlText, attachments: attachmentsOf(message), platformTime,
  }
}

/**
 * Read the callback query id of an update that needs a button acknowledgement.
 * @param update - a raw `Update`.
 * @returns the callback query id, or undefined for other updates.
 */
export function callbackQueryId(update: unknown): string | undefined {
  const id = dict(dict(update).callback_query).id
  return typeof id === 'string' ? id : undefined
}
