/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-hooks`.
 * @module @deepseek-ai/dsh-tool-hooks/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-hooks'

/** Cordis companion plugin name. */
export const name = 'tool-hooks-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tools serialize their mutations on each scope's
 * store through exclusive tool dispatch, file consumers re-read per event, and
 * the session layer's `hook/config` relations belong to
 * `@deepseek-ai/dsh-hook-protocol`, which declares the event.
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
