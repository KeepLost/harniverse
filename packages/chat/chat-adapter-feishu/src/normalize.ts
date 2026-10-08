/**
 * Feishu event normalization into the unified `ChatInbound` union.
 * @module @deepseek-ai/dsh-chat-adapter-feishu/normalize
 */

import type { ChatAttachmentRef, ChatInbound } from '@deepseek-ai/dsh-chat-adapter'

/** The receiving bot. */
export interface BotIdentity {
  /** The app's `open_id` as a bot, used to detect mentions. */
  openId?: string
}

type Dict = Record<string, unknown>

function dict(value: unknown): Dict {
  return typeof value === 'object' && value !== null ? value as Dict : {}
}

/** A string or number rendered as text; any other value becomes the empty string. */
function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function parseContent(content: unknown): Dict {
  if (typeof content !== 'string') return {}
  try {
    return dict(JSON.parse(content))
  } catch {
    // Feishu content is JSON by contract; a malformed body is treated as an empty message.
    return {}
  }
}

/** Flatten a `post` (rich text) body, which may be wrapped by locale, into plain text. */
function postText(body: Dict): string {
  const post = Array.isArray(body.content) ? body : Object.values(body).map(dict).find(entry => Array.isArray(entry.content)) ?? {}
  const rows = Array.isArray(post.content) ? post.content : []
  const lines = rows.map(row => (Array.isArray(row) ? row : []).map((segment) => {
    const part = dict(segment)
    if (part.tag === 'at') return `@${typeof part.user_name === 'string' ? part.user_name : 'user'}`
    return typeof part.text === 'string' ? part.text : ''
  }).join(''))
  return [...typeof post.title === 'string' && post.title !== '' ? [post.title] : [], ...lines].join('\n')
}

/**
 * Normalize one decoded Feishu event.
 * @param event - a schema 2.0 event payload (`header` and `event`).
 * @param bot - the receiving bot.
 * @returns the normalized event, or undefined for event types the bridge does not consume.
 */
export function normalizeEvent(event: unknown, bot: BotIdentity): ChatInbound | undefined {
  const envelope = dict(event)
  const type = dict(envelope.header).event_type
  const body = dict(envelope.event)
  if (type === 'card.action.trigger') return normalizeAction(body)
  if (type !== 'im.message.receive_v1') return undefined
  const message = dict(body.message)
  const senderInfo = dict(body.sender)
  const userId = dict(senderInfo.sender_id).open_id
  const chatId = message.chat_id
  const messageId = message.message_id
  if (typeof userId !== 'string' || typeof chatId !== 'string' || typeof messageId !== 'string') return undefined
  const direct = message.chat_type === 'p2p'
  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).map(dict)
  const content = parseContent(message.content)
  const raw = message.message_type === 'text' ? scalar(content.text) : message.message_type === 'post' ? postText(content) : ''
  const botKeys = new Set(
    mentions
      .filter(mention => bot.openId !== undefined && dict(mention.id).open_id === bot.openId)
      .map(mention => String(mention.key)),
  )
  const nameOf = (key: string): string => `@${scalar(mentions.find(mention => mention.key === key)?.name) || 'user'}`
  const text = raw.replace(/@_user_\d+/g, key => nameOf(key))
  const controlText = raw.replace(/@_user_\d+/g, key => (botKeys.has(key) ? '' : nameOf(key))).replace(/\s{2,}/g, ' ').trim()
  const attachments: ChatAttachmentRef[] = []
  if (message.message_type === 'image' && typeof content.image_key === 'string') {
    attachments.push({ attachmentId: `${messageId}:${content.image_key}:image`, name: 'image' })
  }
  if (message.message_type === 'file' && typeof content.file_key === 'string') {
    attachments.push({ attachmentId: `${messageId}:${content.file_key}:file`, ...typeof content.file_name === 'string' ? { name: content.file_name } : {} })
  }
  const parent = message.parent_id
  return {
    type: 'message',
    messageId,
    route: { kind: direct ? 'direct' : 'group', chatId },
    sender: { userId, isBot: senderInfo.sender_type !== 'user' },
    addressed: direct || botKeys.size > 0,
    ...typeof parent === 'string' && parent !== '' ? { replyToMessageId: parent } : {},
    text, controlText, attachments,
    platformTime: Number(message.create_time ?? 0) || 0,
  }
}

function normalizeAction(body: Dict): ChatInbound | undefined {
  const operator = dict(body.operator)
  const context = dict(body.context)
  const value = dict(dict(body.action).value)
  const userId = operator.open_id
  const chatId = context.open_chat_id
  if (typeof userId !== 'string' || typeof chatId !== 'string' || typeof value.action !== 'string') return undefined
  return {
    type: 'interaction',
    interactionId: scalar(body.token) || scalar(context.open_message_id),
    actionId: value.action,
    // A card callback carries no chat type; the bridge only replies to this route.
    route: { kind: 'direct', chatId },
    sender: { userId, isBot: false },
  }
}

/**
 * Split a bridge-visible attachment id.
 * @param id - `<messageId>:<resourceKey>:<image|file>`.
 * @returns the parts, or undefined when malformed.
 */
export function parseAttachmentId(id: string): { messageId: string; key: string; type: 'image' | 'file' } | undefined {
  const [messageId, key, type, ...extra] = id.split(':')
  if (messageId === undefined || key === undefined || extra.length > 0 || (type !== 'image' && type !== 'file') || messageId === '' || key === '') return undefined
  return { messageId, key, type }
}
