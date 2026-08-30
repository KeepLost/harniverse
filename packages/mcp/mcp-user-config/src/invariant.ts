/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mcp-user-config`.
 * @module @deepseek-ai/dsh-mcp-user-config/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-user-config'

/** Cordis companion plugin name. */
export const name = 'mcp-user-config-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the host provider owns the shared settings scope, each
 * consumer owns a private stable-id-to-child map, and the child mcp-client
 * owns the public tool registrations and capability snapshots.
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
