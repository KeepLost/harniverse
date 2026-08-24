/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-pwsh-persistent`.
 * @module @deepseek-ai/dsh-tool-pwsh-persistent/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-pwsh-persistent'

/** Cordis companion plugin name. */
export const name = 'tool-pwsh-persistent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the private owner-to-shell cache has no observable
 * event/data relation. Lifecycle tests prove cleanup without a test-only API.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns Installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
