/**
 * Lifecycle of the embedded chat bridge and of the bots mounted on it.
 *
 * The bridge infrastructure — the `chat-harniverse-client` and `chat-bridge`
 * plugins, in that order — is a pair of child plugin fibers of the manager.
 * Each enabled bot is one more child fiber whose body is the platform
 * descriptor's `mount`, so disposing the fiber unregisters that bot's adapter
 * without touching another. Teardown is explicit and ordered: bots, then the
 * bridge, then the client.
 * @module @deepseek-ai/dsh-chat-manager/supervisor
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as ChatBridge from '@deepseek-ai/dsh-chat-bridge'
import type { ChatBotSettings, ChatBridgeService } from '@deepseek-ai/dsh-chat-bridge'
import HarniverseClient from '@deepseek-ai/dsh-chat-harniverse-client'
import { BridgeUnavailableError } from './errors.ts'
import { ensureBridgeGrant } from './grant.ts'
import { assertNever } from './never.ts'
import { embeddedOrigin } from './origin.ts'
import type { BotRecord } from './registry.ts'
import { secretRefs } from './secrets.ts'
import type { ChatBotState, ChatBridgeStatus } from './types.ts'

/** What the supervisor needs from the manager. */
export interface SupervisorHost {
  ctx: Context
  /** Harness home of the authentication provider whose Grant registry receives the bridge Grant. */
  dshHome: string
  /** Live per-bot defaults for new owner sessions. */
  settingsFor(platform: string, botId: string): ChatBotSettings | undefined
}

/** The reported state of one bot. */
export interface BotStateView {
  state: ChatBotState
  message?: string
}

/** The embedded bridge's reported state; `message` is a Chinese explanation of `error`, empty otherwise. */
export interface BridgeStateView {
  bridge: ChatBridgeStatus
  message: string
}

interface Infra {
  client: Fiber
  bridge?: Fiber
  releaseSettings?: () => void
}

/** A bot's mount: the live fiber with the bridge it runs on, or why mounting failed. */
type BotRuntime =
  | { fiber: Fiber; service: ChatBridgeService; error?: undefined }
  | { fiber?: undefined; service?: undefined; error: string }

/** Reasons shown for the adapter states the bridge reports. */
const ADAPTER_MESSAGES = {
  reconnecting: '与平台的连接中断，正在重连',
  rejected: '凭据被平台拒绝，请更新后重试',
  conflict: '另一个程序正在使用这个机器人（例如 `dsh chat` 或其他实例）',
  stopped: '机器人的连接已停止，请重试',
} as const

/** Owns the bridge infrastructure and the per-bot mounts. Callers serialize their calls. */
export class Supervisor {
  private status: BridgeStateView = { bridge: 'stopped', message: '' }
  private infra: Infra | undefined
  private readonly bots = new Map<string, BotRuntime>()
  private pinned = false

  constructor(private readonly host: SupervisorHost) {}

  /**
   * Read the embedded bridge's state.
   * @returns the state and, for `error`, a Chinese explanation.
   */
  bridge(): BridgeStateView {
    return this.status
  }

  /**
   * Read the bridge's management service.
   * @returns the service while the bridge runs, otherwise undefined.
   */
  service(): ChatBridgeService | undefined {
    return this.status.bridge === 'running' ? this.host.ctx.get('chatBridge') : undefined
  }

  /**
   * The reported state of one bot.
   * @param record - the bot.
   * @returns its state and, for `reconnecting` and `error`, a Chinese explanation.
   */
  stateOf(record: BotRecord): BotStateView {
    if (!record.enabled) return { state: 'disabled' }
    const runtime = this.bots.get(record.id)
    if (runtime?.error !== undefined) return { state: 'error', message: runtime.error }
    if (this.status.bridge === 'error') return { state: 'error', message: this.status.message }
    const reported = runtime?.service.adapterState(record.platform, record.identity.botId)?.state
    switch (reported) {
      case undefined: return { state: 'starting' }
      case 'running': return { state: 'online' }
      case 'reconnecting': return { state: 'reconnecting', message: ADAPTER_MESSAGES.reconnecting }
      case 'credential-rejected': return { state: 'error', message: ADAPTER_MESSAGES.rejected }
      case 'conflict': return { state: 'error', message: ADAPTER_MESSAGES.conflict }
      case 'stopped': return { state: 'error', message: ADAPTER_MESSAGES.stopped }
      default: return assertNever(reported)
    }
  }

