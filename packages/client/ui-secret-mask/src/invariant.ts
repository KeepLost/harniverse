/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-secret-mask`.
 * @module @deepseek-ai/dsh-client-ui-secret-mask/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-secret-mask'

/** Cordis companion plugin name. */
export const name = 'ui-secret-mask-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package projects the queue Remote onto one
 * in-page tab. It emits no cordis events, owns no cross-plugin mutable
 * state, and its slot registration proves disposal through the HMR-safety
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
