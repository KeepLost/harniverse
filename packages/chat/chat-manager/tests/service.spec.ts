/** The `chatBots` Remote over scripted services: success and failure of every method, and what never leaves the host. */

import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listAuthenticationGrants } from '@deepseek-ai/dsh-authentication-local'
import { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ChatBotError, MAX_BOTS } from '../src/index.ts'
import type { ChatBotView, CheckChatBotResult, UpdateChatBotInput } from '../src/index.ts'
import { stubs } from './fixtures/stub-bridge.ts'
import { boot, type World } from './fixtures/world.ts'

vi.mock('@deepseek-ai/dsh-chat-bridge', async () => (await import('./fixtures/stub-bridge.ts')).bridgeModule)
vi.mock('@deepseek-ai/dsh-chat-harniverse-client', async importOriginal =>
  (await import('./fixtures/stub-bridge.ts')).clientModule(await importOriginal<Record<string, unknown>>()))

const SECRET = 'ZZSECRETZZ'
const TOKEN = `111:${SECRET}-0123456789abcdef`
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

function add(w: World, values: Record<string, string> = {}, alias?: string): Promise<ChatBotView> {
  return w.manager.addBot({ platform: 'stub', values: { token: TOKEN, ...values }, ...alias === undefined ? {} : { alias } }, signal())
}

/** Assert a check failed with a message that names the cause. */
function expectNotOk(result: CheckChatBotResult, message: string): void {
  expect(result.ok).toBe(false)
  expect(result.message).toContain(message)
}

/** Await a rejection and return it, asserting it is the manager's typed failure with the given reason. */
async function failure(promise: Promise<unknown>, reason: string, message?: string): Promise<ChatBotError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ChatBotError)
  const wire = remoteErrorOf(error)
  expect(wire).toMatchObject({ code: 'chat-bot-failed', details: { reason } })
  if (message !== undefined) expect(wire?.message).toContain(message)
  expect((error as Error).message).not.toContain(SECRET)
  return error as ChatBotError
}

describe('Remote declaration', () => {
  it('exposes the chatBots namespace with one observation and administrations for everything that stores, mounts, or pairs', async () => {
    const w = await up()
    expect(w.manager.typertRemote).toMatchObject({ serviceKey: 'chatManager', namespace: 'chatBots' })
    expect(Object.fromEntries(remoteMethods(w.manager).map(marker => [marker.method, marker.requiredCapability]))).toEqual({
      snapshot: 'harniverse.observe',
      addBot: 'harniverse.administer',
      updateBot: 'harniverse.administer',
      checkBot: 'harniverse.administer',
      retryBot: 'harniverse.administer',
      removeBot: 'harniverse.administer',
      issueOwnerCode: 'harniverse.administer',
      unpairOwner: 'harniverse.administer',
    })
  })
})

describe('snapshot', () => {
  it('lists the connectable platforms with detached field copies and reports a stopped bridge with no bots', async () => {
    const w = await up()
    const snapshot = await w.manager.snapshot()
    expect(snapshot).toEqual({
      platforms: [{ platform: 'stub', label: '测试平台', fields: w.platform.descriptor.fields }],
      bots: [],
      owners: [],
      bridge: 'stopped',
    })
    snapshot.platforms[0]!.fields[0]!.label = 'mutated'
    expect(w.platform.descriptor.fields[0]!.label).toBe('令牌')
  })

  it('lists no platform while its provider is not mounted', async () => {
    const w = await up({ platform: false })
    expect((await w.manager.snapshot()).platforms).toEqual([])
  })
})

