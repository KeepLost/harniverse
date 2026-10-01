/** Remote app invariant ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
/** Companion plugin name. */
export const name = 'remote-server-invariant'
/** Required registration service. */
export const inject = ['invariants']
/** No runtime invariant: the app composes providers; each provider owns its runtime data relations. */
const install: InvariantInstaller = () => {}
/** @param ctx - owning companion context. @returns effect-scoped disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-remote-server', install))
