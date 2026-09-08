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
 * Assert the durable correlation between `schedule/dispatch` anchors and the
 * scheduled prompt that follows: the anchor's target names the session it was
 * appended to, and the following inbox splice carries the schedule plugin
 * source's delivery identity.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'schedule/dispatch') return
    if (event.data.targetSessionId !== session.id) {
      fail(`schedule/dispatch at seq ${String(event.seq)} names target ${String(event.data.targetSessionId)} inside session ${String(session.id)}`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
