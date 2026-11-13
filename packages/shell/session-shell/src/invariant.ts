/**
 * Package-owned session-event invariants for session shell selection.
 * @module @deepseek-ai/dsh-session-shell/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-shell'

/** Cordis companion plugin name. */
export const name = 'session-shell-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Reject any committed change whose family is not one of the two selections. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'session-shell/change') {
    // Widened on purpose: the declared type says one of the two selections;
    // the runtime check exists for exactly the case where it lies (foreign
    // archives, older writers, hand-edited stores).
    const family: unknown = event.data.family
    if (family !== 'bash' && family !== 'pwsh') {
      fail(`session-shell/change carries an unknown family ${JSON.stringify(family)}`)
    }
  }
}

/** Install validation for loaded and newly appended session-shell changes. */
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
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