describe('addBot', () => {
  it('verifies, stores the secret as a credential, persists the registry, and starts the bot', async () => {
    const w = await up()
    const bot = await add(w, { appId: '  app-1  ', site: 'cn' })
    expect(bot).toMatchObject({
      platform: 'stub',
      alias: 'Bot 111',
      identity: { botId: '111', displayName: 'Bot 111' },
      values: { appId: 'app-1', site: 'cn' },
      secrets: { token: { configured: true, tail: 'cdef' } },
      enabled: true,
      state: 'online',
      settings: {},
    })
    expect(bot.id).toMatch(/^bot_[0-9a-f]{8}$/u)
    expect(bot.createdAt).toBeGreaterThan(0)
    expect(bot).not.toHaveProperty('message')
    expect(w.platform.probes).toEqual([{ token: TOKEN, appId: 'app-1', site: 'cn' }])

    const ref = `DSH_CHAT_BOT_${bot.id.toUpperCase()}_TOKEN`
    expect(w.credentials.values.get(ref)).toBe(TOKEN)
    expect(w.platform.mounts).toEqual([{ values: { appId: 'app-1', site: 'cn' }, secretRefs: { token: ref } }])
    expect(w.ctx.chatAdapters.get('stub', '111')).toBeDefined()

    const document = JSON.parse(await readFile(w.registryPath, 'utf8')) as { bots: Array<Record<string, unknown>> }
    expect(document.bots).toEqual([{
      id: bot.id, platform: 'stub', alias: 'Bot 111', identity: { botId: '111', displayName: 'Bot 111' },
      values: { appId: 'app-1', site: 'cn' }, secretKeys: ['token'], enabled: true, settings: {}, createdAt: bot.createdAt,
    }])
  })

  it('never lets the secret reach a response, the registry, the logs, or an error', async () => {
    const w = await up()
    const logged: unknown[] = []
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(w.ctx.logger, level).mockImplementation((...args: unknown[]) => { logged.push(...args) })
    }
    const responses: unknown[] = []
    const errors: unknown[] = []
    const bot = await add(w, {}, 'Mine')
    responses.push(bot, await w.manager.snapshot(), await w.manager.checkBot({ id: bot.id }, signal()))
    responses.push(await w.manager.updateBot({ id: bot.id, alias: 'Renamed', settings: { agentProfile: 'code' } }))
    responses.push(await w.manager.retryBot({ id: bot.id }))
    for (const call of [
      () => add(w),
      () => w.manager.addBot({ platform: 'stub', values: { token: 'bad:ZZSECRETZZ-0123456789abcdef' } }, signal()),
      () => w.manager.addBot({ platform: 'stub', values: { token: 'odd:ZZSECRETZZ-0123456789abcdef' } }, signal()),
      () => w.manager.addBot({ platform: 'stub', values: { token: `${TOKEN}\n`, bogus: 'x' } }, signal()),
      () => w.manager.updateBot({ id: 'bot_00000000' }),
    ]) {
      errors.push(await call().then(() => undefined, (caught: unknown) => (caught as Error).message))
    }
    w.platform.failMount.add('111')
    await w.manager.retryBot({ id: bot.id })
    responses.push(await w.manager.snapshot())
    await w.manager.removeBot({ id: bot.id })
    const everything = JSON.stringify([responses, errors, logged]) + await readFile(w.registryPath, 'utf8')
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain(TOKEN)
    expect(errors.every(message => typeof message === 'string')).toBe(true)
  })

  it('uses a given alias, trimmed', async () => {
    const w = await up()
    expect((await add(w, {}, '  客服机器人 ')).alias).toBe('客服机器人')
  })

  it('provisions the chat-bridge Grant and mounts the embedded bridge once for all bots', async () => {
    const w = await up()
    await add(w)
    await w.manager.addBot({ platform: 'stub', values: { token: '222:ZZSECRETZZ-0123456789abcdef' } }, signal())
    const grants = await listAuthenticationGrants({ dshHome: w.dshHome })
    expect(grants.filter(grant => grant.name === 'chat-bridge')).toHaveLength(1)
    expect(grants.find(grant => grant.name === 'chat-bridge')?.capabilities).toEqual(['harniverse.observe', 'harniverse.operate'])
    expect(w.credentials.values.get('DSH_CHAT_BRIDGE_SIGNING')).toBeDefined()
    expect(w.credentials.values.get('DSH_CHAT_BRIDGE_GRANT_ID')).toBe(grants.find(grant => grant.name === 'chat-bridge')?.id)
    expect(stubs.clients).toEqual([{ origin: 'http://127.0.0.1:41234' }])
    expect(stubs.bridges).toEqual([{ embedded: true }])
    expect(stubs.order).toEqual(['client up', 'bridge up'])
  })

  describe('rejects invalid input before any platform call', () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['a missing required field', {}, '请填写「令牌」'],
      ['a blank required field', { token: '   ' }, '请填写「令牌」'],
      ['a field the platform does not declare', { bogus: 'x' }, '不支持的字段'],
      ['a value with control characters', { appId: 'a\u0000b' }, '无效字符'],
      ['an oversized value', { appId: 'x'.repeat(4097) }, '无效字符'],
      ['a value outside a closed option list', { site: 'moon' }, '不在可选范围内'],
      ['an address that is not http(s)', { baseUrl: 'ftp://files.example/' }, 'http 或 https'],
      ['an address that is not a URL', { baseUrl: 'not a url' }, 'http 或 https'],
      ['an address that carries credentials', { baseUrl: 'https://user:ZZSECRETZZ@proxy.example/' }, '用户名和密码'],
    ]
    for (const [label, values, message] of cases) {
      it(label, async () => {
        const w = await up()
        await failure(w.manager.addBot({ platform: 'stub', values: { ...'token' in values || label.includes('required') ? {} : { token: TOKEN }, ...values } }, signal()), 'invalid-input', message)
        expect(w.platform.probes).toEqual([])
        expect(w.credentials.values.size).toBe(0)
      })
    }

    it('an unsupported platform and an invalid alias', async () => {
      const w = await up()
      await failure(w.manager.addBot({ platform: 'nope', values: {} }, signal()), 'invalid-input', '不支持的平台')
      await failure(add(w, {}, '  '), 'invalid-input', '别名')
      await failure(add(w, {}, 'x'.repeat(65)), 'invalid-input', '别名')
      await failure(add(w, {}, 'a\nb'), 'invalid-input', '别名')
      expect(w.platform.probes).toEqual([])
    })

    it('accepts an http(s) address and omits blank optional fields', async () => {
      const w = await up()
      const bot = await add(w, { baseUrl: 'https://proxy.example/tg/', appId: '   ' })
      expect(bot.values).toEqual({ baseUrl: 'https://proxy.example/tg/' })
    })
  })

  describe('classifies platform failures', () => {
    it('rejected credentials', async () => {
      const w = await up()
      await failure(w.manager.addBot({ platform: 'stub', values: { token: `bad:${SECRET}-0123456789abcdef` } }, signal()), 'invalid-credentials', '拒绝')
    })

    it('an unreachable platform and an unclassified failure, without echoing the platform text', async () => {
      const w = await up()
      await failure(w.manager.addBot({ platform: 'stub', values: { token: `down:${SECRET}-0123456789abcdef` } }, signal()), 'unreachable', '无法连接')
      const odd = await failure(w.manager.addBot({ platform: 'stub', values: { token: `odd:${SECRET}-0123456789abcdef` } }, signal()), 'unreachable')
      expect(odd.message).not.toContain('odd')
      expect(w.credentials.values.size).toBe(0)
      expect(await w.manager.snapshot()).toMatchObject({ bots: [], bridge: 'stopped' })
    })

    it('hands the probe a signal that follows the request and rethrows the abort', async () => {
      const w = await up()
      const controller = new AbortController()
      let seen: AbortSignal | undefined
      w.platform.probe = (_values, probeSignal) => {
        seen = probeSignal
        return new Promise((_resolve, reject) => { probeSignal.addEventListener('abort', () => { reject(new Error('probe aborted')) }) })
      }
      const request = w.manager.addBot({ platform: 'stub', values: { token: TOKEN } }, controller.signal).then(() => undefined, (caught: unknown) => caught)
      await vi.waitFor(() => { expect(seen).toBeDefined() })
      expect(seen!.aborted).toBe(false)
      controller.abort(new DOMException('cancelled', 'AbortError'))
      const error = await request
      expect(seen!.aborted).toBe(true)
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(error).not.toBeInstanceOf(ChatBotError)
      expect(w.credentials.values.size).toBe(0)
    })
  })

  describe('duplicates and bounds', () => {
    it('refuses the same platform bot twice, storing nothing for the second', async () => {
      const w = await up()
      await add(w)
      const before = new Map(w.credentials.values)
      await failure(add(w), 'duplicate-bot', '已经添加')
      expect(w.credentials.values).toEqual(before)
      expect((await w.manager.snapshot()).bots).toHaveLength(1)
    })

    it('refuses the duplicate even when two adds race past the probe', async () => {
      const w = await up()
      const results = await Promise.allSettled([add(w), add(w)])
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect((await w.manager.snapshot()).bots).toHaveLength(1)
      expect(w.platform.adapters.size).toBe(1)
    })

    it('stops at the bot limit', async () => {
      const w = await up()
      for (let index = 0; index < MAX_BOTS; index += 1) {
        await w.manager.addBot({ platform: 'stub', values: { token: `${String(1000 + index)}:${SECRET}-0123456789abcdef` } }, signal())
      }
      await failure(w.manager.addBot({ platform: 'stub', values: { token: `9999:${SECRET}-0123456789abcdef` } }, signal()), 'invalid-input', '最多')
      expect((await w.manager.snapshot()).bots).toHaveLength(MAX_BOTS)
    })
  })

  describe('leaves nothing behind when storage fails', () => {
    it('removes the credential when the registry cannot be written', async () => {
      const w = await up()
      await mkdir(w.registryPath)
      await expect(add(w)).rejects.toThrow()
      expect([...w.credentials.values.keys()].filter(ref => ref.startsWith('DSH_CHAT_BOT_'))).toEqual([])
      expect(w.platform.adapters.size).toBe(0)
    })

    it('stores no registry entry when a credential cannot be written', async () => {
      const w = await up()
      w.credentials.failSet = /_TOKEN$/u
      await expect(add(w)).rejects.toThrow('cannot store')
      expect((await w.manager.snapshot()).bots).toEqual([])
    })
  })
})

