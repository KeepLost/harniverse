/** Package-owned durable context-notice invariants. @module @deepseek-ai/dsh-context-nudge/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-context-nudge'
const SOURCE = '@deepseek-ai/dsh-context-nudge'

/** Cordis companion plugin name. */
export const name = 'context-nudge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one owned notice: its recorded measured occupancy met its threshold. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'user/message') return
  const source = event.data.source as {
    kind?: unknown
    plugin?: unknown
    form?: unknown
    thresholdTokens?: unknown
    measuredTokens?: unknown
  }
  if (source.kind !== 'plugin' || source.plugin !== SOURCE || source.form !== 'system-injection') return
  if (typeof source.thresholdTokens !== 'number') return
  if (typeof source.measuredTokens !== 'number' || source.measuredTokens < source.thresholdTokens) {
    fail('an owned context-pressure notice must record a measurement at or above its threshold')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended owned notices. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('session/created', (session: Session) => {
    for (const event of session.events) validateEvent(event, fail)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode: unknown, eventName: string, args: unknown[]) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    void session
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the context-nudge invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
