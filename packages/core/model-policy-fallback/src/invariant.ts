/** Package-owned invariant companion for cross-model fallback. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-policy-fallback'
export const name = 'model-policy-fallback-invariant'
export const inject = ['invariants']
/** No runtime invariant: fallback appends only after the request-error decision point. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
