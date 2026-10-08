/**
 * Stand-ins for the bridge plugin and the Harniverse client, installed with
 * `vi.mock` in the unit suites. They mirror the real seams the manager uses
 * (`ctx.harniverseClient`, `ctx.chatBridge`, the adapter registry events) and
 * expose what a test needs to script and observe; the Loader composition
 * suite runs the real packages instead.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ChatAdapter } from '@deepseek-ai/dsh-chat-adapter'

type SettingsProvider = (platform: string, botId: string) => unknown

interface OwnerRow {
  key: string
  platform: string
  userId: string
  displayName?: string
  pairedAt: number
}

/** Shared observable state of the stand-ins. */
export const stubs = {
  /** Config of every client mount. */
  clients: [] as Array<Record<string, unknown>>,
  /** Config of every bridge mount. */
  bridges: [] as Array<Record<string, unknown>>,
  /** Order in which the stand-ins mounted and unmounted. */
  order: [] as string[],
  /** Adapter status by `platform:botId`; set automatically when an adapter registers. */
  states: new Map<string, { state: string; message?: string }>(),
  providers: new Set<SettingsProvider>(),
  owners: [] as OwnerRow[],
  codes: 0,
  /** Make the next bridge mounts throw. */
  failBridge: undefined as Error | undefined,
  /** Make the next client mounts throw. */
  failClient: undefined as Error | undefined,
  /** Mount the bridge without publishing `ctx.chatBridge`. */
  silentBridge: false,
  reset(): void {
    this.clients.length = 0
    this.bridges.length = 0
    this.order.length = 0
    this.states.clear()
    this.providers.clear()
    this.owners.length = 0
    this.codes = 0
    this.failBridge = undefined
    this.failClient = undefined
    this.silentBridge = false
  },
}

const key = (adapter: ChatAdapter): string => `${adapter.platform}:${adapter.botId}`

/** Module shape of `@deepseek-ai/dsh-chat-bridge` as the manager mounts it. */
export const bridgeModule = {
  name: 'chat-bridge',
  inject: ['harniverseClient'],
  // vitest's mocked module throws on a key the factory does not define; Cordis reads these three off a plugin.
  Config: undefined,
  provide: undefined,
  intercept: undefined,
  apply(ctx: Context, config: Record<string, unknown>): void {
    if (stubs.failBridge !== undefined) throw stubs.failBridge
    stubs.bridges.push(config)
    stubs.order.push('bridge up')
    ctx.effect(() => () => { stubs.order.push('bridge down') })
    ctx.on('chat-adapter/registered', (adapter) => { stubs.states.set(key(adapter), { state: 'running' }) })
    ctx.on('chat-adapter/unregistered', (adapter) => { stubs.states.delete(key(adapter)) })
    if (stubs.silentBridge) return
    ctx.provide('chatBridge', {
      adapterState: (platform: string, botId: string) => stubs.states.get(`${platform}:${botId}`),
      issueOwnerCode: () => {
        stubs.codes += 1
        return Promise.resolve({ code: `CODE${String(stubs.codes)}`, expiresAt: 1_800_000_000_000 })
      },
      owners: () => stubs.owners,
      unpairOwner: (ownerKey: string) => {
        const index = stubs.owners.findIndex(owner => owner.key === ownerKey)
        if (index >= 0) stubs.owners.splice(index, 1)
        return Promise.resolve(index >= 0)
      },
      useBotSettings: (provider: SettingsProvider) => {
        stubs.providers.add(provider)
        return () => { stubs.providers.delete(provider) }
      },
    })
  },
}

/**
 * Replace the default export of the client module with a stand-in service.
 * @param actual - the real module, whose constants are kept.
 * @returns the mocked module.
 */
export function clientModule(actual: Record<string, unknown>): Record<string, unknown> {
  class StubClient extends Service {
    constructor(ctx: Context, config: Record<string, unknown>) {
      super(ctx, 'harniverseClient')
      if (stubs.failClient !== undefined) throw stubs.failClient
      stubs.clients.push(config)
      stubs.order.push('client up')
      ctx.effect(() => () => { stubs.order.push('client down') })
    }
  }
  return { ...actual, default: StubClient }
}
