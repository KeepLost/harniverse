/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-chat-adapter`.
 * @module @deepseek-ai/dsh-chat-adapter/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { chatAdapterKey } from './key.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-chat-adapter'

/** Cordis companion plugin name. */
export const name = 'chat-adapter-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Registry lifecycle: a `platform:botId` key is live at most once, becomes
 * readable through `get` before `registered` fires, and is gone from `get`
 * before `unregistered` fires for the same adapter object. Platform
 * descriptors follow the same relation through `platform` and the
 * `chat-platform/*` events.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const live = new Map<string, unknown>()
  ctx.on('chat-adapter/registered', (adapter) => {
    const key = chatAdapterKey(adapter.platform, adapter.botId)
    if (live.has(key)) fail(`chat-adapter/registered repeated live key ${JSON.stringify(key)}`)
    if (ctx.chatAdapters.get(adapter.platform, adapter.botId) !== adapter) {
      fail(`chat-adapter/registered fired before ${JSON.stringify(key)} was readable`)
    }
    live.set(key, adapter)
  }, { global: true })
  ctx.on('chat-adapter/unregistered', (adapter) => {
    const key = chatAdapterKey(adapter.platform, adapter.botId)
    if (live.get(key) !== adapter) fail(`chat-adapter/unregistered names unknown adapter ${JSON.stringify(key)}`)
    if (ctx.chatAdapters.get(adapter.platform, adapter.botId) !== undefined) {
      fail(`chat-adapter/unregistered fired while ${JSON.stringify(key)} was still readable`)
    }
    live.delete(key)
  }, { global: true })
  const platforms = new Map<string, unknown>()
  ctx.on('chat-platform/registered', (descriptor) => {
    const id = descriptor.platform
    if (platforms.has(id)) fail(`chat-platform/registered repeated live platform ${JSON.stringify(id)}`)
    if (ctx.chatAdapters.platform(id) !== descriptor) {
      fail(`chat-platform/registered fired before ${JSON.stringify(id)} was readable`)
    }
    platforms.set(id, descriptor)
  }, { global: true })
  ctx.on('chat-platform/unregistered', (descriptor) => {
    const id = descriptor.platform
    if (platforms.get(id) !== descriptor) fail(`chat-platform/unregistered names unknown platform ${JSON.stringify(id)}`)
    if (ctx.chatAdapters.platform(id) !== undefined) {
      fail(`chat-platform/unregistered fired while ${JSON.stringify(id)} was still readable`)
    }
    platforms.delete(id)
  }, { global: true })
}, { inject: ['chatAdapters'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
