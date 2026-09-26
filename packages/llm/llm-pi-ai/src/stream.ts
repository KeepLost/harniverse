/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { FinishReason, ReasoningBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts; cache fields appear only when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Build the durable reasoning block for one streamed thinking item, lifting
 * the provider's replay metadata off the final message when pi-ai stored it.
 *
 * pi-ai keeps the complete OpenAI Responses reasoning item (including
 * `encrypted_content` and its item `id`) in the thinking block's
 * `thinkingSignature`; a block that carries an encrypted payload renders its
 * text as the provider's summary of the withheld chain.
 * @param index - the block's stream index, matching the final message's content order.
 * @param text - the streamed thinking text.
 * @param message - the terminal pi-ai assistant message.
 * @returns the Harness reasoning block with optional replay fields.
 */
function reasoningBlock(index: number, text: string, message: AssistantMessage): ReasoningBlock {
  const block = message.content[index]
  const signature = block?.type === 'thinking' ? block.thinkingSignature : undefined
  if (signature === undefined) return { type: 'reasoning', text }
  let item: { id?: unknown; encrypted_content?: unknown }
  try {
    item = JSON.parse(signature) as { id?: unknown; encrypted_content?: unknown }
  } catch {
    // A provider signature this build cannot parse stays opaque; the envelope
    // still replays it verbatim.
    return { type: 'reasoning', text }
  }
  const itemId = typeof item.id === 'string' ? item.id : undefined
  const encrypted = typeof item.encrypted_content === 'string' ? item.encrypted_content : undefined
  return {
    type: 'reasoning',
    text,
    ...(encrypted !== undefined ? { summary: true } : {}),
    ...itemId === undefined ? {} : { itemId },
    ...encrypted === undefined ? {} : { encrypted },
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()
  // Thinking blocks close only at `done`: the provider's reasoning item
  // metadata (item id, encrypted payload) lands on the final message's
  // blocks, and emitting block-end with it keeps the durable assistant
  // message replayable without a second correction pass.
  const openThinking = new Map<number, string>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        openThinking.set(event.contentIndex, event.content)
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: CallId(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: CallId(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        for (const [index, text] of openThinking) {
          yield { type: 'block-end', index, block: reasoningBlock(index, text, event.message) }
        }
        openThinking.clear()
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message),
        }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        // Open thinking blocks assemble from their accumulated deltas.
        openThinking.clear()
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
