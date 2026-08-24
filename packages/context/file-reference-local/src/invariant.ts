/** Package-owned invariant companion for the local file provider. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-file-reference-local'
export const name = 'file-reference-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: cache ownership and prompt lifecycle are local to the provider fiber. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
