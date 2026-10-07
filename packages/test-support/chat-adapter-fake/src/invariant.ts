/** Package-owned invariant companion for `@deepseek-ai/dsh-chat-adapter-fake`. @module @deepseek-ai/dsh-chat-adapter-fake/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-chat-adapter-fake'

/** Cordis companion plugin name. */
export const name = 'chat-adapter-fake-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this test-only adapter has no platform protocol and
 * owns no event relationship; its behavior is asserted by its own tests.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
