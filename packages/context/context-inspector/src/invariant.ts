/** No runtime invariant: a read-only projection owns no durable relation. @module @deepseek-ai/dsh-context-inspector/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'context-inspector-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the inspector projects other packages' durable state
 * on demand and owns no continuously observable in-process relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register the context-inspector invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-context-inspector', install))
