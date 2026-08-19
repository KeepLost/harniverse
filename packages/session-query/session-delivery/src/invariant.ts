/** Invariant companion for the session-delivery Service Definition. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'session-delivery-invariant'
export const inject = ['invariants']
/** No runtime invariant: providers own admission and delivery lifecycle state. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-session-delivery', install))
/* jscpd:ignore-end */
