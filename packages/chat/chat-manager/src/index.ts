/**
 * Host-side manager of IM chat bots (`ctx.chatManager`, Remote namespace
 * `chatBots`). It owns the managed-bot registry (`$DSH_HOME/chat-bots.json`),
 * the write-only bot secrets in the credential store, and the lifecycle of the
 * chat bridge embedded in this process: the bridge infrastructure starts when
 * a bot is enabled (or an owner operation needs it), and each enabled bot is
 * one child plugin fiber mounted through its platform descriptor. A Settings
 * page drives it through the Remote methods below; `snapshot` is the only read.
 * @module @deepseek-ai/dsh-chat-manager
 */

import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  ChatAdapterError, type ChatBotIdentity, type ChatPlatformDescriptor,
} from '@deepseek-ai/dsh-chat-adapter'
import type { ChatBotSettings } from '@deepseek-ai/dsh-chat-bridge'
import type {} from '@deepseek-ai/dsh-authentication'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ChatBotError } from './errors.ts'
import { BotRegistry, MAX_BOTS, type BotRecord } from './registry.ts'
import { readSecrets, removeSecrets, secretView, storeSecrets } from './secrets.ts'
import { Supervisor } from './supervisor.ts'
import type {
  AddChatBotInput, ChatBotIdInput, ChatBotModelView, ChatBotsSnapshot, ChatBotSettingsPatch, ChatBotSettingsView,
  ChatBotView, ChatOwnerCode, CheckChatBotResult, UnpairOwnerInput, UpdateChatBotInput,
} from './types.ts'

export type {
  AddChatBotInput, ChatBotErrorCode, ChatBotFailure, ChatBotIdInput, ChatBotModelView, ChatBotSecretView,
  ChatBotSettingsPatch, ChatBotSettingsView, ChatBotState, ChatBotsSnapshot, ChatBotView, ChatBridgeStatus,
  ChatOwnerCode, ChatOwnerView, ChatPlatformField, ChatPlatformView, CheckChatBotResult, UnpairOwnerInput,
  UpdateChatBotInput,
} from './types.ts'
export { BridgeUnavailableError, ChatBotError } from './errors.ts'
export { GRANT_CAPABILITIES, GRANT_NAME } from './grant.ts'
export { MAX_BOTS, type BotRecord } from './registry.ts'
export { secretRef } from './secrets.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The chat-bot manager; the `chatBots` Remote is its client-facing face. */
    chatManager: ChatManager
  }
}

/** Plugin configuration. */
export interface Config {
  /** Harness home holding `chat-bots.json` and the authentication Grant registry; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Longest a platform probe may take before the bot counts as unreachable. */
const PROBE_TIMEOUT_MS = 15_000

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u

const PLATFORM_UNAVAILABLE = '该平台当前不可用，请检查对应插件是否已启用'

/** A failed probe, classified. */
interface ProbeFailure {
  reason: 'invalid-credentials' | 'unreachable'
  message: string
}

/**
 * Classify a platform probe failure into a stable reason and a safe Chinese sentence.
 * @param error - what the descriptor's probe rejected with.
 * @returns the reason and message; neither carries the platform's own text.
 */
function classifyProbeFailure(error: unknown): ProbeFailure {
  if (error instanceof ChatAdapterError && error.code === 'auth-failed') {
    return { reason: 'invalid-credentials', message: '平台拒绝了这些凭据，请检查后重试' }
  }
  return { reason: 'unreachable', message: '无法连接到平台，请检查网络或地址后重试' }
}

function invalid(message: string): ChatBotError {
  return new ChatBotError('invalid-input', message)
}

function parseAlias(value: string): string {
  const alias = value.trim()
  if (alias.length < 1 || alias.length > 64 || CONTROL_CHARACTERS.test(alias)) throw invalid('别名需为 1 到 64 个字符，且不含控制字符')
  return alias
}

function parseText(value: string, max: number, label: string): string {
  const text = value.trim()
  if (text.length < 1 || text.length > max || CONTROL_CHARACTERS.test(text)) throw invalid(`${label}需为 1 到 ${String(max)} 个字符，且不含控制字符`)
  return text
}

function parseModel(value: ChatBotModelView): ChatBotModelView {
  const model: ChatBotModelView = { provider: parseText(value.provider, 256, '模型提供方'), model: parseText(value.model, 256, '模型') }
  if (value.reasoningEffort !== undefined) model.reasoningEffort = parseText(value.reasoningEffort, 64, '推理强度')
  return model
}

/**
 * Apply a settings patch: a value replaces, `null` clears, an absent key keeps.
 * @param current - the stored settings.
 * @param patch - the requested change.
 * @returns the new settings.
 */
function applySettings(current: ChatBotSettingsView, patch: ChatBotSettingsPatch): ChatBotSettingsView {
  const next: ChatBotSettingsView = { ...current }
  if (patch.workspace === null) delete next.workspace
  else if (patch.workspace !== undefined) {
    const workspace = parseText(patch.workspace, 4096, '工作区路径')
    if (!isAbsolute(workspace)) throw invalid('工作区路径必须是绝对路径')
    next.workspace = workspace
  }
  if (patch.model === null) delete next.model
  else if (patch.model !== undefined) next.model = parseModel(patch.model)
  if (patch.agentProfile === null) delete next.agentProfile
  else if (patch.agentProfile !== undefined) next.agentProfile = parseText(patch.agentProfile, 128, 'Agent Preset')
  return next
}

/**
 * Whether a typed address is an `http:` or `https:` URL without embedded credentials, which a non-secret field would show back.
 * @param value - the typed address.
 * @returns true for a plain http(s) address.
 */
function isPlainHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
}

