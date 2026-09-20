/**
 * Lossy foreign-event mapping into current native session events. Only the
 * display-bearing vocabulary maps — user and assistant messages, tool calls
 * and results, and the turn/step markers whose payloads are shape-identical.
 * Everything else is skipped and counted; mapped messages carry fresh local
 * identities and truthful placeholders for unsupported blocks.
 *
 * @module @deepseek-ai/dsh-session-import
 */

import { CallId, createAssistantMessage, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventType, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ForeignRawEvent, ForeignSessionLog } from './foreign.ts'

/** One mapped event before sequence numbers are assigned densely. */
export type PendingImportEvent = {
  [K in SessionEventType]: { type: K; time: number; data: SessionEventMap[K] } & { surfaceOp?: 'append' }
}[SessionEventType]

/** The lossy result of mapping one foreign log. */
export interface ForeignMapping {
  /** Mapped events in foreign order, without sequence numbers. */
  readonly events: readonly PendingImportEvent[]
  /** Foreign events that mapped to nothing. */
  readonly skipped: number
}

const PLACEHOLDER_TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'step/end'])
const SIMPLE_TURN_END_REASONS = new Set(['completed', 'blocked', 'max-tokens', 'interrupted'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeTurn(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function eventTime(time: unknown, fallback: number): number {
  return typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 ? time : fallback
}

/** Rebuild one foreign content-block list with local identities. */
function mapBlocks(blocks: unknown): ContentBlock[] {
  if (!Array.isArray(blocks)) return [{ type: 'text', text: '[imported malformed content omitted]' }]
  const mapped: ContentBlock[] = []
  for (const block of blocks) {
    if (!isRecord(block)) {
      mapped.push({ type: 'text', text: '[imported malformed block omitted]' })
      continue
    }
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      mapped.push({ type: block.type, text: block.text })
      continue
    }
    if (block.type === 'tool-result' && typeof block.toolCallId === 'string') {
      mapped.push({
        type: 'tool-result',
        toolCallId: CallId(block.toolCallId),
        content: mapBlocks(block.content),
        ...block.isError === true ? { isError: true } : {},
      })
      continue
    }
    mapped.push({ type: 'text', text: `[imported ${typeof block.type === 'string' ? block.type : 'unknown'} block omitted]` })
  }
  return mapped
}

function mapUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.inputTokens !== 'number' || typeof value.outputTokens !== 'number') return undefined
  const usage: TokenUsage = { inputTokens: value.inputTokens, outputTokens: value.outputTokens }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const entry = value[key]
    if (typeof entry === 'number') usage[key] = entry
  }
  return usage
}

function mapMarkerEvent(raw: ForeignRawEvent, time: number): PendingImportEvent | undefined {
  if (typeof raw.type !== 'string' || !PLACEHOLDER_TYPES.has(raw.type)) return undefined
  const data = isRecord(raw.data) ? raw.data : {}
  const turn = safeTurn(data.turn)
  if (turn === undefined) return undefined
  if (raw.type === 'turn/start' || raw.type === 'turn/end') {
    if (raw.type === 'turn/end') {
      const reason = isRecord(data.reason) ? data.reason : undefined
      const kind = reason?.kind
      if (typeof kind !== 'string' || !SIMPLE_TURN_END_REASONS.has(kind)) return undefined
      return { type: 'turn/end', time, data: { turn, reason: { kind: kind as 'completed' | 'blocked' | 'max-tokens' | 'interrupted' } } }
    }
    return { type: 'turn/start', time, data: { turn } }
  }
  const step = safeTurn(data.step)
  if (step === undefined) return undefined
  return raw.type === 'step/start'
    ? { type: 'step/start', time, data: { turn, step } }
    : { type: 'step/end', time, data: { turn, step } }
}

function mapUserMessage(raw: ForeignRawEvent, time: number): PendingImportEvent | undefined {
  if (raw.type !== 'user/message') return undefined
  const message = isRecord(raw.data) ? raw.data : undefined
  if (message === undefined || !Array.isArray(message.content)) return undefined
  return {
    type: 'user/message',
    time,
    surfaceOp: 'append',
    data: createUserMessage({ content: mapBlocks(message.content), source: { kind: 'user' } }),
  }
}