  /**
   * Bring the running set in line with the registry: unmount bots that are gone or disabled, start the bridge
   * when any bot is enabled (or an owner operation demands it), mount the enabled bots that are not mounted, and
   * tear the bridge down once no bot is enabled and nothing demands it. A bot whose mount failed stays failed
   * until {@link restart}.
   * @param records - every registered bot.
   * @param demand - an owner operation needs the bridge even with no enabled bot; the bridge then stays up until
   * a bot has been enabled and the last enabled bot later goes away, or the Host stops.
   */
  async sync(records: readonly BotRecord[], demand: boolean): Promise<void> {
    const enabled = records.filter(record => record.enabled)
    const wanted = new Set(enabled.map(record => record.id))
    for (const id of [...this.bots.keys()]) {
      if (!wanted.has(id)) await this.unmount(id)
    }
    if (enabled.length > 0) this.pinned = false
    else if (demand) this.pinned = true
    if (enabled.length === 0 && !this.pinned) {
      await this.stopInfra()
      return
    }
    const service = await this.ensureInfra()
    if (service === undefined) return
    for (const record of enabled) {
      if (!this.bots.has(record.id)) await this.mount(record, service)
    }
  }

  /**
   * Drop one bot's mount, including a failed one, so the next {@link sync} mounts it afresh.
   * @param id - bot id.
   */
  async restart(id: string): Promise<void> {
    await this.unmount(id)
  }

  /**
   * Stop one bot without touching the bridge or another bot.
   * @param id - bot id.
   */
  async stop(id: string): Promise<void> {
    await this.unmount(id)
  }

  /** Tear everything down in order: bots, the bridge, then its client. */
  async close(): Promise<void> {
    await this.stopInfra()
  }

  private async mount(record: BotRecord, service: ChatBridgeService): Promise<void> {
    const { ctx } = this.host
    const descriptor = ctx.chatAdapters.platform(record.platform)
    if (descriptor === undefined) {
      this.bots.set(record.id, { error: '该平台当前不可用，请检查对应插件是否已启用' })
      return
    }
    const bot = { values: record.values, secretRefs: secretRefs(record.id, record.secretKeys) }
    const fiber = ctx.plugin({ name: `chat-manager:${record.id}`, apply: (botCtx: Context) => descriptor.mount(botCtx, bot) })
    try {
      await fiber.await()
      this.bots.set(record.id, { fiber, service })
    } catch (error) {
      ctx.logger.warn(`chat-manager: mounting ${record.platform} bot ${record.id} failed`)
      ctx.logger.warn(error)
      await fiber.dispose()
      this.bots.set(record.id, { error: '启动失败：凭据缺失或无效，请检查后重试' })
    }
  }

  private async unmount(id: string): Promise<void> {
    const runtime = this.bots.get(id)
    this.bots.delete(id)
    await runtime?.fiber?.dispose()
  }

  /** @returns the running bridge's service, starting the bridge first when it is not up; undefined when it cannot start. */
  private async ensureInfra(): Promise<ChatBridgeService | undefined> {
    const { ctx } = this.host
    if (this.status.bridge === 'running') return this.service()
    this.status = { bridge: 'starting', message: '' }
    const infra: Partial<Infra> = {}
    try {
      if (ctx.authentication.mode === 'bypass') {
        throw new BridgeUnavailableError('身份验证处于旁路模式，IM 机器人需要启用 Grant 验证后才能使用')
      }
      await ensureBridgeGrant(ctx.credentials, { dshHome: this.host.dshHome })
      infra.client = ctx.plugin(HarniverseClient, { origin: embeddedOrigin(ctx.webServer) })
      await infra.client.await()
      infra.bridge = ctx.plugin(ChatBridge, { embedded: true })
      await infra.bridge.await()
      const service = ctx.get('chatBridge')
      if (service === undefined) throw new Error('the chat bridge mounted without publishing ctx.chatBridge')
      infra.releaseSettings = service.useBotSettings((platform, botId) => this.host.settingsFor(platform, botId))
      this.infra = infra as Infra
      this.status = { bridge: 'running', message: '' }
      return service
    } catch (error) {
      ctx.logger.warn('chat-manager: the embedded bridge failed to start')
      ctx.logger.warn(error)
      await this.disposeInfra(infra)
      this.status = {
        bridge: 'error',
        message: error instanceof BridgeUnavailableError ? error.message : 'IM 桥接启动失败，详情见主机日志',
      }
      return undefined
    }
  }

  private async stopInfra(): Promise<void> {
    for (const id of [...this.bots.keys()]) await this.unmount(id)
    const infra = this.infra
    this.infra = undefined
    if (infra !== undefined) await this.disposeInfra(infra)
    this.status = { bridge: 'stopped', message: '' }
  }

  private async disposeInfra(infra: Partial<Infra>): Promise<void> {
    infra.releaseSettings?.()
    await infra.bridge?.dispose()
    await infra.client?.dispose()
  }
}
