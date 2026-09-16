/**
 * The model-facing queue tools: a separately loadable Consumer over the
 * queue service so preset compositions decide per agent whether the queue
 * is model-visible, while the service itself stays on the host plane.
 * Four tools with a hard boundary: `queue-topic` manages and inspects
 * topics (including the subscriber relation in both directions),
 * `queue-history` is the past-tense cursor-free read, `queue-subscription`
 * is the only subscription writer and only ever binds the CALLING session
 * to existing topics, and `queue-publish` appends. Subscribed sessions
 * receive new messages as injected context automatically — there is no
 * pull verb on purpose.
 * @module @deepseek-ai/dsh-queue/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import QueueService from './index.ts'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'

export const name = 'queue-tools'
export const inject = ['queue', 'tools']

/** Deployment config of the queue tools; they have no options of their own. */
export interface Config {}

export function apply(ctx: Context, _config: Config = {}): void {
  const queue: QueueService = ctx.queue
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'queue-topic',
    description: 'Manage and inspect message-queue topics. action=list returns every topic with live/archived counts, subscriber counts, and offset bounds. action=inspect takes either topic (all subscribers of one topic, with their cursors) or session (all topics one session subscribes to; "current" selects YOUR session). action=delete silently removes a topic with all its messages and subscriptions — subscribers are NOT notified; publish a sentinel message first if they must learn of it.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'inspect', 'delete'], description: 'list topics, inspect the subscription relation (by topic or by session), or delete a topic.' },
      topic: { type: 'string', description: 'Topic name; required for inspect-by-topic and delete.' },
      session: { type: 'string', description: 'Session id for inspect-by-session; the literal "current" resolves to YOUR session.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          kind: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.kind}${value.detail === undefined ? '' : `: ${value.detail}`}` }],
    },
    execute: async (args: { action: string; topic?: string; session?: string }, exec: ToolExecution) => {
      if (args.action === 'list') {
        return { kind: 'topics', detail: JSON.stringify(queue.topicList()) }
      }
      if (args.action === 'inspect') {
        if (args.topic !== undefined) {
          const stats = queue.stats(args.topic)
          const rows = queue.subscriptions(args.topic, null)
          return { kind: 'topic-subscribers', detail: JSON.stringify({ topic: stats.topic, subscribers: rows }) }
        }
        const sessionId = args.session === 'current' || args.session === undefined
          ? requireSelf(exec).session.id
          : args.session
        return { kind: 'session-topics', detail: JSON.stringify({ sessionId, subscriptions: queue.subscriptions(null, sessionId) }) }
      }
      if (args.topic === undefined) throw new Error('queue-topic delete requires topic')
      await queue.topicDelete(args.topic)
      return { kind: 'deleted', topic: args.topic }
    },
  })), 'queue: queue-topic tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'queue-history',
    description: 'Read one message-queue topic\'s message history — the past-tense, cursor-free view. Covers live messages by default and forced-archived ones with includeArchived; it never touches any subscription cursor and needs no subscription.',
    parameters: {
      topic: { type: 'string', required: true, description: 'Topic name.' },
      fromOffset: { type: 'number', description: 'First offset to include (default 0, the beginning).' },
      limit: { type: 'number', description: 'Maximum messages to return (default 100).' },
      includeArchived: { type: 'boolean', description: 'Include messages past their lifecycle deadline (default false).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          kind: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.kind}${value.detail === undefined ? '' : `: ${value.detail}`}` }],
    },
    execute: async (args: { topic: string; fromOffset?: number; limit?: number; includeArchived?: boolean }) => {
      const messages = queue.messages(args.topic, args.fromOffset ?? 0, args.limit ?? 100, args.includeArchived ?? false)
      return { kind: 'history', detail: JSON.stringify({ topic: args.topic, messages }) }
    },
  })), 'queue: queue-history tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'queue-subscription',
    description: 'Subscribe or unsubscribe YOUR session to/from an existing topic. Subscribing means every NEW message on that topic is injected into your context automatically (idle sessions wake to process it; archived messages are never delivered and missed messages stay missed). History before your subscription is NOT replayed — use queue-history for the past. This tool only ever changes YOUR session\'s relation; to view others\' subscriptions use queue-topic inspect.',
    parameters: {
      action: { type: 'string', required: true, enum: ['subscribe', 'unsubscribe'], description: 'Bind or dissolve YOUR session\'s subscription.' },
      topic: { type: 'string', required: true, description: 'Existing topic name.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          kind: { type: 'string', required: true },
          topic: { type: 'string' },
          cursor: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'subscribed'
          ? `subscribed to ${value.topic ?? ''} (cursor ${String(value.cursor ?? 0)}; new messages arrive automatically)`
          : `unsubscribed from ${value.topic ?? ''}`,
      }],
    },
    execute: async (args: { action: string; topic: string }, exec: ToolExecution) => {
      const sessionId = requireSelf(exec).session.id
      if (args.action === 'subscribe') {
        const row = await queue.subscribe(sessionId, args.topic)
        return { kind: 'subscribed', topic: args.topic, cursor: row.cursor }
      }
      await queue.unsubscribe(sessionId, args.topic)
      return { kind: 'unsubscribed', topic: args.topic }
    },
  })), 'queue: queue-subscription tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'queue-publish',
    description: 'Append one JSON message to a topic (created with defaults when absent) and fan it out to every subscriber. Returns the assigned offset. The payload reaches subscribed sessions as injected context; keep it within 256 KiB.',
    parameters: {
      topic: { type: 'string', required: true, description: 'Topic name.' },
      payload: { type: 'object', required: true, additionalProperties: true, description: 'The JSON payload to append.' },
      ttlMs: { type: 'number', description: 'Optional per-message lifecycle override in ms; after it elapses the message is force-archived and never delivered.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          kind: { type: 'string', required: true },
          topic: { type: 'string' },
          offset: { type: 'number' },
          expiresAt: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `published #${String(value.offset ?? 0)} to ${value.topic ?? ''}; expires at ${String(value.expiresAt ?? 0)}`,
      }],
    },
    execute: async (args: { topic: string; payload: JsonValue; ttlMs?: number }, exec: ToolExecution) => {
      const publisher = exec.agent?.session.id ?? 'tool'
      const message = await queue.publish(args.topic, args.payload, {}, args.ttlMs ?? null, publisher)
      return { kind: 'published', topic: args.topic, offset: message.offset, expiresAt: message.expiresAt }
    },
  })), 'queue: queue-publish tool')
}

/** Resolve the calling agent or fail loudly — three of the four tools are session-bound. */
function requireSelf(exec: ToolExecution): NonNullable<ToolExecution['agent']> {
  const agent = exec.agent
  if (agent === undefined) throw new Error('queue tools require a session context')
  return agent
}
