/**
 * Serialize harness messages into DeepSeek chat completions. User text is joined; assistant text
 * becomes `content`, tool calls become `tool_calls`, and tool results become separate tool messages.
 * Assistant reasoning is replayed as `reasoning_content` on every reasoned turn. Core image blocks are
 * rejected explicitly because this wire route is text-only;
 * unknown declaration-merged block types retain the adapter's documented extension fallback.
 * @module dsh-llm-deepseek/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentId, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { WireImageContentPart, WireMessage, WireRequest, WireTool, WireUserContentPart, WireTextContentPart } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
}

/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'high' | 'max' {
  if (effort === 'off' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'high' | 'max'
  }
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `DeepSeek deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The DeepSeek chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns (the model
    // can answer entirely in the reasoning channel, e.g. a v4-flash
    // greeting): the live API rejects null-content/no-tool_calls assistant
    // messages with a 400 ("content or tool_calls must be set"), and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // DeepSeek requires passback on tool-call turns and ignores it elsewhere;
    // compatible gateways may hash every reasoned turn to recover an upstream
    // thinking signature, so preserve the exact streamed text on plain turns.
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but DeepSeek wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** Provider representation for one retained request image. */
export type ImageRequestRepresentation =
  | {
    kind: 'file'
    resolveFileId: (
      version: RequestImageAttachment,
      location: ImageWireLocation,
    ) => Promise<string>
  }
  | { kind: 'base64' }

/** Dependencies required when serializing image-bearing messages. */
export interface ImageSerializationOptions {
  representation: ImageRequestRepresentation
  requestImages: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>
  omittedImages?: ReadonlySet<AttachmentId>
}

/** Position of an image in the original harness message sequence. */
export interface ImageWireLocation {
  message: number
  image: number
}

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

function imageHandle(version: RequestImageAttachment, precededByContent: boolean): WireTextContentPart {
  return {
    type: 'text',
    text: `${precededByContent ? '\n' : ''}[image ${version.attachment.attachmentId} ${version.width}x${version.height}]`,
  }
}

async function imageParts(
  block: Extract<ContentBlock, { type: 'image' }>,
  images: ImageSerializationOptions,
  location: ImageWireLocation,
  precededByContent: boolean,
): Promise<WireUserContentPart[]> {
  if (images.omittedImages?.has(block.attachment.attachmentId)) {
    return [{ type: 'text', text: `[image omitted: ${block.attachment.attachmentId}]` }]
  }
  const version = images.requestImages.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(`DeepSeek request image ${block.attachment.attachmentId} was not prepared.`, 'INVALID_REQUEST')
  }
  const image: WireImageContentPart = images.representation.kind === 'file'
    ? { type: 'file', file_id: await images.representation.resolveFileId(version, location) }
    : {
      type: 'image_url',
      image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
    }
  return [imageHandle(version, precededByContent), image]
}

async function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions,
  message: number,
  nextImage: { value: number },
): Promise<WireUserContentPart[]> {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        nextImage.value += 1
        parts.push(...await imageParts(block, images, { message, image: nextImage.value }, parts.length > 0))
        break
      case 'tool-result':
        parts.push(...await contentParts(block.content, images, message, nextImage))
        break
      default:
        break
    }
  }
  return parts
}

function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  const text: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') return [...parts]
    text.push(part.text)
  }
  return text.join('')
}

function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The DeepSeek chat-completions adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Serialize an image-capable request while preserving text-only tool messages.
 * @param messages - ordered harness messages.
 * @param images - request-image versions and provider representation.
 * @returns ordered wire messages.
 */
export async function serializeMessagesWithImages(
  messages: readonly Message[],
  images: ImageSerializationOptions,
): Promise<WireMessage[]> {
  assertSupportedImageRoles(messages)
  const wire: WireMessage[] = []
  let pendingToolImages: WireImageContentPart[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const [messageIndex, message] of messages.entries()) {
    const nextImage = { value: 0 }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => (
      block.type === 'tool-result'
    ))
    const content = userContent(await contentParts(regular, images, messageIndex + 1, nextImage))
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      const resultParts = await contentParts(result.content, images, messageIndex + 1, nextImage)
      const resultImages = resultParts.filter((part): part is WireImageContentPart => part.type !== 'text')
      const resultText = resultParts
        .filter((part): part is WireTextContentPart => part.type === 'text')
        .map(part => part.text)
        .join('')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: resultText || '(no output)',
      })
      pendingToolImages.push(...resultImages)
    }
  }
  flushToolImages()
  return wire
}

/**
 * Build a text-only wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so provider defaults apply.
 * @param options - generation request and message history.
 * @param defaults - adapter-level thinking defaults.
 * @returns the chat-completions request body.
 */
export function serializeRequest(options: GenerateOptions, defaults?: RequestDefaults): WireRequest
/**
 * Build an image-capable wire request using prepared provider representations.
 * @param options - generation request and message history.
 * @param defaults - adapter-level thinking defaults.
 * @param images - prepared request-image versions and representation resolver.
 * @returns the asynchronous chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults,
  images: ImageSerializationOptions,
): Promise<WireRequest>
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  images?: ImageSerializationOptions,
): WireRequest | Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  if (images === undefined) messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  // A short title budget must produce visible text; conversation and
  // compaction calls continue to inherit the adapter's thinking defaults.
  const resolvedThinking = resolveThinking(options, defaults)

  const finish = (serializedMessages: WireMessage[]): WireRequest => ({
    model: options.model,
    messages: serializedMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  })
  return images === undefined
    ? finish(messages)
    : serializeMessagesWithImages(options.messages, images).then(serialized => finish([
      ...options.system === undefined ? [] : [{ role: 'system' as const, content: options.system }],
      ...serialized,
    ]))
}
