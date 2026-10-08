/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-im`.
 * @module @deepseek-ai/dsh-client-ui-settings-im/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-im'

/** Cordis companion plugin name. */
export const name = 'ui-settings-im-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a projection of the chatBots Remote
 * onto one settings section. It emits no cordis events, owns no cross-plugin
 * mutable state, and its slot registration proves disposal through the apply
 * spec.
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
