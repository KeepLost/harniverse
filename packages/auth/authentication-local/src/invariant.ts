/** Package-owned invariant companion for local authentication. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-authentication-local'

/** Cordis companion plugin name. */
export const name = 'authentication-local-invariant'
/** Service required before package invariant registration. */
export const inject = ['invariants']

// No runtime invariant: file durability, lease ownership, and registry reloads
// require filesystem observations and are covered by this package's tests.
const install: InvariantInstaller = () => {}

/** Register the local authentication package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
