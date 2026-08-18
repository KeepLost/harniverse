/** Package-owned invariant companion for compaction history tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-compaction-history'

/** Cordis companion plugin name. */
export const name = 'tool-compaction-history-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tool and prompt registries own contribution lifecycle, while this
 * stateless adapter owns no independent event history or mutable runtime data.
 */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
