/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-api-browser-controller`.
 * @module @deepseek-ai/dsh-api-browser-controller/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-api-browser-controller'

/** Cordis companion plugin name. */
export const name = 'browser-controller-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the controller's browser-process ownership is enforced
 * by its disposal effects and unit tests, and it publishes no cross-package
 * event contract that needs runtime verification.
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
