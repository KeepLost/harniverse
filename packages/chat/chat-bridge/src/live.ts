/**
 * In-memory session model. Durable facts live in the storage domain; this
 * module holds what the running bridge tracks per registered session: the
 * active turn, prompts awaiting their `user/message` event, and tool calls.
 * @module @deepseek-ai/dsh-chat-bridge/live
 */

import type { ChatRoute } from '@deepseek-ai/dsh-chat-adapter'
import type { EditableStream } from './render.ts'
import type { BridgeSessionRecord } from './state.ts'

/** Where a prompt came from and where its reply goes. */
export interface Origin {
  /** `rpcId` of the `session.prompt` request, echoed by the `user/message` source. */
  rpcId: string
  /** `platform:userId` of the sender. */
  actorKey: string
  label: string
  platform: string
  botId: string
  route: ChatRoute
  mode: 'queue' | 'steer'
  /** First characters of the prompt, for `/queue`. */
  preview: string
  /** Inbox id, known once `session.prompt` answered. */
  messageId?: string
}

/** The turn a session is currently running. */
export interface Turn {
  number: number
  /** The first IM prompt claimed into the turn; absent for turns started elsewhere. */
  origin?: Origin
  /** Assistant text so far across steps. */
  text: string
  /** Insert a paragraph break before the next text, after a step boundary. */
  separate: boolean
  /** Name of the tool currently running. */
  tool?: string
  stream?: EditableStream
  /** Final-only delivery: the platform cannot edit messages. */
  plain: boolean
}

/** Runtime view of one bridge session. */
export interface LiveSession {
  record: BridgeSessionRecord
  /** Highest session event `seq` applied. */
  applied?: number
  turn?: Turn
  /** Prompts sent and not yet claimed into a turn, by request `rpcId`. */
  prompts: Map<string, Origin>
  /** Tool calls seen and not yet resulted, by call id. */
  toolCalls: Map<string, { name: string; arguments: string }>
}

/**
 * Wrap a durable record as a live session.
 * @param record - the stored session.
 * @returns a session with no turn and no pending prompts.
 */
export function liveSession(record: BridgeSessionRecord): LiveSession {
  return { record, prompts: new Map(), toolCalls: new Map() }
}

/**
 * The chat route a session was created in.
 * @param record - the stored session.
 * @returns the route with an absent thread left absent.
 */
export function routeOf(record: BridgeSessionRecord): ChatRoute {
  const { kind, chatId, threadId } = record.route
  return threadId === undefined ? { kind, chatId } : { kind, chatId, threadId }
}
