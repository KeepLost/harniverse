/**
 * The Feishu/Lark platform: the replaceable transports, the per-app mount
 * shared by configured and managed apps, and the {@link ChatPlatformDescriptor}
 * a host reads to list, validate, and mount Feishu apps.
 * @module @deepseek-ai/dsh-chat-adapter-feishu/platform
 */

import type { Context } from '@deepseek-ai/cordis'
import { ChatAdapterError, type ChatPlatformDescriptor } from '@deepseek-ai/dsh-chat-adapter'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import WebSocket from 'ws'
import { classify, FeishuAdapter } from './adapter.ts'
import { APP_ID_PATTERN, FeishuApi } from './api.ts'
import type { FetchLike, SocketLike } from './runtime.ts'

/** One configured app. */
export interface AppConfig {
  /** Feishu app id (`cli_...`). */
  appId: string
  /** Credential reference holding the app secret. */
  secretRef: string
  /** Open-platform origin: `https://open.feishu.cn` (Feishu) or `https://open.larksuite.com` (Lark). */
  domain: string
}

/** Replaceable transports; tests substitute a fake Open API and socket. */
export const internals: { fetch: FetchLike; createSocket: (url: string) => SocketLike } = {
  fetch: (input, init) => globalThis.fetch(input, init),
  // `ws` is a structural superset of SocketLike.
  createSocket: url => new WebSocket(url),
}

/** Feishu (China) Open Platform origin, used when no site is configured. */
export const DEFAULT_DOMAIN = 'https://open.feishu.cn'

/** Open Platform origins a managed app may select. */
const SITES = [
  { value: DEFAULT_DOMAIN, label: '飞书（中国）' },
  { value: 'https://open.larksuite.com', label: 'Lark（国际）' },
] as const

/**
 * Mount one adapter for an app in the calling scope. The secret must resolve
 * now: a missing credential or a malformed app id fails the mount instead of a
 * later connection attempt.
 * @param ctx - scope owning the registration.
 * @param app - the app to mount.
 */
export async function mountApp(ctx: Context, app: AppConfig): Promise<void> {
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

/**
 * Resolve the Open Platform origin of a managed app.
 * @param value - typed site; blank selects Feishu (China).
 * @returns one of the declared site origins.
 * @throws {ChatAdapterError} `network` when the value is not a declared site.
 */
function openPlatformOrigin(value: string | undefined): string {
  const typed = value?.trim() ?? ''
  if (typed === '') return DEFAULT_DOMAIN
  if (SITES.some(site => site.value === typed)) return typed
  throw new ChatAdapterError('network', 'feishu', 'the site is not a supported Open Platform origin')
}

/** The Feishu/Lark platform as a host-listable, probe-able, mountable channel. */
export const feishuDescriptor: ChatPlatformDescriptor = {
  platform: 'feishu',
  label: '飞书',
  fields: [
    { key: 'appId', label: 'App ID', secret: false, required: true, placeholder: 'cli_xxxxxxxxxxxxxxxx' },
    { key: 'appSecret', label: 'App Secret', secret: true, required: true },
    { key: 'domain', label: '站点', secret: false, required: false, hint: '留空使用飞书（中国）', options: SITES },
  ],
  async probe(values, signal) {
    const appId = values.appId?.trim() ?? ''
    if (!APP_ID_PATTERN.test(appId)) throw new ChatAdapterError('auth-failed', 'feishu', 'the value is not a Feishu app id')
    const secret = values.appSecret?.trim() ?? ''
    if (secret === '') throw new ChatAdapterError('auth-failed', 'feishu', 'the app secret is empty')
    const api = new FeishuApi({
      appId,
      secret: () => Promise.resolve(secret),
      domain: openPlatformOrigin(values.domain),
      fetch: (input, init) => internals.fetch(input, init),
    })
    try {
      const info = await api.callBody<{ bot?: { app_name?: string } }>({ method: 'GET', path: '/open-apis/bot/v3/info', signal })
      return { botId: appId, displayName: info.bot?.app_name || appId }
    } catch (error) {
      throw classify(error, 'run')
    }
  },
  async mount(ctx, bot) {
    const secretRef = bot.secretRefs.appSecret
    if (secretRef === undefined) throw new Error('chat-adapter-feishu: the managed bot has no appSecret credential')
    await mountApp(ctx, { appId: bot.values.appId?.trim() ?? '', secretRef, domain: openPlatformOrigin(bot.values.domain) })
  },
}
