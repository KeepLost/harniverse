/** Package-owned invariant companion for chat-manager. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-chat-manager'
export const name = 'chat-manager-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: the manager publishes no event of its own, and every
 * state it reports is derived on read from the bridge's adapter status and
 * the registry file, so no second observable owner exists to cross-check.
 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
