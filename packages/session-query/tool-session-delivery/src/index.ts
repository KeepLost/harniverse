/** Model-facing adapter for ordinary-session and direct-child message delivery. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-delivery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-session-delivery'
export const inject = ['tools', 'sessionDelivery']

/** Register session creation, unified delivery, and safe unload tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'session_message',
    description: 'Send a message to another ordinary session or a direct subagent session as its next FIFO turn. Returns after inbox acceptance and does not wait for a reply or turn completion.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target ordinary session or direct subagent session id.' },
      message: { type: 'string', required: true, description: 'Message to deliver.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Message accepted as a later turn for session ${args.session_id} with message id ${value.messageId}. This confirms delivery only, not completion or a reply.`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('session_message requires a calling agent')
      const content: ContentBlock[] = [{ type: 'text', text: args.message }]
      return ctx.sessionDelivery.deliver({
        sender: exec.agent,
        targetSessionId: SessionId(args.session_id),
        content,
        signal: exec.signal,
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'session_create',
    description: 'Create a new persistent ordinary session in the current workspace. This only creates the session and does not send an initial message; use session_message with the returned sessionId to start its first turn. The session is returned after its Agent Profile and model configuration are durably attached.',
    parameters: {
      agent_profile_id: { type: 'string', description: 'Optional ordinary Agent Profile id. This is not a Child Profile id. The host resolves and validates it before publication.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          agentProfile: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Created persistent session ${value.sessionId}${value.agentProfile === undefined ? '' : ` with Profile ${value.agentProfile}`}.` }],
    },
    async execute(args, exec) {
      if ('profile_id' in args) throw new Error('profile_id was removed; use agent_profile_id')
      if (exec.agent === undefined) throw new Error('session_create requires a calling agent')
      return ctx.sessionDelivery.create({
        sender: exec.agent,
        ...(args.agent_profile_id === undefined ? {} : { profileId: args.agent_profile_id }),
        signal: exec.signal,
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'session_unload',
    description: 'Unload another idle ordinary session. Refuses running, queued, subagent-owned, or runtime-owned sessions so work is not interrupted.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target ordinary session id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          unloaded: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.unloaded
          ? `Session ${args.session_id} was unloaded.`
          : `Session ${args.session_id} was already unloaded.`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('session_unload requires a calling agent')
      return ctx.sessionDelivery.unload({
        sender: exec.agent,
        targetSessionId: SessionId(args.session_id),
        signal: exec.signal,
      })
    },
  }))
}
