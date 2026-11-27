/**
 * Wire shapes of ACP v2, the Preview protocol. v2 acknowledges `session/prompt`
 * once the message is inserted and reports the end of foreground work through
 * an idle `state_update`; resume, list, and close are owed without an
 * advertisement.
 * @module @deepseek-ai/dsh-acp-client/v2
 */

import type { ProtocolShape } from './binding.ts'
import { isRecord } from './update.ts'
import { readOptions } from './v1.ts'

/** The v2 shapes. */
export const V2: ProtocolShape = {
  version: 2,
  authenticate: 'auth/login',
  completion: 'idle-state',
  initialize: (client, capabilities) => ({
    protocolVersion: 2,
    capabilities: {
      ...capabilities.elicitation ? { elicitation: { form: {} } } : {},
      ...capabilities.terminalAuth ? { auth: { terminal: {} } } : {},
    },
    info: { name: client.name, version: client.version },
  }),
  newSession: cwd => ({ cwd }),
  configValue: value => typeof value === 'boolean' ? { type: 'boolean', value } : { type: 'id', value },
  resume: (_response, sessionId, cwd) => ({ method: 'session/resume', params: { sessionId, cwd } }),
  permission: (params, signal) => {
    if (typeof params.sessionId !== 'string' || typeof params.title !== 'string') return undefined
    const subject: unknown = params.subject
    const toolCall = isRecord(subject) && isRecord(subject.toolCall) ? subject.toolCall : {}
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined
    const options = readOptions(params)
    const reason = typeof params.description === 'string' ? params.description : undefined
    if (options === undefined) return undefined
    return {
      sessionId: params.sessionId,
      ...toolCallId === undefined ? {} : { toolCallId },
      title: params.title,
      ...reason === undefined ? {} : { reason },
      options,
      signal,
    }
  },
}
