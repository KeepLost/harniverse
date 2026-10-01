/** Package-owned invariant companion. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'remote-hosts-invariant'
export const inject = ['invariants']
/** No runtime invariant: the coordinator emits no events; registry secrecy and SSH lifetime are boundary contracts tested directly. */
const install: InvariantInstaller = () => {}
/** @param ctx - companion context. @returns effect-owned registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-remote-hosts', install))
