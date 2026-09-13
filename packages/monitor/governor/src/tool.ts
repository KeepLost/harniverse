/**
 * The model-facing `resource-quota` tool: a separately loadable Consumer over
 * the governor service so preset compositions decide per agent whether quota
 * negotiation is model-visible, while the service itself stays on the host
 * plane. Execute resolves the calling agent's session, so a tool call can only
 * ever read or negotiate that one session's memory quota.
 * @module @deepseek-ai/dsh-governor/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type GovernorService from './index.ts'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { MIN_RAISE_BYTES } from './quota.ts'
import type { SessionQuotaState } from './types.ts'

export const name = 'governor-resource-quota'
export const inject = ['governor', 'tools']

/** Deployment config of the quota tool; it has no options of its own. */
export interface Config {}

export function apply(ctx: Context, _config: Config = {}): void {
  const governor: GovernorService = ctx.governor
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'resource-quota',
    description: 'Read or negotiate the memory quota of YOUR current session. Get returns the effective limit, the global budget, and current usage. Set with memoryBytes to request a different explicit quota (must exceed 64MiB to be meaningful); omit memoryBytes to drop the explicit quota and rejoin the shared pool. Raises may require user approval and are always clamped by the remaining global budget. This tool cannot touch other sessions or the global budget.',
    parameters: {
      action: { type: 'string', required: true, enum: ['get', 'set'], description: 'get reads the quota state; set negotiates a change.' },
      memoryBytes: { type: 'number', description: 'With action=set: the explicit memory quota in bytes. Omit to clear the explicit quota and rejoin the shared pool.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'state' },
              sessionId: { type: 'string', required: true },
              quotaBytes: { type: 'number' },
              effectiveLimitBytes: { type: 'number', required: true },
              globalLimitBytes: { type: 'number', required: true },
              shared: { type: 'boolean', required: true },
              clamped: { type: 'boolean' },
              liveRssBytes: { type: 'number', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'rejected' },
              reason: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'rejected'
          ? `quota request rejected: ${value.reason}`
          : `session ${value.sessionId} memory quota: ${value.shared ? 'shared pool' : `${String(value.quotaBytes)} bytes`}`
            + `, effective limit ${String(value.effectiveLimitBytes)} bytes, global budget ${String(value.globalLimitBytes)} bytes`
            + (value.clamped === true ? ' (clamped to the remaining budget)' : ''),
      }],
      presentationMeta: (_args, value) => value,
    },
    execute: async (args: { action: string; memoryBytes?: number }, exec: ToolExecution) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error('resource-quota requires a session context')
      const sessionId = agent.session.id
      if (args.action === 'get') {
        const state = governor.quotaStateOf(sessionId)
        return {
          kind: 'state' as const,
          sessionId,
          ...quotaField(state),
          effectiveLimitBytes: state.effectiveLimitBytes,
          globalLimitBytes: governor.budgetLimitBytes,
          shared: state.shared,
          liveRssBytes: governor.liveRssBytes(sessionId),
        }
      }
      if (args.memoryBytes === undefined) {
        const state = await governor.adjustQuota(sessionId, null, 'clear')
        return toolState(governor, sessionId, state, false)
      }
      if (!Number.isFinite(args.memoryBytes) || args.memoryBytes <= 0) {
        throw new Error('memoryBytes must be a positive number')
      }
      const { beforeBytes, grantedBytes, clamped } = governor.admitExplicit(sessionId, args.memoryBytes)
      const raise = grantedBytes > beforeBytes
      if (raise && grantedBytes < MIN_RAISE_BYTES) {
        return { kind: 'rejected' as const, reason: `the raise is below the ${MIN_RAISE_BYTES}-byte minimum a quota is meaningful at` }
      }
      if (raise && !await approveRaise(ctx, agent, exec, beforeBytes, grantedBytes)) {
        return { kind: 'rejected' as const, reason: 'the quota raise was not approved' }
      }
      const state = await governor.adjustQuota(sessionId, grantedBytes, 'tool')
      return toolState(governor, sessionId, state, clamped)
    },
  })), 'governor: resource-quota tool')
}

/**
 * Ask for approval on one raise under an `ask` policy; `never` (the
 * danger-full-access posture) proceeds — admission still clamps, and a
 * missing approval service means no gate is configured.
 */
async function approveRaise(ctx: Context, agent: NonNullable<ToolExecution['agent']>, exec: ToolExecution, before: number, grantedBytes: number): Promise<boolean> {
  const approval = ctx.get('approval') as {
    effectivePolicy(session: Session): 'ask' | 'never'
    request(req: { agent: unknown; toolName: string; callId?: string; reason: string; signal?: AbortSignal }): Promise<string>
  } | undefined
  if (approval === undefined || approval.effectivePolicy(agent.session) === 'never') return true
  const outcome = await approval.request({
    agent,
    toolName: 'resource-quota',
    callId: exec.callId,
    reason: `raise the session memory quota from ${before} to ${grantedBytes} bytes`,
    signal: exec.signal,
  })
  return outcome === 'allowed-once'
}

/** The `state` result shape shared by every non-rejected tool outcome. */
function quotaField(state: SessionQuotaState): { quotaBytes?: number } {
  return state.quotaBytes === undefined ? {} : { quotaBytes: state.quotaBytes }
}

function toolState(governor: GovernorService, sessionId: string, state: SessionQuotaState, clamped: boolean): {
  kind: 'state'
  sessionId: string
  quotaBytes?: number
  effectiveLimitBytes: number
  globalLimitBytes: number
  shared: boolean
  clamped: boolean
  liveRssBytes: number
} {
  return {
    kind: 'state' as const,
    sessionId,
    ...quotaField(state),
    effectiveLimitBytes: state.effectiveLimitBytes,
    globalLimitBytes: governor.budgetLimitBytes,
    shared: state.shared,
    clamped,
    liveRssBytes: governor.liveRssBytes(sessionId),
  }
}
