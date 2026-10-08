/**
 * The Telegram platform: the replaceable transport, the per-bot mount shared by
 * configured and managed bots, and the {@link ChatPlatformDescriptor} a host
 * reads to list, validate, and mount Telegram bots.
 * @module @deepseek-ai/dsh-chat-adapter-telegram/platform
 */

import type { Context } from '@deepseek-ai/cordis'
import { ChatAdapterError, type ChatPlatformDescriptor } from '@deepseek-ai/dsh-chat-adapter'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { classify, TelegramAdapter } from './adapter.ts'
import { TelegramApi, TOKEN_PATTERN, type FetchLike } from './api.ts'

/** One configured bot. */
export interface BotConfig {
  /** Credential reference holding the bot token (`<id>:<secret>`). */
  tokenRef: string
  /** Server-side long-poll wait per `getUpdates` call. */
  pollTimeoutSeconds: number
  /** Bot API origin; the default is Telegram's public endpoint. */
  baseUrl: string
}

/** Replaceable transport; tests substitute a fake Bot API. */
export const internals: { fetch: FetchLike } = {
  fetch: (input, init) => globalThis.fetch(input, init),
}

/** Telegram's public Bot API origin. */
export const DEFAULT_BASE_URL = 'https://api.telegram.org/'
/** Long-poll wait applied when none is configured. */
export const DEFAULT_POLL_TIMEOUT_SECONDS = 25

/**
 * Mount one adapter for a bot in the calling scope. The token must resolve
 * now: a missing or malformed credential fails the mount instead of a later poll.
 * @param ctx - scope owning the registration.
 * @param bot - the bot to mount.
 */
export async function mountBot(ctx: Context, bot: BotConfig): Promise<void> {
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

/**
 * Resolve the Bot API origin of a managed bot.
 * @param value - typed address; blank selects Telegram's public endpoint.
 * @returns the origin to call.
 * @throws {ChatAdapterError} `network` when the address is not an http(s) URL.
 */
function botApiOrigin(value: string | undefined): string {
  const typed = value?.trim() ?? ''
  if (typed === '') return DEFAULT_BASE_URL
  if (URL.canParse(typed) && ['http:', 'https:'].includes(new URL(typed).protocol)) return typed
  throw new ChatAdapterError('network', 'telegram', 'the Bot API address is not an http(s) URL')
}

/** The Telegram platform as a host-listable, probe-able, mountable channel. */
export const telegramDescriptor: ChatPlatformDescriptor = {
  platform: 'telegram',
  label: 'Telegram',
  fields: [
    { key: 'token', label: '机器人 Token', secret: true, required: true, placeholder: '123456789:AA…', hint: '在 @BotFather 创建机器人后获得' },
    {
      key: 'baseUrl', label: 'Bot API 地址', secret: false, required: false,
      hint: 'Bot API 地址，留空使用官方 https://api.telegram.org/（无法直连时可填自建代理）',
    },
  ],
  async probe(values, signal) {
    const token = values.token?.trim() ?? ''
    if (!TOKEN_PATTERN.test(token)) throw new ChatAdapterError('auth-failed', 'telegram', 'the value is not a Telegram bot token')
    const api = new TelegramApi({
      baseUrl: botApiOrigin(values.baseUrl),
      fetch: (input, init) => internals.fetch(input, init),
      token: () => Promise.resolve(token),
    })
    // TOKEN_PATTERN guarantees the `<bot id>:<secret>` shape.
    const botId = token.slice(0, token.indexOf(':'))
    try {
      const me = await api.call<{ first_name?: string; username?: string }>('getMe', {}, { signal })
      return { botId, displayName: me.first_name ?? (me.username === undefined ? botId : `@${me.username}`) }
    } catch (error) {
      throw classify(error, 'poll')
    }
  },
  async mount(ctx, bot) {
    const tokenRef = bot.secretRefs.token
    if (tokenRef === undefined) throw new Error('chat-adapter-telegram: the managed bot has no token credential')
    await mountBot(ctx, { tokenRef, baseUrl: botApiOrigin(bot.values.baseUrl), pollTimeoutSeconds: DEFAULT_POLL_TIMEOUT_SECONDS })
  },
}
