/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-scheduler`.
 * @module @deepseek-ai/dsh-scheduler/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-scheduler'

/** Cordis companion plugin name. */
export const name = 'scheduler-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Assert that a `schedule/dispatch` provenance event names the session it is
 * appended to. Validation runs on `internal/dispatch`, before the candidate
 * joins the log, so a violation rejects the append instead of reaching
 * observe-only publication where listener throws are contained.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'schedule/dispatch') return
    if (event.data.targetSessionId !== session.id) {
      fail(`schedule/dispatch at seq ${String(event.seq)} names target ${String(event.data.targetSessionId)} inside session ${String(session.id)}`)
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
