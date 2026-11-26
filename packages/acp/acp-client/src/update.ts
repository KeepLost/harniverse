/**
 * Normalization of raw `session/update` notifications onto the version-neutral
 * {@link AcpUpdate} vocabulary. Both protocol versions share this one
 * normalizer: a variant keeps its wire shape across versions except where the
 * discriminating `sessionUpdate` value differs.
 * @module @deepseek-ai/dsh-acp-client/update
 */

import type {
  AcpContentBlock,
  AcpPlanEntry,
  AcpStopReason,
  AcpToolCallPatch,
  AcpUpdate,
  AcpWorkState,
} from './types.ts'

/** A raw JSON object read off the wire. */
export type RawRecord = Readonly<Record<string, unknown>>

/** One `session/update` notification after its envelope was read. */
export interface SessionUpdateEnvelope {
  readonly sessionId: string
  readonly update: AcpUpdate
}

const STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error',
])

const WORK_STATES: ReadonlySet<string> = new Set(['running', 'idle', 'requires_action'])

/**
 * Whether `value` is a JSON object rather than an array, a scalar, or absent.
 * @param value - a value read off the wire.
 * @returns whether it is a raw JSON object.
 */
export function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a recognized stop reason; anything else, including an absent one, is `unknown`.
 * @param value - the stop reason the agent wrote.
 * @returns the normalized stop reason.
 */
export function toStopReason(value: unknown): AcpStopReason {
  return typeof value === 'string' && STOP_REASONS.has(value) ? value as AcpStopReason : 'unknown'
}

/**
 * Read a recognized work state; anything else is `unknown`.
 * @param value - the state the agent wrote.
 * @returns the normalized work state.
 */
export function toWorkState(value: unknown): AcpWorkState {
  return typeof value === 'string' && WORK_STATES.has(value) ? value as AcpWorkState : 'unknown'
}

/** Read content blocks; `undefined` when the value is not an array of typed objects. */
function contentBlocks(value: unknown): AcpContentBlock[] | undefined {
  if (!Array.isArray(value)) return undefined
  const blocks: AcpContentBlock[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== 'string') return undefined
    blocks.push({ ...item, type: item.type })
  }
  return blocks
}

/** Read a nullable string field; an absent field stays absent. */
function nullableText(raw: RawRecord, field: string): { readonly value?: string | null } {
  const value = raw[field]
  if (value === null) return { value: null }
  const read = text(value)
  return read === undefined ? {} : { value: read }
}

function toolCallPatch(raw: RawRecord, initial: boolean): AcpToolCallPatch | undefined {
  const toolCallId = text(raw.toolCallId)
  if (toolCallId === undefined) return undefined
  const title = nullableText(raw, 'title').value
  const name = nullableText(raw, 'name').value
  const kind = nullableText(raw, 'kind').value
  const status = text(raw.status)
  const content = raw.content === null ? null : contentBlocks(raw.content)
  const locations = raw.locations === null ? null : Array.isArray(raw.locations) ? raw.locations : undefined
  if (raw.content !== null && raw.content !== undefined && content === undefined) return undefined
  return {
    toolCallId,
    ...title === undefined ? {} : { title },
    ...name === undefined ? {} : { name },
    ...kind === undefined ? {} : { kind },
    ...status === undefined ? {} : { status },
    ...content === undefined ? {} : { content },
    ...locations === undefined ? {} : { locations },
    ...raw.rawInput === undefined ? {} : { rawInput: raw.rawInput },
    ...raw.rawOutput === undefined ? {} : { rawOutput: raw.rawOutput },
    // The initial `tool_call` variant carries no status until the agent reports one.
    ...initial && status === undefined ? { status: 'pending' } : {},
  }
}

function planEntries(raw: RawRecord): AcpPlanEntry[] | undefined {
  const value = raw.entries
  if (!Array.isArray(value)) return undefined
  const entries: AcpPlanEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const content = text(item.content)
    if (content === undefined) return undefined
    const priority = text(item.priority)
    const status = text(item.status)
    entries.push({
      content,
      ...priority === undefined ? {} : { priority },
      ...status === undefined ? {} : { status },
    })
  }
  return entries
}

function wholeMessage(raw: RawRecord): AcpContentBlock[] | undefined {
  return contentBlocks(raw.content)
}

/**
 * Map one raw update onto the normalized vocabulary.
 * @param raw - the `update` object of a `session/update` notification.
 * @returns the normalized update; `other` for a variant this client does not
 *   interpret and for a known variant whose fields do not match its contract.
 */
export function normalizeUpdate(raw: RawRecord): AcpUpdate {
  const other: AcpUpdate = { kind: 'other', sessionUpdate: String(raw.sessionUpdate), update: raw }
  const content = raw.content
  switch (raw.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return isRecord(content) && typeof content.type === 'string'
        ? {
          kind: raw.sessionUpdate === 'agent_message_chunk' ? 'message-chunk' : 'thought-chunk',
          content: { ...content, type: content.type },
        }
        : other
    case 'agent_message':
    case 'agent_thought': {
      const blocks = wholeMessage(raw)
      return blocks === undefined ? other : { kind: raw.sessionUpdate === 'agent_message' ? 'message' : 'thought', content: blocks }
    }
    case 'tool_call':
    case 'tool_call_update': {
      const patch = toolCallPatch(raw, raw.sessionUpdate === 'tool_call')
      return patch === undefined ? other : { kind: 'tool-call', patch }
    }
    case 'plan': {
      const entries = planEntries(raw)
      return entries === undefined ? other : { kind: 'plan', entries }
    }
    case 'usage_update': {
      const used = typeof raw.used === 'number' ? raw.used : undefined
      const size = typeof raw.size === 'number' ? raw.size : undefined
      if (used === undefined && size === undefined) return other
      return {
        kind: 'usage',
        usage: {
          ...used === undefined ? {} : { used },
          ...size === undefined ? {} : { size },
          ...raw.cost === undefined ? {} : { cost: raw.cost },
        },
      }
    }
    case 'session_info_update': {
      const title = nullableText(raw, 'title').value
      const updatedAt = nullableText(raw, 'updatedAt').value
      return {
        kind: 'session-info',
        ...title === undefined || title === null ? {} : { title },
        ...updatedAt === undefined || updatedAt === null ? {} : { updatedAt },
      }
    }
    case 'notice': {
      const title = text(raw.title)
      if (title === undefined) return other
      const message = nullableText(raw, 'description').value
      const severity = text(raw.severity)
      return {
        kind: 'notice',
        title,
        ...message === undefined || message === null ? {} : { message },
        ...severity === undefined ? {} : { severity },
      }
    }
    case 'state_update': {
      const error = isRecord(raw.error) ? text(raw.error.message) : undefined
      return {
        kind: 'state',
        state: toWorkState(raw.state),
        ...raw.stopReason === undefined || raw.stopReason === null ? {} : { stopReason: toStopReason(raw.stopReason) },
        ...error === undefined ? {} : { error },
      }
    }
    default:
      return other
  }
}

/**
 * Read one raw `session/update` params object.
 * @param params - the notification params off the wire.
 * @returns the session the update belongs to and the normalized update, or
 *   `undefined` when the envelope is malformed.
 */
export function parseSessionUpdate(params: unknown): SessionUpdateEnvelope | undefined {
  if (!isRecord(params) || typeof params.sessionId !== 'string') return undefined
  const raw = params.update
  if (!isRecord(raw) || typeof raw.sessionUpdate !== 'string') return undefined
  return { sessionId: params.sessionId, update: normalizeUpdate(raw) }
}
