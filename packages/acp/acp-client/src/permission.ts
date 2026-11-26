/**
 * Permission answerers: the fixed policies a connection can answer
 * `session/request_permission` with.
 * @module @deepseek-ai/dsh-acp-client/permission
 */

import type { AcpPermissionAnswer, AcpPermissionAnswerer, AcpPermissionRequest } from './types.ts'

/** A fixed answer for every request. */
export type AcpPermissionPolicy =
  /** Take the agent's first option that grants consent. */
  | 'allow'
  /** Decline every request. */
  | 'reject'

const CANCELLED: AcpPermissionAnswer = { outcome: { outcome: 'cancelled' } }

/**
 * Select the first option whose kind grants consent; without one, withhold consent.
 * @param request - the permission request with the agent's options.
 * @returns the answer to send.
 */
export function allowAnswer(request: AcpPermissionRequest): AcpPermissionAnswer {
  const allow = request.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
  return allow === undefined ? CANCELLED : { outcome: { outcome: 'selected', optionId: allow.optionId } }
}

/**
 * Answer every request with one fixed policy. `allow` declines a request that offers no allow option.
 * @param policy - the fixed policy.
 * @returns the answerer.
 */
export function policyAnswerer(policy: AcpPermissionPolicy): AcpPermissionAnswerer {
  return policy === 'allow' ? allowAnswer : rejectAnswerer
}

/** Decline every request. The default of every connection that names no answerer. */
export const rejectAnswerer: AcpPermissionAnswerer = () => CANCELLED
