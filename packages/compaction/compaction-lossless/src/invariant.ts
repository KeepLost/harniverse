/** Package-owned invariant companion for the lossless compaction projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-compaction-lossless'

/** Cordis companion plugin name. */
export const name = 'compaction-lossless-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the private projection mutates synchronously from validated Session events,
 * so no independent observation remains to compare after each update.
 */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
