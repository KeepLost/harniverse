/** Package-owned invariant registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'ssh-invariant'
export const inject = ['invariants']
/** No runtime invariant: connection and machine RPCs own no Session events; boundary schemas validate their private wire. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-ssh', install))
