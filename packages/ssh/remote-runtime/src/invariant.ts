/** Package-owned runtime invariant companion. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Companion plugin name. */
export const name = 'remote-runtime-invariant'
/** The invariant registry owns registration lifetime. */
export const inject = ['invariants']
/** No runtime invariant: lock state is encrypted-provider-owned; endpoint ownership is a filesystem contract. */
const install: InvariantInstaller = () => {}
/** @param ctx - companion context registering package ownership. @returns effect-scoped disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-remote-runtime', install))
