/** Bridge infrastructure and per-bot lifecycle: state mapping, isolation, on-demand start, startup, and disposal. */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listAuthenticationGrants } from '@deepseek-ai/dsh-authentication-local'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { ChatBotError } from '../src/index.ts'
import type { ChatBotView } from '../src/index.ts'
import { seedOwner } from './fixtures/owner.ts'
import { stubs } from './fixtures/stub-bridge.ts'
import { boot, type World } from './fixtures/world.ts'

vi.mock('@deepseek-ai/dsh-chat-bridge', async () => (await import('./fixtures/stub-bridge.ts')).bridgeModule)
vi.mock('@deepseek-ai/dsh-chat-harniverse-client', async importOriginal =>
  (await import('./fixtures/stub-bridge.ts')).clientModule(await importOriginal<Record<string, unknown>>()))

const token = (id: number): string => `${String(id)}:ZZSECRETZZ-0123456789abcdef`
const signal = (): AbortSignal => new AbortController().signal

let world: World | undefined

afterEach(async () => {
  await world?.close()
  world = undefined
  stubs.reset()
  vi.restoreAllMocks()
})

async function up(options?: Parameters<typeof boot>[0]): Promise<World> {
  world = await boot(options)
  return world
}

const add = (w: World, id = 111): Promise<ChatBotView> => w.manager.addBot({ platform: 'stub', values: { token: token(id) } }, signal())

async function view(w: World, id: string): Promise<ChatBotView> {
  const bot = (await w.manager.snapshot()).bots.find(candidate => candidate.id === id)
  if (bot === undefined) throw new Error('bot missing from the snapshot')
  return bot
}

/** Assert a bot is in `error` and its message names the cause. */
function expectError(bot: ChatBotView, message: string): void {
  expect(bot.state).toBe('error')
  expect(bot.message).toContain(message)
}

async function reason(promise: Promise<unknown>): Promise<{ reason: string; message: string }> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ChatBotError)
  return { reason: (remoteErrorOf(error)?.details as { reason: string }).reason, message: (error as Error).message }
}

