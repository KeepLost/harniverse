/**
 * Package-owned invariant companion for Model Policy.
 *
 * The service validates settings and authorizes every target before appending
 * its durable event. There is no additional cross-package relation to assert.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-policy'

/** Cordis companion plugin name. */
export const name = 'model-policy-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: settings and target authorization own all mutable relations. */
const install: InvariantInstaller = () => {}

/** Register the intentionally empty invariant contribution. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
