/** Invariant companion for the local session-delivery provider. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'session-delivery-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: inbox insertion is owned and validated by Agent. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-session-delivery-local', install))
/* jscpd:ignore-end */