/** The typed field values of one add request, split by whether they are secret. */
interface FieldValues {
  values: Record<string, string>
  secrets: Record<string, string>
}

/**
 * Validate typed values against a platform's declared fields and split off the secrets.
 * @param descriptor - the platform.
 * @param input - the typed values by field key.
 * @returns trimmed non-secret values and trimmed secret values; blank optional fields are omitted.
 */
function splitFields(descriptor: ChatPlatformDescriptor, input: Readonly<Record<string, string>>): FieldValues {
  const known = new Set(descriptor.fields.map(field => field.key))
  if (Object.keys(input).some(key => !known.has(key))) throw invalid('包含该平台不支持的字段')
  const fields: FieldValues = { values: {}, secrets: {} }
  for (const field of descriptor.fields) {
    const typed = (input[field.key] ?? '').trim()
    if (typed === '') {
      if (field.required) throw invalid(`请填写「${field.label}」`)
      continue
    }
    if (typed.length > 4096 || CONTROL_CHARACTERS.test(typed)) throw invalid(`「${field.label}」过长或包含无效字符`)
    if (field.options !== undefined && !field.options.some(option => option.value === typed)) throw invalid(`「${field.label}」的取值不在可选范围内`)
    if (!field.secret && field.key.endsWith('Url') && !isPlainHttpUrl(typed)) {
      throw invalid(`「${field.label}」必须是 http 或 https 地址，且不含用户名和密码`)
    }
    if (field.secret) fields.secrets[field.key] = typed
    else fields.values[field.key] = typed
  }
  return fields
}

/**
 * The chat-bot manager. Mutations and the owner operations run one at a time;
 * `snapshot` reads without waiting for them.
 */
export class ChatManager extends TypertRemoteService {
  static inject = ['chatAdapters', 'credentials', 'webServer', 'authentication', 'storageDomain']
  static Config: z<Config> = z.object({ dshHome: z.string() })

