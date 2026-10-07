/**
 * Telegram provider for the unified chat adapter registry. It registers the
 * Telegram platform descriptor and one adapter per configured bot; the bot
 * token is a credential reference resolved per request, never configuration.
 * @module @deepseek-ai/dsh-chat-adapter-telegram
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BASE_URL, DEFAULT_POLL_TIMEOUT_SECONDS, mountBot, telegramDescriptor, type BotConfig } from './platform.ts'

export { TelegramAdapter, TELEGRAM_CAPABILITIES, classify } from './adapter.ts'
export { TelegramApi, TelegramApiError, TOKEN_PATTERN, type FetchLike } from './api.ts'
export { normalizeUpdate, stripBotMention, inboundMessageId, outboundMessageId, type BotIdentity } from './normalize.ts'
export { internals, telegramDescriptor, type BotConfig } from './platform.ts'

/** Provider configuration. */
export interface Config {
  /** One adapter is registered per configured bot. */
  bots: BotConfig[]
}

/** Loader validation for the provider row. */
export const Config: z<Config> = z.object({
  bots: z.array(z.object({
    tokenRef: z.string().required(),
    pollTimeoutSeconds: z.number().step(1).min(1).max(50).default(DEFAULT_POLL_TIMEOUT_SECONDS),
    baseUrl: z.string().default(DEFAULT_BASE_URL),
  })).default([]),
})

/** Stable Cordis plugin name. */
export const name = 'chat-adapter-telegram'
/** Services required before the provider can register. */
export const inject = ['chatAdapters', 'credentials']

/**
 * Register the Telegram platform descriptor and one adapter per configured
 * bot. The token must resolve now: a missing or malformed credential fails the
 * mount instead of a later poll.
 * @param ctx - plugin context owning the registrations.
 * @param config - configured bots; an empty list registers the platform only.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.effect(() => ctx.chatAdapters.registerPlatform(telegramDescriptor))
  for (const bot of config.bots) await mountBot(ctx, bot)
}
