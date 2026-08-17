/** Package-owned invariant companion for `@deepseek-ai/dsh-auth-app`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-app'

/** Cordis companion plugin name. */
export const name = 'auth-app-invariant'

/** Service required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: each invocation has no mutable in-tree state after bounded exit. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
