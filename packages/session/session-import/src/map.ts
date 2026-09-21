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
import type { SessionEvent, SessionEventType, SessionEventMap, SurfaceOp } from '@deepseek-ai/dsh-session'
import { ForeignLogError } from './foreign.ts'
import type { ForeignRawEvent, ForeignSessionLog } from './foreign.ts'

/** One mapped event before sequence numbers are assigned densely. */
export type PendingImportEvent = {
  [K in SessionEventType]: { type: K; time: number; data: SessionEventMap[K] } & { surfaceOp?: SurfaceOp; sourceEventSeqs?: number[] }
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
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
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
    if (block.type === 'tool-call' && typeof block.id === 'string'
      && typeof block.name === 'string' && typeof block.arguments === 'string') {
      mapped.push({ type: 'tool-call', id: CallId(block.id), name: block.name, arguments: block.arguments })
      continue
    }
    mapped.push({ type: 'text', text: `[imported ${typeof block.type === 'string' ? block.type : 'unknown'} block omitted]` })
  }
  return mapped
}

function mapUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.inputTokens !== 'number' || !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0
    || typeof value.outputTokens !== 'number' || !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0) return undefined
  const usage: TokenUsage = { inputTokens: value.inputTokens, outputTokens: value.outputTokens }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const entry = value[key]
    if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) usage[key] = entry
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
      if (kind === 'error' && isRecord(reason?.error) && typeof reason.error.message === 'string'
        && typeof reason.error.code === 'string') {
        return { type: 'turn/end', time, data: { turn, reason: { kind: 'error', error: { message: reason.error.message, code: reason.error.code } } } }
      }
      if (kind === 'aborted') {
        return { type: 'turn/end', time, data: { turn, reason: isRecord(reason?.reason) && reason.reason.kind === 'user'
          ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'interrupted' } } }
      }
      if (typeof kind !== 'string') return undefined
      if (!SIMPLE_TURN_END_REASONS.has(kind)) {
        return { type: 'turn/end', time, data: { turn, reason: { kind: 'interrupted' } } }
      }
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
    data: createUserMessage({ content: mapBlocks(message.content), source:
      isRecord(message.source) && message.source.kind === 'user' ? { kind: 'user' }
        : { kind: 'plugin', plugin: isRecord(message.source) && typeof message.source.plugin === 'string'
          ? message.source.plugin : '@deepseek-ai/dsh-session-import' } }),
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
  const source = isRecord(message.source) ? message.source : undefined
  const block = Array.isArray(message.content) && message.content.length === 1 && isRecord(message.content[0])
    ? message.content[0] : undefined
  if (source?.kind !== 'tool' || typeof source.callId !== 'string' || block?.type !== 'tool-result'
    || block.toolCallId !== source.callId || !Array.isArray(block.content)) return undefined
  const error = block.isError === true && isRecord(data.error) && typeof data.error.name === 'string' && typeof data.error.code === 'string'
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
        callId: CallId(source.callId),
        content: mapBlocks(block.content),
        isError: block.isError === true,
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
  let turn: number | undefined
  let step: number | undefined
  let nextTurn = 1
  let nextStep = 1
  const surface: Array<{ foreign: number; local: number }> = []
  const identities = new Map<string, ReturnType<typeof createUserMessage>['id']>()
  const closeStep = (time: number) => {
    if (turn !== undefined && step !== undefined) events.push({ type: 'step/end', time, data: { turn, step } })
    step = undefined
  }
  const closeTurn = (time: number) => {
    closeStep(time)
    if (turn !== undefined) events.push({ type: 'turn/end', time, data: { turn, reason: { kind: 'interrupted' } } })
    turn = undefined
  }
  for (const raw of log.events) {
    const time = eventTime(raw.time, defaultTime)
    if (['user/message', 'assistant/message', 'tool/result'].includes(String(raw.type))) {
      const data = isRecord(raw.data) ? raw.data : {}
      const message = raw.type === 'user/message' ? data : isRecord(data.message) ? data.message : {}
      if (typeof message.id !== 'string' || message.id.length === 0 || !Array.isArray(message.content)
        || message.role !== (raw.type === 'assistant/message' ? 'assistant' : 'user') || !isRecord(message.source)) {
        throw new ForeignLogError(`invalid foreign message at ${raw.seq}`)
      }
    }
    const mapped = MAPPERS.some((mapper) => {
      const event = mapper(raw, time)
      if (event === undefined) return false
      if (event.type === 'turn/start') {
        closeTurn(time)
        turn = event.data.turn
        if (turn !== nextTurn++) throw new ForeignLogError('foreign turn counters are not contiguous')
        nextStep = 1
      } else if (event.type === 'step/start') {
        if (turn !== event.data.turn || step !== undefined || event.data.step !== nextStep++) {
          throw new ForeignLogError('foreign step boundaries are inconsistent')
        }
        step = event.data.step
      } else if (event.type === 'step/end') {
        if (turn !== event.data.turn || step !== event.data.step) throw new ForeignLogError('foreign step/end has no matching start')
        step = undefined
      } else if (event.type === 'turn/end') {
        if (turn !== event.data.turn) throw new ForeignLogError('foreign turn/end has no matching start')
        closeStep(time)
        turn = undefined
      } else if (event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result') {
        if (turn !== event.data.turn || (raw.surfaceOp === 'append' || raw.surfaceOp === undefined) && step !== event.data.step) {
          throw new ForeignLogError('foreign execution event is outside its turn/step')
        }
      }
      if (event.surfaceOp !== undefined) {
        const payload = isRecord(raw.data) ? raw.data : {}
        const original = raw.type === 'user/message' ? payload : isRecord(payload.message) ? payload.message : {}
        const message = event.type === 'user/message' ? event.data
          : event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message : undefined
        if (message !== undefined && typeof original.id === 'string') {
          const id = identities.get(original.id) ?? message.id
          identities.set(original.id, id)
          // Factories freeze messages; preserve identities across content rewrites.
          if (event.type === 'user/message') event.data = { ...event.data, id }
          else if (event.type === 'assistant/message') event.data = { ...event.data, message: { ...event.data.message, id } }
          else if (event.type === 'tool/result') event.data = { ...event.data, message: { ...event.data.message, id } }
        }
        const op = raw.surfaceOp
        if (op !== undefined && op !== 'append') {
          const replaced = surface.filter(node => node.foreign >= op.start && node.foreign <= op.end)
          if (replaced.length > 0) {
            // oxlint-disable-next-line typescript/no-non-null-assertion -- the nonempty replacement has both endpoints
            event.surfaceOp = { op: 'replace', start: replaced[0]!.local, end: replaced.at(-1)!.local }
            event.sourceEventSeqs = replaced.map(node => node.local)
            // oxlint-disable-next-line typescript/no-non-null-assertion -- the nonempty replacement starts at a retained surface node
            const start = surface.indexOf(replaced[0]!)
            surface.splice(start, replaced.length, { foreign: raw.seq, local: events.length + 1 })
          } else surface.push({ foreign: raw.seq, local: events.length + 1 })
        } else surface.push({ foreign: raw.seq, local: events.length + 1 })
      }
      events.push(event)
      return true
    })
    if (!mapped) {
      if (PLACEHOLDER_TYPES.has(String(raw.type)) || ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(String(raw.type))) {
        throw new ForeignLogError(`malformed supported foreign event ${String(raw.type)} at ${raw.seq}`)
      }
      skipped += 1
    }
  }
  closeTurn(events.at(-1)?.time ?? defaultTime)
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
  return [marker, ...mapped].map((event, seq) => ({ ...event, seq })) as SessionEvent[]
}