describe('bot state', () => {
  it('maps every adapter run state the bridge reports', async () => {
    const w = await up()
    const bot = await add(w)
    const key = 'stub:111'
    const states: Array<[{ state: string; message?: string } | undefined, string, string | undefined]> = [
      [{ state: 'running' }, 'online', undefined],
      [{ state: 'reconnecting', message: 'platform connection interrupted, reconnecting' }, 'reconnecting', '与平台的连接中断，正在重连'],
      [{ state: 'credential-rejected', message: 'the platform credential is invalid' }, 'error', '凭据被平台拒绝，请更新后重试'],
      [{ state: 'conflict', message: 'another instance is polling this bot' }, 'error', '另一个程序正在使用这个机器人（例如 `dsh chat` 或其他实例）'],
      [{ state: 'stopped' }, 'error', '机器人的连接已停止，请重试'],
      [undefined, 'starting', undefined],
    ]
    for (const [reported, state, message] of states) {
      if (reported === undefined) stubs.states.delete(key)
      else stubs.states.set(key, reported)
      const current = await view(w, bot.id)
      expect(current.state).toBe(state)
      if (message === undefined) expect(current).not.toHaveProperty('message')
      else expect(current.message).toBe(message)
    }
  })

  it('fails loudly on a bridge state this code does not know, rather than guessing one', async () => {
    const w = await up()
    await add(w)
    stubs.states.set('stub:111', { state: 'weird' })
    await expect(w.manager.snapshot()).rejects.toThrow('unexpected value')
  })

  it('reports a disabled bot as disabled and a failed mount as an error that leaves other bots untouched', async () => {
    const w = await up()
    w.platform.failMount.add('222')
    const healthy = await add(w, 111)
    const broken = await add(w, 222)
    expect(broken).toMatchObject({ state: 'error', message: '启动失败：凭据缺失或无效，请检查后重试' })
    expect(await view(w, healthy.id)).toMatchObject({ state: 'online' })
    expect(w.ctx.chatAdapters.get('stub', '222')).toBeUndefined()

    const disabled = await w.manager.updateBot({ id: healthy.id, enabled: false })
    expect(disabled).toMatchObject({ enabled: false, state: 'disabled' })
    expect(disabled).not.toHaveProperty('message')
  })

  it('reads a snapshot without waiting for a mutation, showing a bot that is mounting as starting', async () => {
    const w = await up()
    const first = await add(w, 111)
    const second = await add(w, 222)
    await w.manager.updateBot({ id: second.id, enabled: false })
    let release: (() => void) | undefined
    w.platform.gate = new Promise<void>((resolve) => { release = resolve })
    const enabling = w.manager.updateBot({ id: second.id, enabled: true })
    await vi.waitFor(() => { expect(w.platform.mounts).toHaveLength(3) })
    const snapshot = await w.manager.snapshot()
    expect(snapshot.bots.map(bot => [bot.id, bot.state])).toEqual([[first.id, 'online'], [second.id, 'starting']])
    release?.()
    expect(await enabling).toMatchObject({ state: 'online' })
  })

  it('reports an error for a bot whose platform provider is gone', async () => {
    const w = await up()
    const bot = await add(w)
    await w.withdrawPlatform()
    await w.manager.updateBot({ id: bot.id, enabled: false })
    expectError(await w.manager.updateBot({ id: bot.id, enabled: true }), '不可用')
  })

  it('retries a failed mount and a failed bridge start', async () => {
    const w = await up()
    w.platform.failMount.add('111')
    const bot = await add(w)
    expect(bot.state).toBe('error')
    w.platform.failMount.clear()
    expect(await w.manager.retryBot({ id: bot.id })).toMatchObject({ state: 'online' })
    expect(w.platform.mounts).toHaveLength(2)
    expect(w.platform.adapters.size).toBe(1)

    stubs.states.set('stub:111', { state: 'conflict' })
    expect(await view(w, bot.id)).toMatchObject({ state: 'error' })
    expect(await w.manager.retryBot({ id: bot.id })).toMatchObject({ state: 'online' })
    expect(w.platform.adapters.size).toBe(1)
  })

  it('refuses to retry a disabled or unknown bot', async () => {
    const w = await up()
    const bot = await add(w)
    await w.manager.updateBot({ id: bot.id, enabled: false })
    expect(await reason(w.manager.retryBot({ id: bot.id }))).toMatchObject({ reason: 'invalid-input' })
    expect(await reason(w.manager.retryBot({ id: 'bot_00000000' }))).toMatchObject({ reason: 'not-found' })
  })
})

describe('isolation between bots', () => {
  it('enables, disables, and removes one bot without touching another', async () => {
    const w = await up()
    const first = await add(w, 111)
    const second = await add(w, 222)
    expect(w.platform.adapters.size).toBe(2)

    await w.manager.updateBot({ id: first.id, enabled: false })
    expect(w.ctx.chatAdapters.get('stub', '111')).toBeUndefined()
    expect(w.ctx.chatAdapters.get('stub', '222')).toBeDefined()
    expect((await w.manager.snapshot()).bridge).toBe('running')

    await w.manager.updateBot({ id: first.id, enabled: true })
    expect(w.ctx.chatAdapters.get('stub', '111')).toBeDefined()
    expect(stubs.bridges).toHaveLength(1)

    await w.manager.removeBot({ id: first.id })
    expect(w.ctx.chatAdapters.get('stub', '111')).toBeUndefined()
    expect(w.ctx.chatAdapters.get('stub', '222')).toBeDefined()
    expect((await w.manager.snapshot()).bots.map(bot => bot.id)).toEqual([second.id])
    expect(w.credentials.values.has(`DSH_CHAT_BOT_${first.id.toUpperCase()}_TOKEN`)).toBe(false)
    expect(w.credentials.values.has(`DSH_CHAT_BOT_${second.id.toUpperCase()}_TOKEN`)).toBe(true)
  })

  it('tears the bridge down in order when the last enabled bot goes, and starts it again on demand', async () => {
    const w = await up()
    const bot = await add(w)
    expect(stubs.order).toEqual(['client up', 'bridge up'])
    await w.manager.updateBot({ id: bot.id, enabled: false })
    expect(stubs.order).toEqual(['client up', 'bridge up', 'bridge down', 'client down'])
    expect(w.ctx.get('chatBridge')).toBeUndefined()
    expect((await w.manager.snapshot()).bridge).toBe('stopped')
    await w.manager.updateBot({ id: bot.id, enabled: true })
    expect(stubs.order.slice(4)).toEqual(['client up', 'bridge up'])
    expect((await w.manager.snapshot()).bridge).toBe('running')

    await w.manager.removeBot({ id: bot.id })
    expect(w.ctx.get('chatBridge')).toBeUndefined()
    expect(await w.manager.snapshot()).toMatchObject({ bots: [], bridge: 'stopped' })
  })

  it('keeps the entry and still unmounts when a credential cannot be deleted', async () => {
    const w = await up()
    const bot = await add(w)
    w.credentials.failUnset = /_TOKEN$/u
    await expect(w.manager.removeBot({ id: bot.id })).rejects.toThrow('cannot remove')
    expect((await w.manager.snapshot()).bots.map(entry => entry.id)).toEqual([bot.id])
    expect(w.platform.adapters.size).toBe(1)
    w.credentials.failUnset = undefined
    await w.manager.removeBot({ id: bot.id })
    expect((await w.manager.snapshot()).bots).toEqual([])
    expect(await reason(w.manager.removeBot({ id: bot.id }))).toMatchObject({ reason: 'not-found' })
  })
})

