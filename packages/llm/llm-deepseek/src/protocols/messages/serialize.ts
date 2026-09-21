/** Map system snapshots and conversation turns to Messages using the configured route capability. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { RequestDefaults } from '../../common/types.ts'
import type { DeepSeekConnectionOptions as Connection } from '../../common/types.ts'
import type { ImageSerializationOptions, ImageWireLocation } from '../../common/request-images.ts'
import { readReplay } from './replay.ts'
import type { WireBlock, WireInput, WireMessage, WireRequest } from './types.ts'

function unsupported(type: string): never {
  throw new LlmError(`DeepSeek Messages cannot represent ${type}`, 'UNSUPPORTED_CONTENT')
}

/** Historical arguments that Messages cannot represent use empty input; durable content stays unchanged. */
function toolInput(raw: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) } catch (_invalidToolHistoryJson) {
    return {}
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function assistant(message: Message, model: string, onReplayDegrade?: (reason: string) => void): WireBlock[] {
  const replay = readReplay(message, model, onReplayDegrade)
  return message.content.map((block, index): WireBlock => {
    switch (block.type) {
      case 'text': return { type: 'text', text: block.text }
      case 'reasoning': return {
        type: 'thinking', thinking: block.text,
        ...replay?.[index]?.signature === undefined ? {} : { signature: replay[index].signature },
      }
      case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }
      default: return unsupported(`assistant content ${block.type}`)
    }
  })
}

function imageHandle(version: RequestImageAttachment, precededByContent: boolean): WireInput {
  return {
    type: 'text',
    text: `${precededByContent ? '\n' : ''}[image ${version.attachment.attachmentId} ${version.width}x${version.height}]`,
  }
}

async function input(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions | undefined,
  location: ImageWireLocation,
): Promise<WireInput[]> {
  const parts: WireInput[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'tool-result') return unsupported('nested tool result')
    if (block.type !== 'image') return unsupported(`user content ${block.type}`)
    if (images === undefined) return unsupported('unprepared user image')
    if (images.omittedImages?.has(block.attachment.attachmentId)) {
      parts.push({ type: 'text', text: `[image omitted: ${block.attachment.attachmentId}]` })
      continue
    }
    const version = images.requestImages.get(block.attachment.attachmentId)
    if (version === undefined) {
      throw new LlmError(`DeepSeek request image ${block.attachment.attachmentId} was not prepared.`, 'INVALID_REQUEST')
    }
    parts.push(imageHandle(version, parts.length > 0))
    parts.push(images.representation.kind === 'file'
      ? { type: 'image', source: { type: 'file', file_id: await images.representation.resolveFileId(version, location) } }
      : {
        type: 'image',
        source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') },
      })
  }
  return parts
}

/** Map one user-role turn: tool results wrap their inner content; other blocks flatten. */
async function userBlocks(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions | undefined,
  location: ImageWireLocation,
): Promise<WireBlock[]> {
  const parts: WireBlock[] = []
  for (const block of blocks) {
    if (block.type === 'tool-result') {
      parts.push({
        type: 'tool_result', tool_use_id: block.toolCallId,
        content: await input(block.content, images, location),
        ...block.isError === undefined ? {} : { is_error: block.isError },
      })
      continue
    }
    parts.push(...await input([block], images, location))
  }
  return parts
}

/** Serialize one complete request using already prepared image bytes.
 * @param options - provider-neutral request.
 * @param connection - validated defaults and thinking policy.
 * @param defaults - adapter-level thinking defaults.
 * @param history - durable history; never mutated.
 * @param images - prepared image versions and representation, or undefined for text-only requests.
 * @param onReplayDegrade - diagnostic for discarded native replay metadata.
 * @returns the Messages API JSON body.
 */
export async function serialize(
  options: GenerateOptions,
  connection: Connection,
  defaults: RequestDefaults,
  history: readonly Message[],
  images: ImageSerializationOptions | undefined,
  onReplayDegrade?: (reason: string) => void,
): Promise<WireRequest> {
  const model = connection.models.find(entry => entry.id === options.model)
  const inHistory = model?.systemPromptUpdate === 'in-history'
  const messages: WireMessage[] = []
  let historySystem: string | undefined
  const systemUpdates: WireMessage[] = []
  // Harness admits system updates before user input. Messages places the same
  // update after that user/tool-result turn and before the next assistant.
  const flushSystemUpdates = () => {
    if (systemUpdates.length === 0) return
    if (messages.at(-1)?.role !== 'user') return unsupported('system update without a preceding user or tool-result turn')
    messages.push(...systemUpdates.splice(0))
  }
  let imageIndex = 0
  for (const message of history) {
    if (message.role === 'system') {
      const texts = message.content.filter(block => block.type === 'text')
      if (texts.length !== message.content.length) return unsupported('non-text system message')
      const text = texts.map(block => block.text).join('')
      if (inHistory && messages.length > 0) {
        if (text.length === 0) return unsupported('empty in-history system update')
        systemUpdates.push({ role: 'system', content: [{ type: 'text', text }] })
      } else {
        historySystem = text
      }
      continue
    }
    if (message.role === 'assistant') flushSystemUpdates()
    const content: WireBlock[] = message.role === 'assistant'
      ? assistant(message, options.model, onReplayDegrade)
      : await userBlocks(message.content, images, { message: messages.length + 1, image: ++imageIndex })
    const previous = messages.at(-1)
    if (previous?.role === message.role) previous.content.push(...content)
    else messages.push({ role: message.role, content })
  }
  flushSystemUpdates()
  let pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool_use')
      pending = new Set(calls.map(block => block.id))
      if (pending.size !== calls.length) throw new LlmError('DeepSeek Messages duplicate tool call id', 'INVALID_REQUEST')
    } else if (message.role === 'user') {
      const results = message.content.filter(block => block.type === 'tool_result')
      for (const result of results) {
        if (!pending.delete(result.tool_use_id)) throw new LlmError('DeepSeek Messages tool result has no matching call', 'INVALID_REQUEST')
      }
      if (pending.size > 0) throw new LlmError('DeepSeek Messages tool calls need immediate results', 'INVALID_REQUEST')
      message.content = [...results, ...message.content.filter(block => block.type !== 'tool_result')]
    }
  }
  if (pending.size > 0) throw new LlmError('DeepSeek Messages history ends with unresolved tools', 'INVALID_REQUEST')
  const effort = options.purpose === 'session-title'
    ? 'off'
    : options.reasoningEffort ?? (defaults.reasoningEffort ?? (defaults.thinking === 'disabled' ? 'off' : 'high'))
  if (!['off', 'low', 'high', 'max'].includes(effort) || (defaults.thinking === 'disabled' && effort !== 'off')) {
    throw new LlmError(`DeepSeek Messages does not support reasoning effort ${effort}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  const system = [options.system, historySystem].filter(Boolean).join('\n\n')
  return {
    model: options.model, stream: true, messages,
    max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...effort === 'off' ? {} : { output_config: { effort: effort as 'low' | 'high' | 'max' } },
    ...system.length === 0 ? {} : { system },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
    ...options.tools === undefined ? {} : {
      tools: options.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
    },
  }
}
