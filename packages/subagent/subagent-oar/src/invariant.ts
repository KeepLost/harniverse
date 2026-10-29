/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-subagent-oar`.
 * @module @deepseek-ai/dsh-subagent-oar/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subagent-oar'

/** Cordis companion plugin name. */
export const name = 'subagent-oar-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: native process ownership belongs to the embedded OAR
 * runtime and delegation lifecycle belongs to the shared subagent service.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - plugin context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
