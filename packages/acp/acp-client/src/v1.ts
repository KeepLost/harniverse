/**
 * Wire shapes of ACP v1, the stable protocol. v1 answers `session/prompt` with
 * the turn's stop reason, an agent that can resume a saved session advertises
 * either `loadSession` or `session/resume`, and modes are switched through
 * `session/set_mode`.
 * @module @deepseek-ai/dsh-acp-client/v1
 */

import type { ProtocolShape } from './binding.ts'
import type { AcpPermissionRequest } from './types.ts'
import { isRecord } from './update.ts'

/** A v1 agent resumes through `session/load` unless it advertises `session/resume` without `loadSession`. */
function usesLoadSession(response: unknown): boolean {
  const capabilities = isRecord(response) && isRecord(response.agentCapabilities) ? response.agentCapabilities : {}
  const session = isRecord(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {}
  return capabilities.loadSession === true || session.resume == null
}

/**
 * Read the answer options of one raw permission request.
 * @param params - the raw `session/request_permission` params.
 * @returns the options, or `undefined` when any of them is malformed.
 */
export function readOptions(params: Readonly<Record<string, unknown>>): AcpPermissionRequest['options'] | undefined {
  const value = params.options
  if (!Array.isArray(value)) return undefined
  const options: { optionId: string; name: string; kind: string }[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.optionId !== 'string' || typeof item.name !== 'string' || typeof item.kind !== 'string') return undefined
    options.push({ optionId: item.optionId, name: item.name, kind: item.kind })
  }
  return options
}

/** The v1 shapes. */
export const V1: ProtocolShape = {
  version: 1,
  authenticate: 'authenticate',
  completion: 'response',
  initialize: (client, capabilities) => ({
    protocolVersion: 1,
    clientCapabilities: {
      // What this client reads off the wire whatever a consumer does with it.
      session: { configOptions: { boolean: {} }, notices: {} },
      plan: {},
      ...capabilities.elicitation ? { elicitation: { form: {} } } : {},
      ...capabilities.terminalAuth ? { auth: { terminal: true } } : {},
    },
    clientInfo: { name: client.name, version: client.version },
  }),
  newSession: cwd => ({ cwd, mcpServers: [] }),
  setMode: (sessionId, modeId) => ({ method: 'session/set_mode', params: { sessionId, modeId } }),
  configValue: value => typeof value === 'boolean' ? { type: 'boolean', value } : { value },
  resume: (response, sessionId, cwd) => usesLoadSession(response)
    ? { method: 'session/load', params: { sessionId, cwd, mcpServers: [] } }
    : { method: 'session/resume', params: { sessionId, cwd } },
  permission: (params, signal) => {
    if (typeof params.sessionId !== 'string') return undefined
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined
    const title = typeof toolCall.title === 'string' ? toolCall.title : undefined
    const options = readOptions(params)
    if (options === undefined) return undefined
    return {
      sessionId: params.sessionId,
      ...toolCallId === undefined ? {} : { toolCallId },
      ...title === undefined ? {} : { title },
      options,
      signal,
    }
  },
}
