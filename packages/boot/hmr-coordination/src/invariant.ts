/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-hmr-coordination`.
 * @module @deepseek-ai/dsh-hmr-coordination/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-hmr-coordination'

/** Cordis companion plugin name. */
export const name = 'hmr-coordination-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: boot-lifecycle reload coordination owns no durable
 * package-local event stream; serialization, failure, and disposal are
 * asserted by unit and boot composition tests.
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
