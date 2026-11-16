/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-util-ripgrep`.
 * @module @deepseek-ai/dsh-util-ripgrep/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-util-ripgrep'

/** Cordis companion plugin name. */
export const name = 'util-ripgrep-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this process-helper utility owns no event stream or
 * mutable runtime data; its resolution and streaming contracts are enforced by
 * unit tests against the real subprocess seam.
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
