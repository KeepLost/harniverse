/** Model-facing adapter for ordinary-session message delivery. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-delivery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-session-delivery'
export const inject = ['tools', 'sessionDelivery']

/** Register ordinary-session delivery and safe unload tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'session_send_message',
    description: 'Send a message to another ordinary session as its next FIFO turn. Returns after inbox acceptance and does not wait for a reply or turn completion.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Target ordinary session id.' },
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
      if (exec.agent === undefined) throw new Error('session_send_message requires a calling agent')
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
