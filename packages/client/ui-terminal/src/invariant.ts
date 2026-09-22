/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-terminal`.
 * @module @deepseek-ai/dsh-client-ui-terminal/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-terminal'

/** Cordis companion plugin name. */
export const name = 'terminal-panel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a pure presentation projection of the
 * authenticated terminal-controller surface onto one center view. It emits no
 * cordis events, owns no cross-plugin mutable state beyond its slot-declared
 * store, and its slot registration proves disposal through the HMR-safety
 * spec.
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