describe('bot defaults', () => {
  it('registers one provider with the bridge that reads the registry live, by platform and bot id', async () => {
    const w = await up()
    const bot = await add(w)
    const [provider, ...others] = [...stubs.providers]
    expect(others).toEqual([])
    expect(provider!('stub', '111')).toBeUndefined()

    const workspace = join(tmpdir(), 'ws')
    await w.manager.updateBot({ id: bot.id, settings: { workspace, agentProfile: 'code', model: { provider: 'p', model: 'm' } } })
    expect(provider!('stub', '111')).toEqual({ workspace, agentProfile: 'code', model: { provider: 'p', model: 'm' } })
    expect(provider!('stub', '999')).toBeUndefined()
    expect(provider!('other', '111')).toBeUndefined()

    await w.manager.updateBot({ id: bot.id, settings: { workspace: null, agentProfile: null, model: null } })
    expect(provider!('stub', '111')).toBeUndefined()
  })

  it('withdraws the provider with the bridge', async () => {
    const w = await up()
    const bot = await add(w)
    expect(stubs.providers.size).toBe(1)
    await w.manager.updateBot({ id: bot.id, enabled: false })
    expect(stubs.providers.size).toBe(0)
  })
})

describe('owner operations', () => {
  it('start the bridge on demand with no bot, and it stays up until a bot has come and gone', async () => {
    const w = await up()
    expect(await w.manager.issueOwnerCode()).toEqual({ code: 'CODE1', expiresAt: 1_800_000_000_000 })
    expect((await w.manager.snapshot()).bridge).toBe('running')
    expect(stubs.bridges).toHaveLength(1)
    expect(await w.manager.issueOwnerCode()).toMatchObject({ code: 'CODE2' })
    expect(stubs.bridges).toHaveLength(1)

    const bot = await add(w)
    expect(stubs.bridges).toHaveLength(1)
    await w.manager.updateBot({ id: bot.id, enabled: false })
    expect((await w.manager.snapshot()).bridge).toBe('stopped')
  })

  it('stay up across an unrelated change while demanded with no enabled bot', async () => {
    const w = await up()
    const bot = await add(w)
    await w.manager.updateBot({ id: bot.id, enabled: false })
    await w.manager.issueOwnerCode()
    await w.manager.updateBot({ id: bot.id, alias: 'still here' })
    expect((await w.manager.snapshot()).bridge).toBe('running')
  })

  it('list paired owners while the bridge runs and unpair one', async () => {
    const w = await up()
    stubs.owners.push({ key: 'stub:9', platform: 'stub', userId: '9', displayName: 'Dana', pairedAt: 5 }, { key: 'stub:1', platform: 'stub', userId: '1', pairedAt: 0 })
    expect((await w.manager.snapshot()).owners).toEqual([])
    await add(w)
    expect((await w.manager.snapshot()).owners).toEqual([
      { key: 'stub:9', platform: 'stub', userId: '9', displayName: 'Dana', pairedAt: 5 },
      { key: 'stub:1', platform: 'stub', userId: '1', pairedAt: 0 },
    ])
    expect(await w.manager.unpairOwner({ key: 'stub:9' })).toBe(true)
    expect(await w.manager.unpairOwner({ key: 'stub:9' })).toBe(false)
    expect((await w.manager.snapshot()).owners.map(owner => owner.key)).toEqual(['stub:1'])
  })

  it('unpairing starts the bridge on demand too', async () => {
    const w = await up()
    expect(await w.manager.unpairOwner({ key: 'stub:404' })).toBe(false)
    expect((await w.manager.snapshot()).bridge).toBe('running')
  })

  it('fail with bridge-unavailable and the reason when the bridge cannot start', async () => {
    const w = await up({ authentication: 'bypass' })
    const failed = await reason(w.manager.issueOwnerCode())
    expect(failed.reason).toBe('bridge-unavailable')
    expect(failed.message).toContain('旁路模式')
    expect(await reason(w.manager.unpairOwner({ key: 'stub:1' }))).toMatchObject({ reason: 'bridge-unavailable' })
  })
})

