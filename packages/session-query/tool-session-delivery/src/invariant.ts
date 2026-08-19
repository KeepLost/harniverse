/** Invariant companion for the session-delivery model adapter. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'tool-session-delivery-invariant'
export const inject = ['invariants']
/** No runtime invariant: the provider owns delivery admission and lifecycle state. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-tool-session-delivery', install))
/* jscpd:ignore-end */
