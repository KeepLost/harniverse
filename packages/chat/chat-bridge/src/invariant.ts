/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-chat-bridge`.
 * @module @deepseek-ai/dsh-chat-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-chat-bridge'

/** Cordis companion plugin name. */
export const name = 'chat-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Serial-queue relation: a conversation key starts a task only while no task of
 * that key is running, and ends only a task it started, so inbound handling of
 * one conversation never overlaps.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const running = new Set<string>()
  ctx.on('chat-bridge/dispatch', ({ phase, key }) => {
    if (phase === 'start') {
      if (running.has(key)) fail(`conversation ${JSON.stringify(key)} started a task while another was running`)
      running.add(key)
      return
    }
    if (!running.delete(key)) fail(`conversation ${JSON.stringify(key)} ended a task that was not running`)
  }, { global: true })
}, {})

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
