/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-compaction-body-limit-recovery`.
 * @module @deepseek-ai/dsh-compaction-body-limit-recovery/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-compaction-body-limit-recovery'

/** Cordis companion plugin name. */
export const name = 'compaction-body-limit-recovery-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the recovery appends no independent event or data
 * relation — every `image/offload` event it causes is validated by the
 * offload plugin's own companion, and compaction events by the compaction
 * companions.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