describe('bridge start failures', () => {
  it('without an authenticated instance, shows every enabled bot as an error and starts nothing', async () => {
    const w = await up({ authentication: 'bypass' })
    const bot = await add(w)
    expectError(bot, '旁路模式')
    const snapshot = await w.manager.snapshot()
    expect(snapshot.bridge).toBe('error')
    expect(snapshot.bridgeMessage).toContain('Grant')
    expect(stubs.clients).toEqual([])
    expect(w.credentials.values.has('DSH_CHAT_BRIDGE_SIGNING')).toBe(false)
  })

  it('without an owner Grant, asks for the device login and recovers on retry', async () => {
    const w = await up({ owner: false })
    const bot = await add(w)
    expectError(bot, '设备登录')
    await seedOwner(w.dshHome, 'owner')
    expect(await w.manager.retryBot({ id: bot.id })).toMatchObject({ state: 'online' })
    expect((await w.manager.snapshot()).bridge).toBe('running')
  })

  it('reports a generic bridge message and logs the cause when a bridge plugin throws', async () => {
    const w = await up()
    const warn = vi.spyOn(w.ctx.logger, 'warn').mockImplementation(() => undefined)
    stubs.failBridge = new Error('bridge exploded with detail')
    const bot = await add(w)
    expect(bot).toMatchObject({ state: 'error', message: 'IM 桥接启动失败，详情见主机日志' })
    expect(warn).toHaveBeenCalledWith(stubs.failBridge)
    expect(stubs.order).toEqual(['client up', 'client down'])
    stubs.failBridge = undefined
    expect(await w.manager.retryBot({ id: bot.id })).toMatchObject({ state: 'online' })
  })

  it('unwinds when the client plugin throws, and when the bridge mounts without publishing its service', async () => {
    const w = await up()
    stubs.failClient = new Error('client exploded')
    const bot = await add(w)
    expect(bot.state).toBe('error')
    expect(stubs.order).toEqual([])
    stubs.failClient = undefined
    stubs.silentBridge = true
    expect(await w.manager.retryBot({ id: bot.id })).toMatchObject({ state: 'error', message: 'IM 桥接启动失败，详情见主机日志' })
    expect(stubs.order).toEqual(['client up', 'bridge up', 'bridge down', 'client down'])
    stubs.silentBridge = false
    expect(await w.manager.retryBot({ id: bot.id })).toMatchObject({ state: 'online' })
  })
})

