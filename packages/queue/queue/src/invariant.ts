/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-queue`: every
 * queue delivery (a `user/message` whose plugin source names `queue`) must
 * carry its topic name and offset, so a delivery is reconstructable from
 * the session log alone. Validation runs on `internal/dispatch`, before
 * the candidate joins the log.
 * @module @deepseek-ai/dsh-queue/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-queue'

/** Cordis companion plugin name. */
export const name = 'queue-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message') return
    const source = (event.data as { source?: { plugin?: string } }).source
    if (source?.plugin !== 'queue') return
    const named = source as { topic?: string; offset?: number }
    if (typeof named.topic !== 'string' || typeof named.offset !== 'number') {
      fail(`queue delivery at seq ${String(event.seq)} in session ${session.id} lacks its topic/offset source`)
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
