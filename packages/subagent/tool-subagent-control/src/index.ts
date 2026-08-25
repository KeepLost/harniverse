/**
 * The globally named `send_message` and `interrupt_agent` tools: thin
 * model-facing adapters over `ctx.subagents.followup()` and
 * `ctx.subagents.interrupt()`. They perform no lifecycle routing of their own —
 * residency, cold resume, and interrupt authorization belong to the subagent
 * service — and they live apart from the provider-bound
 * `@deepseek-ai/dsh-tool-subagent` instances so multiple delegation tools share
 * one control API.
 * @module @deepseek-ai/dsh-tool-subagent-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { paginateRawEventPage } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-persistence'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents']

const MAX_HISTORY_EVENTS = 50

interface SubagentHistoryRequest {
  readonly subagent_id: string
  readonly before_seq?: number
  readonly max_events?: number
}

/** Read one authorized child log without resuming its Agent. */
async function readSubagentHistory(
  ctx: Context,
  parent: { readonly id: SessionId },
  args: SubagentHistoryRequest,
  signal: AbortSignal,
): Promise<string> {
  const childId = SessionId(args.subagent_id)
  const descendants = await ctx.subagents.listDescendants(parent.id, signal)
  if (!descendants.some(entry => entry.id === childId)) {
    throw new Error(`subagent "${childId}" is not a descendant of parent "${parent.id}"`)
  }
  const limit = args.max_events ?? MAX_HISTORY_EVENTS
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_EVENTS) {
    throw new Error(`max_events must be between 1 and ${MAX_HISTORY_EVENTS}`)
  }
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  if (sessions === undefined || persistence === undefined) {
    throw new Error('subagent history requires SessionStore and session persistence')
  }
  const live = sessions.get(childId)
  const before = args.before_seq ?? Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(before) || before < 0) throw new Error('before_seq must be a non-negative safe integer')
  let parentSessionId = live?.header.parentSession
  let page: { readonly events: readonly SessionEvent[]; readonly hasMore: boolean }
  if (live === undefined) {
    const persisted = await persistence.readRawEventPage(childId, { beforeSeq: before, maxEvents: limit }, signal)
    parentSessionId = persisted.meta.parentSession
    page = persisted
  } else {
    page = paginateRawEventPage(live.events, { beforeSeq: before, maxEvents: limit })
  }
  return JSON.stringify({
    subagent_id: childId,
    parent_session_id: parentSessionId,
    events: page.events.map(event => ({
      seq: event.seq,
      time: event.time,
      type: event.type,
      ...Object.hasOwn(event, 'surfaceOp')
        ? { surfaceOp: (event as { readonly surfaceOp?: unknown }).surfaceOp }
        : {},
      data: event.data,
    })),
    has_more: page.hasMore,
    ...page.hasMore ? { next_before_seq: page.events[0]?.seq } : {},
  }, null, 2)
}

/**
 * Register the `send_message` and `interrupt_agent` tools.
 * @param ctx - context carrying the tool registry and subagent service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      'Send a message to a background subagent by its subagent id, continuing the same conversation. It '
      + 'becomes the subagent\'s next turn: if it is still working, the message waits until its current turn '
      + 'finishes, so it cannot redirect work already underway. This call returns no answer from the '
      + 'subagent — only confirmation that the message was delivered — so use it to give it more work. A '
      + 'failure means the message was NOT delivered.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the subagent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message queued as the next turn for subagent ${args.subagent_id}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Parent authority requires an exact live calling agent.
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const messageId = await ctx.subagents.followup(
        parent,
        SessionId(args.subagent_id),
        message,
        {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        },
      )
      return { messageId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'subagent_history',
    description:
      'Read a bounded raw event history from one of your direct or nested subagents without resuming it. '
      + 'The result includes user/assistant messages, tool calls and results, lifecycle records, and sequence '
      + 'numbers. Use before_seq from a prior page to walk older history; only descendants of the calling agent '
      + 'are authorized.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The direct or nested subagent id returned by delegation or list_agents.',
      },
      before_seq: {
        type: 'integer',
        description: 'Read events before this sequence number for older-page traversal.',
      },
      max_events: {
        type: 'integer',
        description: 'Maximum complete raw events to return, from 1 through 50. Defaults to 50.',
      },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => {
      if (!exec.agent) throw new Error('subagent_history requires a calling agent (exec.agent was undefined)')
      return readSubagentHistory(ctx, exec.agent, args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Request cancellation of a background agent\'s current turn by its agent id. The target may be your '
      + 'direct child or a deeper agent created under you. Only the current turn stops: messages already '
      + 'queued for the agent stay parked until a later send_message, agents it started keep running, and '
      + 'the agent itself stays available for follow-ups. This call returns as soon as the stop request is '
      + 'accepted, so the target may keep running briefly; interrupting an agent that already finished is '
      + 'an accepted no-op.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of the running agent to interrupt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent_id}`,
      }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // Ancestor authority requires an exact live calling agent.
        throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      }
      // The service authorizes the exact live caller against the target's
      // recorded lineage; the tool adds no authority of its own.
      ctx.subagents.interrupt(SessionId(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
