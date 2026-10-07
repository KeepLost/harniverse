/**
 * Feishu/Lark provider for the unified chat adapter registry. It registers the
 * Feishu platform descriptor and one adapter per configured app; the app secret
 * is a credential reference resolved per request, never configuration.
 * @module @deepseek-ai/dsh-chat-adapter-feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_DOMAIN, feishuDescriptor, mountApp, type AppConfig } from './platform.ts'

export { FeishuAdapter, FEISHU_CAPABILITIES, classify } from './adapter.ts'
export { FeishuApi, FeishuApiError, APP_ID_PATTERN } from './api.ts'
export { FeishuConnection, type FetchLike, type SocketLike } from './runtime.ts'
export { decodeFrame, encodeFrame, type Frame, type FrameHeader } from './frame.ts'
export { interactionCard, markdownCard, settledCard } from './cards.ts'
export { normalizeEvent, parseAttachmentId, type BotIdentity } from './normalize.ts'
export { feishuDescriptor, internals, type AppConfig } from './platform.ts'

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
    domain: z.string().default(DEFAULT_DOMAIN),
  })).default([]),
})

/** Stable Cordis plugin name. */
export const name = 'chat-adapter-feishu'
/** Services required before the provider can register. */
export const inject = ['chatAdapters', 'credentials']

/**
 * Register the Feishu platform descriptor and one adapter per configured app.
 * The secret must resolve now: a missing credential or a malformed app id
 * fails the mount instead of a later connection attempt.
 * @param ctx - plugin context owning the registrations.
 * @param config - configured apps; an empty list registers the platform only.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.effect(() => ctx.chatAdapters.registerPlatform(feishuDescriptor))
  for (const app of config.apps) await mountApp(ctx, app)
}
