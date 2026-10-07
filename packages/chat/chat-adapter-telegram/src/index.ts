/**
 * Telegram provider for the unified chat adapter registry. Each configured bot
 * registers one adapter; the bot token is a credential reference resolved per
 * request, never configuration.
 * @module @deepseek-ai/dsh-chat-adapter-telegram
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TelegramAdapter } from './adapter.ts'
import { TelegramApi, TOKEN_PATTERN, type FetchLike } from './api.ts'

export { TelegramAdapter, TELEGRAM_CAPABILITIES, classify } from './adapter.ts'
export { TelegramApi, TelegramApiError, TOKEN_PATTERN, type FetchLike } from './api.ts'
export { normalizeUpdate, stripBotMention, inboundMessageId, outboundMessageId, type BotIdentity } from './normalize.ts'

/** One configured bot. */
export interface BotConfig {
  /** Credential reference holding the bot token (`<id>:<secret>`). */
  tokenRef: string
  /** Server-side long-poll wait per `getUpdates` call. */
  pollTimeoutSeconds: number
  /** Bot API origin; the default is Telegram's public endpoint. */
  baseUrl: string
}

/** Provider configuration. */
export interface Config {
  /** One adapter is registered per configured bot. */
  bots: BotConfig[]
}

/** Loader validation for the provider row. */
export const Config: z<Config> = z.object({
  bots: z.array(z.object({
    tokenRef: z.string().required(),
    pollTimeoutSeconds: z.number().step(1).min(1).max(50).default(25),
    baseUrl: z.string().default('https://api.telegram.org/'),
  })).default([]),
})

/** Replaceable transport; tests substitute a fake Bot API. */
export const internals: { fetch: FetchLike } = {
  fetch: (input, init) => globalThis.fetch(input, init),
}

/** Stable Cordis plugin name. */
export const name = 'chat-adapter-telegram'
/** Services required before the provider can register. */
export const inject = ['chatAdapters', 'credentials']

/**
 * Register one adapter per configured bot. The token must resolve now: a
 * missing or malformed credential fails the mount instead of a later poll.
 * @param ctx - plugin context owning the registrations.
 * @param config - configured bots.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const bot of config.bots) {
    const ref = credentialRef(bot.tokenRef)
    const resolved = await ctx.credentials.resolve(ref)
    if (resolved === undefined || !TOKEN_PATTERN.test(resolved.value.trim())) {
      throw new Error(`chat-adapter-telegram: credential ${bot.tokenRef} is unset or is not a Telegram bot token`)
    }
    const token = resolved.value.trim()
    // TOKEN_PATTERN guarantees the `<bot id>:<secret>` shape.
    const botId = token.slice(0, token.indexOf(':'))
    const api = new TelegramApi({
      baseUrl: bot.baseUrl,
      fetch: (input, init) => internals.fetch(input, init),
      token: async () => {
        const current = await ctx.credentials.resolve(ref)
        if (current === undefined) throw new Error(`credential ${bot.tokenRef} is unset`)
        return current.value.trim()
      },
    })
    const adapter = new TelegramAdapter({
      botId, api, pollTimeoutSeconds: bot.pollTimeoutSeconds,
      warn: (message, error) => { ctx.logger.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`) },
    })
    ctx.effect(() => ctx.chatAdapters.register(adapter))
  }
}
