import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** No runtime invariant: this read-only renderer owns no domain state or lifecycle. */
const install: InvariantInstaller = () => {}
/** Invariant companion name. */
export const name = 'client-ui-connection-status-invariant'
/** Ownership registry dependency. */
export const inject = ['invariants']
/** Reserve the status renderer's package ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-client-ui-connection-status', install))