describe('updateBot', () => {
  it('renames a bot and persists it', async () => {
    const w = await up()
    const bot = await add(w)
    const updated = await w.manager.updateBot({ id: bot.id, alias: ' 新名字 ' })
    expect(updated).toMatchObject({ id: bot.id, alias: '新名字', state: 'online' })
    expect((await w.manager.snapshot()).bots[0]?.alias).toBe('新名字')
    await failure(w.manager.updateBot({ id: bot.id, alias: '' }), 'invalid-input', '别名')
  })

  it('sets, keeps, and clears the defaults for new owner sessions', async () => {
    const w = await up()
    const bot = await add(w)
    const workspace = join(tmpdir(), 'bot-workspace')
    const set = await w.manager.updateBot({
      id: bot.id,
      settings: { workspace: ` ${workspace} `, model: { provider: ' p ', model: 'm', reasoningEffort: 'high' }, agentProfile: ' code ' },
    })
    expect(set.settings).toEqual({ workspace, model: { provider: 'p', model: 'm', reasoningEffort: 'high' }, agentProfile: 'code' })
    expect((await w.manager.updateBot({ id: bot.id, settings: {} })).settings).toEqual(set.settings)
    expect((await w.manager.updateBot({ id: bot.id, settings: { model: { provider: 'p', model: 'm2' } } })).settings.model).toEqual({ provider: 'p', model: 'm2' })
    expect((await w.manager.updateBot({ id: bot.id, settings: { workspace: null, agentProfile: null } })).settings).toEqual({ model: { provider: 'p', model: 'm2' } })
    expect((await w.manager.updateBot({ id: bot.id, settings: { model: null } })).settings).toEqual({})
  })

  describe('rejects invalid defaults', () => {
    const cases: Array<[string, NonNullable<UpdateChatBotInput['settings']>, string]> = [
      ['a relative workspace', { workspace: 'relative/dir' }, '绝对路径'],
      ['a blank workspace', { workspace: '   ' }, '工作区路径'],
      ['a workspace with a control character', { workspace: '/srv/a\u0000b' }, '工作区路径'],
      ['an empty model provider', { model: { provider: '', model: 'm' } }, '模型提供方'],
      ['an empty model', { model: { provider: 'p', model: ' ' } }, '模型'],
      ['an empty reasoning effort', { model: { provider: 'p', model: 'm', reasoningEffort: '' } }, '推理强度'],
      ['an empty Agent Preset', { agentProfile: '' }, 'Agent Preset'],
      ['an oversized Agent Preset', { agentProfile: 'x'.repeat(129) }, 'Agent Preset'],
    ]
    for (const [label, settings, message] of cases) {
      it(label, async () => {
        const w = await up()
        const bot = await add(w)
        await failure(w.manager.updateBot({ id: bot.id, settings }), 'invalid-input', message)
        expect((await w.manager.snapshot()).bots[0]?.settings).toEqual({})
      })
    }
  })

  it('reports an unknown bot', async () => {
    const w = await up()
    await failure(w.manager.updateBot({ id: 'bot_00000000', alias: 'x' }), 'not-found', '找不到')
  })
})

