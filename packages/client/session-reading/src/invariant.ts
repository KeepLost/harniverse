/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-session-reading`.
 * @module @deepseek-ai/dsh-client-session-reading/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-session-reading'

/** Cordis companion plugin name. */
export const name = 'client-session-reading-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the reading ledger is process-local view state and
 * `sessionReading/changed` carries no payload, so no durable event or
 * cross-plugin data relation exists to assert; ledger arithmetic is pinned by
 * this package's host spec.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