function mapAssistantMessage(raw: ForeignRawEvent, time: number): PendingImportEvent | undefined {
  if (raw.type !== 'assistant/message') return undefined
  const data = isRecord(raw.data) ? raw.data : undefined
  const message = data !== undefined && isRecord(data.message) ? data.message : undefined
  if (data === undefined || message === undefined || !Array.isArray(message.content)) return undefined
  const turn = safeTurn(data.turn)
  const step = safeTurn(data.step)
  if (turn === undefined || step === undefined) return undefined
  const usage = mapUsage(data.usage)
  const provenance = isRecord(message.source) ? message.source : {}
  return {
    type: 'assistant/message',
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: createAssistantMessage({
        content: mapBlocks(message.content),
        source: {
          provider: typeof provenance.provider === 'string' ? provenance.provider
            : typeof message.provider === 'string' ? message.provider : 'unknown',
          model: typeof provenance.model === 'string' ? provenance.model
            : typeof message.model === 'string' ? message.model : 'unknown',
        },
      }),
      ...usage === undefined ? {} : { usage },
      ...data.interrupted === true ? { interrupted: true } : {},
    },
  }
}

function mapToolCall(raw: ForeignRawEvent, time: number): PendingImportEvent | undefined {
  if (raw.type !== 'tool/call') return undefined
  const data = isRecord(raw.data) ? raw.data : undefined
  if (data === undefined) return undefined
  const turn = safeTurn(data.turn)
  const step = safeTurn(data.step)
  if (turn === undefined || step === undefined) return undefined
  if (typeof data.callId !== 'string' || typeof data.name !== 'string' || typeof data.arguments !== 'string') return undefined
  return {
    type: 'tool/call',
    time,
    data: { turn, step, callId: CallId(data.callId), name: data.name, arguments: data.arguments },
  }
}

function mapToolResult(raw: ForeignRawEvent, time: number): PendingImportEvent | undefined {
  if (raw.type !== 'tool/result') return undefined
  const data = isRecord(raw.data) ? raw.data : undefined
  const message = data !== undefined && isRecord(data.message) ? data.message : undefined
  if (data === undefined || message === undefined) return undefined
  const turn = safeTurn(data.turn)
  const step = safeTurn(data.step)
  if (turn === undefined || step === undefined) return undefined
  if (typeof message.callId !== 'string' || !Array.isArray(message.content)) return undefined
  const error = isRecord(data.error) && typeof data.error.name === 'string' && typeof data.error.code === 'string'
    ? { name: data.error.name, code: data.error.code }
    : undefined
  return {
    type: 'tool/result',
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: createToolResultMessage({
        callId: CallId(message.callId),
        content: mapBlocks(message.content),
        isError: message.isError === true,
      }),
      ...error === undefined ? {} : { error },
    },
  }
}

const MAPPERS = [mapMarkerEvent, mapUserMessage, mapAssistantMessage, mapToolCall, mapToolResult]

/**
 * Map one parsed foreign log lossily into native pending events.
 * @param log - the parsed foreign log.
 * @param defaultTime - timestamp used when a foreign event carries no safe time.
 * @returns the mapped events plus the count of foreign events that mapped to nothing.
 */
export function mapForeignSessionEvents(log: ForeignSessionLog, defaultTime: number): ForeignMapping {
  const events: PendingImportEvent[] = []
  let skipped = 0
  for (const raw of log.events) {
    const time = eventTime(raw.time, defaultTime)
    const mapped = MAPPERS.some((mapper) => {
      const event = mapper(raw, time)
      if (event === undefined) return false
      events.push(event)
      return true
    })
    if (!mapped) skipped += 1
  }
  return { events, skipped }
}

/**
 * Assign dense sequence numbers to the marker plus mapped events.
 * @param marker - the archival marker that opens the imported log.
 * @param mapped - the mapped foreign events, in foreign order.
 * @returns the complete imported event log with contiguous sequence numbers.
 */
export function scheduleImportEvents(
  marker: PendingImportEvent,
  mapped: readonly PendingImportEvent[],
): SessionEvent[] {
  return [marker, ...mapped].map((event, seq) => ({ ...event, seq }))
}
