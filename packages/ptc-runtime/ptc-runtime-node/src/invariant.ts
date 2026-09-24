/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ptc-runtime-node`.
 * @module @deepseek-ai/dsh-ptc-runtime-node/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ptc-runtime-node'

/** Cordis companion plugin name. */
export const name = 'ptc-runtime-node-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this process-boundary implementation exposes no same-process event relation;
 * child protocol and built-child tests cover it.
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