describe('grant provisioning at the service level', () => {
  it('reuses the key and Grant across host restarts and across bridge restarts', async () => {
    const w = await up()
    const bot = await add(w)
    await w.manager.updateBot({ id: bot.id, enabled: false })
    await w.manager.updateBot({ id: bot.id, enabled: true })
    const grants = (await listAuthenticationGrants({ dshHome: w.dshHome })).filter(grant => grant.name.startsWith('chat-bridge'))
    expect(grants).toHaveLength(1)

    const { dshHome, credentials } = w
    await w.ctx.fiber.dispose()
    const again = await boot({ dshHome, owner: false, credentials: Object.fromEntries(credentials.values) })
    try {
      expect(again.credentials.calls).toEqual([])
      expect((await listAuthenticationGrants({ dshHome })).filter(grant => grant.name.startsWith('chat-bridge'))).toHaveLength(1)
    } finally {
      await again.ctx.fiber.dispose()
    }
    world = undefined
    await import('node:fs/promises').then(({ rm }) => rm(dshHome, { recursive: true, force: true }))
  })
})

describe('origin', () => {
  it('reaches an HTTPS server by localhost on its assigned port', async () => {
    const w = await up({ server: { port: 8443, protocol: 'https:' } })
    await add(w)
    expect(stubs.clients).toEqual([{ origin: 'https://localhost:8443' }])
  })
})

describe('startup and disposal', () => {
  const record = (id: string, botId: string, enabled: boolean): Record<string, unknown> => ({
    id, platform: 'stub', alias: `Bot ${botId}`, identity: { botId, displayName: `Bot ${botId}` }, values: {}, secretKeys: ['token'],
    enabled, settings: { agentProfile: 'code' }, createdAt: 1_700_000_000_000,
  })

  it('mounts the enabled bots recorded in the registry at boot and leaves disabled ones alone', async () => {
    const w = await up({
      registry: JSON.stringify({ version: 1, bots: [record('bot_aaaaaaaa', '111', true), record('bot_bbbbbbbb', '222', false)] }),
      credentials: {
        DSH_CHAT_BOT_BOT_AAAAAAAA_TOKEN: token(111),
        DSH_CHAT_BOT_BOT_BBBBBBBB_TOKEN: token(222),
      },
    })
    expect(stubs.order).toEqual(['client up', 'bridge up'])
    expect([...w.platform.adapters].map(adapter => adapter.botId)).toEqual(['111'])
    const snapshot = await w.manager.snapshot()
    expect(snapshot.bridge).toBe('running')
    expect(snapshot.bots.map(bot => [bot.id, bot.state, bot.settings])).toEqual([
      ['bot_aaaaaaaa', 'online', { agentProfile: 'code' }],
      ['bot_bbbbbbbb', 'disabled', { agentProfile: 'code' }],
    ])
    expect([...stubs.providers][0]!('stub', '111')).toEqual({ agentProfile: 'code' })
  })

  it('starts nothing at boot when no bot is enabled', async () => {
    const w = await up({ registry: JSON.stringify({ version: 1, bots: [record('bot_aaaaaaaa', '111', false)] }) })
    expect(stubs.order).toEqual([])
    expect((await w.manager.snapshot()).bridge).toBe('stopped')
  })

  it('refuses to start over a corrupt registry, naming the file and never its content', async () => {
    const error = await boot({ registry: '{"version":1,"bots":[{"token":"ZZSECRETZZ"}]}' }).then(() => undefined, (caught: unknown) => caught as Error)
    expect(error?.message).toContain('chat-bots.json')
    expect(error?.message).not.toContain('ZZSECRETZZ')
  })

  it('leaves no adapter, fiber, or service behind when the plugin scope is disposed', async () => {
    const w = await up()
    await add(w, 111)
    await add(w, 222)
    const registry = w.ctx.chatAdapters
    expect(registry.list()).toHaveLength(2)
    await w.ctx.fiber.dispose()
    expect(registry.list()).toEqual([])
    expect(w.platform.adapters.size).toBe(0)
    expect(w.ctx.get('chatBridge')).toBeUndefined()
    expect(w.ctx.get('chatManager')).toBeUndefined()
    expect(stubs.order.slice(-2)).toEqual(['bridge down', 'client down'])
    expect(stubs.providers.size).toBe(0)
  })
})
