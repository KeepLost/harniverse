/** Package-owned invariant registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'fs-ssh-invariant'
export const inject = ['invariants']
/** No runtime invariant: filesystem operations return observations; the filesystem observation policy owns their durable relationship. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-fs-ssh', install))
