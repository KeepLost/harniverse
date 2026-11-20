/** Package-owned invariant companion for `@deepseek-ai/dsh-peer-outbox`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-peer-outbox'

/** Cordis companion plugin name. */
export const name = 'peer-outbox-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the storage-domain ledger owns every durable
 * relation and already emits `domain/changed` after each acknowledged write,
 * while this service owns no independent event history or mutable runtime
 * data beyond disposable timers and chains.
 */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
