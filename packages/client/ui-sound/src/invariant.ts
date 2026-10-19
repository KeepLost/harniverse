/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-sound`.
 * @module @deepseek-ai/dsh-client-ui-sound/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-sound'

/** Cordis companion plugin name. */
export const name = 'ui-sound-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the sound feature observes mux/host frames and the
 * sessions list read-only, routes every write through the `ui-sound` settings
 * scope, and emits no cordis events of its own. Slot registrations prove
 * disposal through the HMR-safety spec.
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
