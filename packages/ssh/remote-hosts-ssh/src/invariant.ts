/** Package-owned invariant registration. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'remote-hosts-ssh-invariant'
export const inject = ['invariants']
/** No runtime invariant: this transport owns no Session events; its wire boundaries enforce pinning and forwarding authorization. */
const install: InvariantInstaller = () => {}

/**
 * @param ctx - Invariant registry context.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(
  ctx.invariants.register('@deepseek-ai/dsh-remote-hosts-ssh', install),
)
