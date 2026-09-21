/** Package-owned invariant registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'subprocess-ssh-invariant'
export const inject = ['invariants']
/** No runtime invariant: remote process lifetimes have no local metering or durable Session event relationship. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-subprocess-ssh', install))
