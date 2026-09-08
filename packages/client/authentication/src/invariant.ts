import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** No runtime invariant: authentication observations are local snapshots, not Cordis events. */
const install: InvariantInstaller = () => {}
/** Invariant companion name. */
export const name = 'client-authentication-invariant'
/** Ownership registry dependency. */
export const inject = ['invariants']
/** Reserve package ownership; lifecycle and replay invariants are covered through public behavior tests. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-client-authentication', install))
