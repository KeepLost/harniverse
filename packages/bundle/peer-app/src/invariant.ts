/** Package-owned runtime invariant companion. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Companion plugin name. */
export const name = 'peer-app-invariant'
/** The invariant registry owns registration lifetime. */
export const inject = ['invariants']
/** No runtime invariant: this one-shot app exits after its selected pairing operation. */
const install: InvariantInstaller = () => {}
/** @param ctx - companion context registering package ownership. @returns effect-scoped disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-peer-app', install))