describe('checkBot', () => {
  it('verifies the stored credentials, refreshes the display name and check time, and keeps the registry current', async () => {
    const w = await up()
    const bot = await add(w, { appId: 'app-1' })
    w.platform.probe = values => Promise.resolve({ botId: '111', displayName: `Renamed ${values.appId ?? ''}` })
    const before = Date.now()
    const result = await w.manager.checkBot({ id: bot.id }, signal())
    expect(result).toEqual({ ok: true, checkedAt: result.checkedAt })
    expect(result.checkedAt).toBeGreaterThan(0)
    expect(result.checkedAt).toBeGreaterThanOrEqual(before)
    expect(w.platform.probes.at(-1)).toEqual({ token: TOKEN, appId: 'app-1' })
    const [stored] = (await w.manager.snapshot()).bots
    expect(stored).toMatchObject({ checkedAt: result.checkedAt, identity: { botId: '111', displayName: 'Renamed app-1' }, alias: 'Bot 111' })
  })

  it('reports a platform failure as ok: false with a safe message and still records the check', async () => {
    const w = await up()
    const bot = await add(w)
    w.platform.probe = () => Promise.reject(new Error(`secret-bearing platform text ${TOKEN}`))
    const unreachable = await w.manager.checkBot({ id: bot.id }, signal())
    expectNotOk(unreachable, '无法连接')
    expect(JSON.stringify(unreachable)).not.toContain(SECRET)
    expect((await w.manager.snapshot()).bots[0]?.checkedAt).toBe(unreachable.checkedAt)
  })

  it('reports rejected credentials, a changed identity, a missing credential, and an unavailable platform', async () => {
    const w = await up()
    const bot = await add(w)
    w.platform.probe = () => Promise.reject(new ChatAdapterError('auth-failed', 'stub', 'no'))
    expectNotOk(await w.manager.checkBot({ id: bot.id }, signal()), '拒绝')

    w.platform.probe = () => Promise.resolve({ botId: '999', displayName: 'Other' })
    expectNotOk(await w.manager.checkBot({ id: bot.id }, signal()), '已变化')
    expect((await w.manager.snapshot()).bots[0]?.identity).toEqual({ botId: '111', displayName: 'Bot 111' })

    const ref = `DSH_CHAT_BOT_${bot.id.toUpperCase()}_TOKEN`
    const stored = w.credentials.values.get(ref)!
    w.credentials.values.delete(ref)
    expectNotOk(await w.manager.checkBot({ id: bot.id }, signal()), '凭据缺失')
    expect((await w.manager.snapshot()).bots[0]?.secrets).toEqual({ token: { configured: false, tail: '' } })
    w.credentials.values.set(ref, stored)

    await w.withdrawPlatform()
    expectNotOk(await w.manager.checkBot({ id: bot.id }, signal()), '不可用')
  })

  it('reports an unknown bot', async () => {
    const w = await up()
    await failure(w.manager.checkBot({ id: 'bot_00000000' }, signal()), 'not-found', '找不到')
  })

  it('rethrows the abort of the request instead of reporting it as a platform failure', async () => {
    const w = await up()
    const bot = await add(w)
    const controller = new AbortController()
    w.platform.probe = () => { controller.abort(new DOMException('cancelled', 'AbortError')); return Promise.reject(new Error('x')) }
    await expect(w.manager.checkBot({ id: bot.id }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('tolerates the bot being removed while the check runs', async () => {
    const w = await up()
    const bot = await add(w)
    let release: (() => void) | undefined
    w.platform.probe = () => new Promise((resolve) => { release = () => { resolve({ botId: '111', displayName: 'X' }) } })
    const check = w.manager.checkBot({ id: bot.id }, signal())
    await vi.waitFor(() => { expect(release).toBeDefined() })
    await w.manager.removeBot({ id: bot.id })
    release?.()
    expect(await check).toMatchObject({ ok: true })
    expect((await w.manager.snapshot()).bots).toEqual([])
  })
})
