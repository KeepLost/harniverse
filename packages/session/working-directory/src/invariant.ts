/** Package-owned session-event invariants for working directories. @module @deepseek-ai/dsh-working-directory/invariant */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-working-directory'

/** Cordis companion plugin name. */
export const name = 'working-directory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Reject any committed change whose directory is not an absolute non-empty path. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'working-directory/change') {
    const { cwd } = event.data
    if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
      fail(`working-directory/change carries a non-absolute cwd ${JSON.stringify(cwd)}`)
    }
  }
}

/** Install validation for loaded and newly appended working-directory changes. */
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
