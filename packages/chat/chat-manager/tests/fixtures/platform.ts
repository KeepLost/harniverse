/** A scripted chat platform: a descriptor whose probe and adapter behavior a test controls. */

import type { Context } from '@deepseek-ai/cordis'
import {
  ChatAdapterError, type ChatBotIdentity, type ChatInboundSink, type ChatManagedBot, type ChatPlatformDescriptor,
} from '@deepseek-ai/dsh-chat-adapter'
import { FakeChatAdapter } from '@deepseek-ai/dsh-chat-adapter-fake'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** How a mounted adapter's `run` loop behaves. */
export type RunScript = 'running' | 'network' | 'auth-failed' | 'poll-conflict' | 'ends'

/** An adapter whose run loop follows the platform's script for its bot. */
class ScriptedAdapter extends FakeChatAdapter {
  constructor(botId: string, private readonly script: () => RunScript) {
    super({ platform: 'stub', botId })
  }

  override async run(sink: ChatInboundSink, signal: AbortSignal): Promise<void> {
    switch (this.script()) {
      case 'network': throw new ChatAdapterError('network', 'stub', 'the platform is unreachable')
      case 'auth-failed': throw new ChatAdapterError('auth-failed', 'stub', 'the platform rejected the credential')
      case 'poll-conflict': throw new ChatAdapterError('poll-conflict', 'stub', 'another instance polls this bot')
      case 'ends': return
      case 'running': return super.run(sink, signal)
    }
  }
}

/** The knobs and records of one scripted platform. */
export class StubPlatform {
  /** Every probe call, with the values it saw. */
  readonly probes: Array<Readonly<Record<string, string>>> = []
  /** Every mount call. */
  readonly mounts: ChatManagedBot[] = []
  /** Adapters currently registered by this platform. */
  readonly adapters = new Set<ScriptedAdapter>()
  /** Bot ids whose mount throws. */
  readonly failMount = new Set<string>()
  /** Run behavior by bot id; the default is a healthy long-lived loop. */
  readonly scripts = new Map<string, RunScript>()
  /** When set, every mount waits for it before resolving the credential. */
  gate: Promise<void> | undefined
  /** Replace the probe: the default derives the bot id from the token prefix. */
  probe: (values: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<ChatBotIdentity> = (values) => {
    const token = values.token ?? ''
    if (token.startsWith('bad:')) return Promise.reject(new ChatAdapterError('auth-failed', 'stub', 'rejected'))
    if (token.startsWith('down:')) return Promise.reject(new ChatAdapterError('network', 'stub', 'down'))
    if (token.startsWith('odd:')) return Promise.reject(new Error(`the platform said token ${token} is odd`))
    const botId = token.slice(0, token.indexOf(':'))
    return Promise.resolve({ botId, displayName: `Bot ${botId}` })
  }

  readonly descriptor: ChatPlatformDescriptor = {
    platform: 'stub',
    label: '测试平台',
    fields: [
      { key: 'token', label: '令牌', secret: true, required: true },
      { key: 'appId', label: '应用 ID', secret: false, required: false },
      { key: 'baseUrl', label: '服务地址', secret: false, required: false },
      { key: 'site', label: '站点', secret: false, required: false, options: [{ value: 'cn', label: '中国' }, { value: 'intl', label: '国际' }] },
    ],
    probe: (values, signal) => {
      this.probes.push({ ...values })
      return this.probe(values, signal)
    },
    mount: async (ctx: Context, bot: ChatManagedBot) => {
      this.mounts.push(bot)
      await this.gate
      const token = await ctx.credentials.resolve(credentialRef(bot.secretRefs.token!))
      if (token === undefined) throw new Error('the token credential is unset')
      const botId = token.value.slice(0, token.value.indexOf(':'))
      if (this.failMount.has(botId)) throw new Error(`mount refused for ${botId}`)
      const adapter = new ScriptedAdapter(botId, () => this.scripts.get(botId) ?? 'running')
      this.adapters.add(adapter)
      ctx.effect(() => {
        const dispose = ctx.chatAdapters.register(adapter)
        return () => {
          this.adapters.delete(adapter)
          dispose()
        }
      })
    },
  }

  /** The function plugin that registers this platform. */
  get plugin(): { name: string; inject: string[]; apply(ctx: Context): void } {
    const descriptor = this.descriptor
    return {
      name: 'stub-platform',
      inject: ['chatAdapters'],
      apply(ctx) {
        ctx.effect(() => ctx.chatAdapters.registerPlatform(descriptor))
      },
    }
  }
}
