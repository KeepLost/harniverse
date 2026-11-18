/** Package-owned runtime invariant companion. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Companion plugin name. */
export const name = 'peer-protocol-invariant'
/** The invariant registry owns registration lifetime. */
export const inject = ['invariants']
/** No runtime invariant: this package is a pure vocabulary and codec library with no Cordis surface. */
const install: InvariantInstaller = () => {}
/** @param ctx - companion context registering package ownership. @returns effect-scoped disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-peer-protocol', install))
