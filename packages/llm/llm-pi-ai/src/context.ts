/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */

import { CallId, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'

/** Join the text blocks of a harness message. */
function flattenText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}


/** Flatten text recursively inside one tool result. */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '').join('')
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const stored = await attachments.readImage(block.attachment)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      case 'tool-result':
        {
          const nested = await userContent(block.content, attachments)
          if (typeof nested === 'string') {
            if (nested.length > 0) content.push({ type: 'text', text: nested })
          } else {
            content.push(...nested)
          }
        }
        break
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

type ReplayDegradeHandler = (reason: string) => void

/**
 * One bounded model-visible notice, appended to the request history when an
 * earlier assistant reasoning chain could not be carried onto this route.
 * Deterministically derived from logged message sources, so the request stays
 * reconstructable from the Session log.
 */
const REASONING_DEGRADE_NOTICE = [
  '<system-reminder>',
  'An earlier assistant turn in this conversation reasoned under a different model route, and its reasoning chain cannot be replayed here. Only the recorded reasoning text above survives; treat it as an incomplete record and do not assume the reasoning behind earlier decisions is fully preserved.',
  '</system-reminder>',
].join('\n')

/** Whether one assistant message carries reasoning content at all. */
function hasReasoning(message: Message): boolean {
  return message.role === 'assistant' && message.content.some(block => block.type === 'reasoning')
}

/** Whether one assistant message's reasoning cannot replay on the request's route. */
function reasoningUnreplayableOnRoute(message: Message, options: GenerateOptions): boolean {
  const source = message.source
  return source.kind !== 'model'
    || source.replayState === undefined
    || source.provider !== options.provider
    || source.model !== options.model
}

/**
 * Wrap the caller's degrade handler for one assistant message: a reasoning
 * message that degrades — either because it has no replay metadata or because
 * its stored route no longer matches — records that this request carries an
 * unreplayable chain. Non-reasoning degrades still report through unchanged.
 */
function degradeTrackerFor(
  message: Message,
  onReplayDegrade: ReplayDegradeHandler | undefined,
  record: (degraded: boolean) => void,
): ReplayDegradeHandler {
  return (reason: string) => {
    if (hasReasoning(message)) record(true)
    onReplayDegrade?.(reason)
  }
}

function textOnlyContext(options: GenerateOptions, onReplayDegrade?: ReplayDegradeHandler): PiContext {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  let degradedReasoning = false
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      if (hasReasoning(message) && reasoningUnreplayableOnRoute(message, options)) degradedReasoning = true
      const degrade = degradeTrackerFor(message, onReplayDegrade, (degraded) => { degradedReasoning = degraded })
      const assistant = toPiAssistant(message, degrade)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter(block => block.type === 'tool-result')
    // Results first: pi-ai's history transform treats any user message between
    // an assistant tool call and its result as an interruption, answering the
    // call with a synthetic "No result provided" before the real one arrives.
    // The user's own text follows the results instead of preceding them.
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{
          type: 'text',
          text: toolResultText(result.content) || '(no output)',
        }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
    if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
  }
  if (degradedReasoning) messages.push({ role: 'user', content: REASONING_DEGRADE_NOTICE, timestamp: 0 })
  return piContext(options, messages)
}

/**
 * Convert text-only harness history to a synchronous pi-ai Context while
 * reporting unusable provider replay metadata. Tool result names are recovered
 * from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param onReplayDegrade - called when one assistant message falls back to neutral history.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 */
export function toPiContext(options: GenerateOptions, onReplayDegrade?: ReplayDegradeHandler): PiContext
/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param attachments - durable byte resolver for image references.
 * @param onReplayDegrade - called when one assistant message falls back to neutral history.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(
  options: GenerateOptions,
  attachments: AttachmentStore,
  onReplayDegrade?: ReplayDegradeHandler,
): Promise<PiContext>
export function toPiContext(
  options: GenerateOptions,
  attachmentsOrReplayDegrade?: AttachmentStore | ReplayDegradeHandler,
  onReplayDegrade?: ReplayDegradeHandler,
): PiContext | Promise<PiContext> {
  const attachments = typeof attachmentsOrReplayDegrade === 'function' ? undefined : attachmentsOrReplayDegrade
  const replayDegrade = typeof attachmentsOrReplayDegrade === 'function'
    ? attachmentsOrReplayDegrade
    : onReplayDegrade
  return attachments === undefined
    ? textOnlyContext(options, replayDegrade)
    : toPiContextWithImages(options, attachments, replayDegrade)
}

async function toPiContextWithImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  onReplayDegrade?: ReplayDegradeHandler,
): Promise<PiContext> {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  let degradedReasoning = false

  for (const message of options.messages) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) {
        throw new LlmError('pi-ai cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      // pi-ai has a single systemPrompt slot; in-history system messages are
      // folded into user messages to preserve order (rare in practice — the
      // harness sends the system prompt via options.system).
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      if (hasReasoning(message) && reasoningUnreplayableOnRoute(message, options)) degradedReasoning = true
      const degrade = degradeTrackerFor(message, onReplayDegrade, (degraded) => { degradedReasoning = degraded })
      const assistant = toPiAssistant(message, degrade)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    // user role: text + tool results (each result becomes its own message).
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const content = await userContent(regular, attachments)
    const results = message.content.filter(block => block.type === 'tool-result')
    // Results first, for the same reason as the text-only path: a user message
    // between an assistant tool call and its result makes pi-ai answer the
    // call synthetically before the real result arrives.
    for (const result of results) {
      const resultContent = await userContent(result.content, attachments)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string'
          ? [{ type: 'text', text: resultContent || '(no output)' }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
  }
  if (degradedReasoning) messages.push({ role: 'user', content: REASONING_DEGRADE_NOTICE, timestamp: 0 })

  return piContext(options, messages)
}
