/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-acp`.
 * @module @deepseek-ai/dsh-agent-acp/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-acp'

/** Cordis companion plugin name. */
export const name = 'agent-acp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the session invariant already requires every tool
 * result to cite a tool call of its own step, which is the one relation this
 * driver's events add; the external agent owns everything else it reports.
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
