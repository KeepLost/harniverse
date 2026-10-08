/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-chat-adapter-feishu`.
 * @module @deepseek-ai/dsh-chat-adapter-feishu/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-chat-adapter-feishu'

/** Cordis companion plugin name. */
export const name = 'chat-adapter-feishu-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the long-connection protocol has no event relation
 * this package owns beyond what its frame and fixture tests pin; registry
 * uniqueness is checked by the chat-adapter companion.
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
