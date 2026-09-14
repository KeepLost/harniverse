/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-governor`.
 * @module @deepseek-ai/dsh-governor/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-governor'

/** Cordis companion plugin name. */
export const name = 'governor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Assert that a `governor/quota` audit event names the session it is appended
 * to. Validation runs on `internal/dispatch`, before the candidate joins the
 * log, so a violation rejects the append instead of reaching observe-only
 * publication where listener throws are contained.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'governor/quota') return
    if (event.data.sessionId !== session.id) {
      fail(`governor/quota at seq ${String(event.seq)} names session ${event.data.sessionId} inside session ${session.id}`)
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
