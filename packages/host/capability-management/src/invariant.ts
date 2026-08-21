/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-capability-management/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-capability-management'
export const name = 'host-capability-management-invariant'
export const inject = ['invariants']
/** No runtime invariant: the Gateway delegates every transaction to the capability service without owning derived state. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
