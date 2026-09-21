/** Package-owned invariant registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'sandbox-ssh-invariant'
export const inject = ['invariants']
/** No runtime invariant: confinement returns argv and enforcement facts without owning Session events. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-sandbox-ssh', install))