  private readonly registry: BotRegistry
  private readonly supervisor: Supervisor
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'chatManager', { namespace: 'chatBots' })
    const dshHome = resolveDshHome(config.dshHome)
    this.registry = new BotRegistry(dshHome)
    this.supervisor = new Supervisor({ ctx, dshHome, settingsFor: (platform, botId) => this.settingsFor(platform, botId) })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => {
      await this.queue
      await this.supervisor.close()
    }
    await this.registry.load()
    await this.serial(() => this.supervisor.sync(this.registry.list(), false))
  }

  /**
   * Everything the Settings page renders: the connectable platforms, every bot with its live state, the paired
   * owners, and the embedded bridge's state. Owners are listed only while the bridge runs.
   * @returns the snapshot; it carries no secret value.
   */
  @Remote({ requiredCapability: 'harniverse.observe' })
  async snapshot(): Promise<ChatBotsSnapshot> {
    const owners = this.supervisor.service()?.owners() ?? []
    const { bridge, message } = this.supervisor.bridge()
    return {
      platforms: this.ctx.chatAdapters.platforms().map(({ platform, label, fields }) => (
        { platform, label, fields: structuredClone([...fields]) }
      )),
      bots: await Promise.all(this.registry.list().map(record => this.view(record))),
      owners: owners.map(owner => ({ ...owner })),
      bridge,
      ...message === '' ? {} : { bridgeMessage: message },
    }
  }

  /**
   * Validate a bot's fields, verify them with one platform call, store its secrets, register it, and start it.
   * @param input - platform, optional alias, and the typed field values.
   * @param signal - request cancellation.
   * @returns the new bot; a failed start is reported in its `state`.
   * @throws {ChatBotError} `invalid-input`, `invalid-credentials`, `unreachable`, or `duplicate-bot`.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async addBot(input: AddChatBotInput, signal: AbortSignal): Promise<ChatBotView> {
    const descriptor = this.ctx.chatAdapters.platform(input.platform)
    if (descriptor === undefined) throw invalid('不支持的平台')
    const fields = splitFields(descriptor, input.values)
    const alias = input.alias === undefined ? undefined : parseAlias(input.alias)
    const identity = await this.probe(descriptor, { ...fields.values, ...fields.secrets }, signal)
    return this.serial(async () => {
      const bots = this.registry.list()
      if (bots.length >= MAX_BOTS) throw invalid(`最多添加 ${String(MAX_BOTS)} 个机器人`)
      if (bots.some(bot => bot.platform === input.platform && bot.identity.botId === identity.botId)) {
        throw new ChatBotError('duplicate-bot', '这个机器人已经添加过了')
      }
      let id = ''
      do id = `bot_${randomBytes(4).toString('hex')}`; while (bots.some(bot => bot.id === id))
      const record: BotRecord = {
        id,
        platform: input.platform,
        alias: alias ?? identity.displayName.slice(0, 64),
        identity: { botId: identity.botId, displayName: identity.displayName },
        values: fields.values,
        secretKeys: Object.keys(fields.secrets),
        enabled: true,
        settings: {},
        createdAt: Date.now(),
      }
      await storeSecrets(this.ctx.credentials, id, fields.secrets)
      try {
        await this.registry.put(record)
      } catch (error) {
        await removeSecrets(this.ctx.credentials, id, record.secretKeys)
        throw error
      }
      await this.supervisor.sync(this.registry.list(), false)
      return this.view(record)
    })
  }

  /**
   * Change a bot's alias, enabled flag, or defaults for new owner sessions. Defaults apply to sessions created
   * afterwards without restarting the bot; enabling or disabling mounts or unmounts only this bot.
   * @param input - the bot id and the fields to change.
   * @returns the updated bot.
   * @throws {ChatBotError} `not-found` or `invalid-input`.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  updateBot(input: UpdateChatBotInput): Promise<ChatBotView> {
    return this.serial(async () => {
      const record = this.require(input.id)
      const next: BotRecord = { ...record }
      if (input.alias !== undefined) next.alias = parseAlias(input.alias)
      if (input.enabled !== undefined) next.enabled = input.enabled
      if (input.settings !== undefined) next.settings = applySettings(record.settings, input.settings)
      await this.registry.put(next)
      await this.supervisor.sync(this.registry.list(), false)
      return this.view(next)
    })
  }

  /**
   * Verify a bot's stored credentials with one platform call and refresh its identity and check time.
   * @param input - the bot id.
   * @param signal - request cancellation.
   * @returns the outcome; a platform failure is `ok: false` with a safe message, never a thrown error.
   * @throws {ChatBotError} `not-found`.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  async checkBot(input: ChatBotIdInput, signal: AbortSignal): Promise<CheckChatBotResult> {
    const record = this.require(input.id)
    const outcome = await this.verify(record, signal)
    const checkedAt = Date.now()
    await this.serial(async () => {
      const current = this.registry.get(record.id)
      if (current === undefined) return
      await this.registry.put({
        ...current,
        checkedAt,
        ...outcome.displayName === undefined ? {} : { identity: { botId: current.identity.botId, displayName: outcome.displayName } },
      })
    })
    return { ok: outcome.message === undefined, ...outcome.message === undefined ? {} : { message: outcome.message }, checkedAt }
  }

  /**
   * Remount an enabled bot that is in `error` or `reconnecting`; a failed bridge start is attempted again too.
   * @param input - the bot id.
   * @returns the bot after the attempt.
   * @throws {ChatBotError} `not-found`, or `invalid-input` for a disabled bot.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  retryBot(input: ChatBotIdInput): Promise<ChatBotView> {
    return this.serial(async () => {
      const record = this.require(input.id)
      if (!record.enabled) throw invalid('机器人已停用，请先启用')
      await this.supervisor.restart(record.id)
      await this.supervisor.sync(this.registry.list(), false)
      return this.view(record)
    })
  }

  /**
   * Unmount a bot, delete its credentials, and remove it from the registry. The embedded bridge stops with the
   * last enabled bot.
   * @param input - the bot id.
   * @throws {ChatBotError} `not-found`.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  removeBot(input: ChatBotIdInput): Promise<void> {
    return this.serial(async () => {
      const record = this.require(input.id)
      await this.supervisor.stop(record.id)
      try {
        await removeSecrets(this.ctx.credentials, record.id, record.secretKeys)
        await this.registry.remove(record.id)
      } finally {
        await this.supervisor.sync(this.registry.list(), false)
      }
    })
  }

  /**
   * Issue a one-time owner pairing code. The bridge starts on demand, because an owner needs a code before the
   * first bot is useful, and it then runs until a later change finds no enabled bot.
   * @returns the plaintext code, shown once, and its expiry.
   * @throws {ChatBotError} `bridge-unavailable` when the bridge cannot start.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  issueOwnerCode(): Promise<ChatOwnerCode> {
    return this.serial(async () => (await this.demandBridge()).issueOwnerCode())
  }

  /**
   * Remove a paired owner. The bridge starts on demand like {@link issueOwnerCode}.
   * @param input - the owner key from the snapshot.
   * @returns false when the key is absent or belongs to an owner of the static configuration.
   * @throws {ChatBotError} `bridge-unavailable` when the bridge cannot start.
   */
  @Remote({ requiredCapability: 'harniverse.administer' })
  unpairOwner(input: UnpairOwnerInput): Promise<boolean> {
    return this.serial(async () => (await this.demandBridge()).unpairOwner(input.key))
  }

  private async demandBridge(): Promise<NonNullable<ReturnType<Supervisor['service']>>> {
    await this.supervisor.sync(this.registry.list(), true)
    const bridge = this.supervisor.service()
    if (bridge === undefined) throw new ChatBotError('bridge-unavailable', this.supervisor.bridge().message)
    return bridge
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(operation)
    this.queue = work.catch(() => {})
    return work
  }

  private require(id: string): BotRecord {
    const record = this.registry.get(id)
    if (record === undefined) throw new ChatBotError('not-found', '找不到这个机器人')
    return record
  }

  private async probe(descriptor: ChatPlatformDescriptor, values: Record<string, string>, signal: AbortSignal): Promise<ChatBotIdentity> {
    try {
      return await descriptor.probe(values, AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]))
    } catch (error) {
      signal.throwIfAborted()
      const failure = classifyProbeFailure(error)
      throw new ChatBotError(failure.reason, failure.message)
    }
  }

  /** Probe a stored bot; a failure is the returned `message`, a success may refresh the display name. */
  private async verify(record: BotRecord, signal: AbortSignal): Promise<{ message?: string; displayName?: string }> {
    const descriptor = this.ctx.chatAdapters.platform(record.platform)
    if (descriptor === undefined) return { message: PLATFORM_UNAVAILABLE }
    const secrets = await readSecrets(this.ctx.credentials, record.id, record.secretKeys)
    if (record.secretKeys.some(key => secrets[key] === undefined)) return { message: '凭据缺失，请删除后重新添加' }
    let identity: ChatBotIdentity
    try {
      identity = await this.probe(descriptor, { ...record.values, ...secrets }, signal)
    } catch (error) {
      if (error instanceof ChatBotError) return { message: error.message }
      throw error
    }
    if (identity.botId !== record.identity.botId) return { message: '凭据对应的机器人已变化，请删除后重新添加' }
    return { displayName: identity.displayName }
  }

  private settingsFor(platform: string, botId: string): ChatBotSettings | undefined {
    const record = this.registry.list().find(bot => bot.platform === platform && bot.identity.botId === botId)
    if (record === undefined || Object.keys(record.settings).length === 0) return undefined
    return record.settings
  }

  private async view(record: BotRecord): Promise<ChatBotView> {
    const stored = await readSecrets(this.ctx.credentials, record.id, record.secretKeys)
    const { state, message } = this.supervisor.stateOf(record)
    return {
      id: record.id,
      platform: record.platform,
      alias: record.alias,
      identity: { ...record.identity },
      values: { ...record.values },
      secrets: Object.fromEntries(record.secretKeys.map(key => [key, secretView(stored[key])])),
      enabled: record.enabled,
      state,
      ...message === undefined ? {} : { message },
      ...record.checkedAt === undefined ? {} : { checkedAt: record.checkedAt },
      settings: structuredClone(record.settings),
      createdAt: record.createdAt,
    }
  }
}

export default ChatManager
