/** Package-owned durable delivery-declaration invariants. @module @deepseek-ai/dsh-tool-present/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-present'

/** Cordis companion plugin name. */
export const name = 'tool-present-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one delivery declaration before it is treated as durable.
 *
 * Deliberately silent on whether the files exist or are still regular: those
 * are facts about the filesystem at call time, not about the log. A replayed
 * Session may outlive its workspace, so the durable rule is only that every
 * declaration names a non-empty path with an optional string description on a
 * positive turn with a calling tool id.
 */
function validatePresented(value: unknown, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null) fail('deliverables/presented data must be an object')
  const { turn, callId, files } = value as Record<string, unknown>
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1) {
    fail('deliverables/presented turn must be a positive integer')
  }
  if (typeof callId !== 'string' || callId.length === 0) {
    fail('deliverables/presented callId must be a non-empty string')
  }
  if (!Array.isArray(files) || files.length === 0) fail('deliverables/presented files must be a non-empty array')
  for (const file of files) {
    if (typeof file !== 'object' || file === null || Array.isArray(file)) {
      fail('deliverables/presented entries must be objects')
    }
    const { path, description } = file as Record<string, unknown>
    if (typeof path !== 'string' || path.trim().length === 0) {
      fail('deliverables/presented path must be a non-empty string')
    }
    if (description !== undefined && typeof description !== 'string') {
      fail('deliverables/presented description must be a string when present')
    }
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'deliverables/presented') validatePresented(event.data, fail)
}

/** Install validation for loaded and newly appended delivery declarations. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the present invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
