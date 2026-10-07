/**
 * Feishu/Lark provider for the unified chat adapter registry. Each configured
 * app registers one adapter; the app secret is a credential reference resolved
 * per request, never configuration.
 * @module @deepseek-ai/dsh-chat-adapter-feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import WebSocket from 'ws'
import { FeishuAdapter } from './adapter.ts'
import { APP_ID_PATTERN, FeishuApi } from './api.ts'
import type { FetchLike, SocketLike } from './runtime.ts'

export { FeishuAdapter, FEISHU_CAPABILITIES, classify } from './adapter.ts'
export { FeishuApi, FeishuApiError, APP_ID_PATTERN } from './api.ts'
export { FeishuConnection, type FetchLike, type SocketLike } from './runtime.ts'
export { decodeFrame, encodeFrame, type Frame, type FrameHeader } from './frame.ts'
export { interactionCard, markdownCard, settledCard } from './cards.ts'
export { normalizeEvent, parseAttachmentId, type BotIdentity } from './normalize.ts'

/** One configured app. */
export interface AppConfig {
  /** Feishu app id (`cli_...`). */
  appId: string
  /** Credential reference holding the app secret. */
  secretRef: string
  /** Open-platform origin: `https://open.feishu.cn` (Feishu) or `https://open.larksuite.com` (Lark). */
  domain: string
}

/** Provider configuration. */
export interface Config {
  /** One adapter is registered per configured app. */
  apps: AppConfig[]
}

/** Loader validation for the provider row. */
export const Config: z<Config> = z.object({
  apps: z.array(z.object({
    appId: z.string().required(),
    secretRef: z.string().required(),
    domain: z.string().default('https://open.feishu.cn'),
  })).default([]),
})

/** Replaceable transports; tests substitute a fake Open API and socket. */
export const internals: { fetch: FetchLike; createSocket: (url: string) => SocketLike } = {
  fetch: (input, init) => globalThis.fetch(input, init),
  // `ws` is a structural superset of SocketLike.
  createSocket: url => new WebSocket(url),
}

/** Stable Cordis plugin name. */
export const name = 'chat-adapter-feishu'
/** Services required before the provider can register. */
export const inject = ['chatAdapters', 'credentials']

/**
 * Register one adapter per configured app. The secret must resolve now: a
 * missing credential or a malformed app id fails the mount instead of a later
 * connection attempt.
 * @param ctx - plugin context owning the registrations.
 * @param config - configured apps.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const app of config.apps) {
    if (!APP_ID_PATTERN.test(app.appId)) throw new Error(`chat-adapter-feishu: ${JSON.stringify(app.appId)} is not a Feishu app id`)
    const ref = credentialRef(app.secretRef)
    if (await ctx.credentials.resolve(ref) === undefined) throw new Error(`chat-adapter-feishu: credential ${app.secretRef} is unset`)
    const secret = async (): Promise<string> => {
      const current = await ctx.credentials.resolve(ref)
      if (current === undefined) throw new Error(`credential ${app.secretRef} is unset`)
      return current.value.trim()
    }
    const fetch: FetchLike = (input, init) => internals.fetch(input, init)
    const adapter = new FeishuAdapter({
      appId: app.appId,
      domain: app.domain,
      secret,
      fetch,
      createSocket: url => internals.createSocket(url),
      api: new FeishuApi({ appId: app.appId, secret, domain: app.domain, fetch }),
      warn: (message, error) => { ctx.logger.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`) },
    })
    ctx.effect(() => ctx.chatAdapters.register(adapter))
  }
}
