import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'client-ui-remote-hosts-invariant'
export const inject = ['invariants']
/** No runtime invariant: this UI package owns slots and client state, not Session events. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-client-ui-remote-hosts', install))
