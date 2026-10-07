/** The Feishu platform descriptor: declared fields, credential validation through the Open API, and per-app mounting. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ChatAdapters, { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as Feishu from '../src/index.ts'
import { feishuDescriptor } from '../src/index.ts'
import { FakeOpenApi } from './fixtures/open-api.ts'

const APP_ID = 'cli_a1b2c3d4e5f6a7b8'
const SECRET = 's3cret-value'
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
const originals = { fetch: Feishu.internals.fetch, createSocket: Feishu.internals.createSocket }
const roots: string[] = []

afterEach(async () => {
  Feishu.internals.fetch = originals.fetch
  Feishu.internals.createSocket = originals.createSocket
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Install a fake Open API and record the origin of every request. */
function serve(): { server: FakeOpenApi; origins: string[] } {
  const server = new FakeOpenApi()
  const origins: string[] = []
  Feishu.internals.fetch = (input, init) => {
    origins.push(input.origin)
    return server.fetch(input, init)
  }
  return { server, origins }
}

async function failure(promise: Promise<unknown>): Promise<ChatAdapterError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ChatAdapterError)
  return error as ChatAdapterError
}

const signal = (): AbortSignal => new AbortController().signal

describe('descriptor', () => {
  it('declares the Feishu platform and its three fields', () => {
    expect(feishuDescriptor.platform).toBe('feishu')
    expect(feishuDescriptor.label).toBe('飞书')
    expect(feishuDescriptor.fields).toEqual([
      { key: 'appId', label: 'App ID', secret: false, required: true, placeholder: 'cli_xxxxxxxxxxxxxxxx' },
      { key: 'appSecret', label: 'App Secret', secret: true, required: true },
      {
        key: 'domain', label: '站点', secret: false, required: false, hint: '留空使用飞书（中国）',
        options: [
          { value: 'https://open.feishu.cn', label: '飞书（中国）' },
          { value: 'https://open.larksuite.com', label: 'Lark（国际）' },
        ],
      },
    ])
  })
})

describe('probe', () => {
  it('fetches a tenant token with the typed secret and resolves the bot name', async () => {
    const { server, origins } = serve()
    server.script('GET /open-apis/bot/v3/info', { body: { bot: { app_name: 'Harni 助手', open_id: 'ou_bot' } } })
    expect(await feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET }, signal())).toEqual({ botId: APP_ID, displayName: 'Harni 助手' })
    expect(server.to(TOKEN_PATH)[0]?.json).toEqual({ app_id: APP_ID, app_secret: SECRET })
    expect(server.to('/open-apis/bot/v3/info')[0]?.headers.get('authorization')).toBe('Bearer t-1')
    expect(origins).toEqual(['https://open.feishu.cn', 'https://open.feishu.cn'])
  })

  it('falls back to the app id when the bot has no name', async () => {
    const { server } = serve()
    expect((await feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET }, signal())).displayName).toBe(APP_ID)
    server.script('GET /open-apis/bot/v3/info', { body: { bot: { app_name: '' } } })
    expect((await feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET }, signal())).displayName).toBe(APP_ID)
    server.script('GET /open-apis/bot/v3/info', { body: {} })
    expect((await feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET }, signal())).displayName).toBe(APP_ID)
  })

  it('trims the typed values and selects the Lark site', async () => {
    const { server, origins } = serve()
    await feishuDescriptor.probe({ appId: ` ${APP_ID} `, appSecret: ` ${SECRET}\n`, domain: ' https://open.larksuite.com ' }, signal())
    expect(server.to(TOKEN_PATH)[0]?.json).toEqual({ app_id: APP_ID, app_secret: SECRET })
    expect(origins).toEqual(['https://open.larksuite.com', 'https://open.larksuite.com'])
    await feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET, domain: '  ' }, signal())
    expect(origins.at(-1)).toBe('https://open.feishu.cn')
  })

  it.each([[{}], [{ appId: '' }], [{ appId: 'app_1' }], [{ appId: 'cli_short' }]])('refuses malformed app id input %j before any request', async (values) => {
    const { server } = serve()
    const failed = await failure(feishuDescriptor.probe({ ...values, appSecret: SECRET }, signal()))
    expect(failed.code).toBe('auth-failed')
    expect(failed.message).toBe('chat-adapter(feishu): the value is not a Feishu app id')
    expect(server.calls).toHaveLength(0)
  })

  it.each([[{}], [{ appSecret: '' }], [{ appSecret: '   ' }]])('refuses a missing app secret %j before any request', async (values) => {
    const { server } = serve()
    const failed = await failure(feishuDescriptor.probe({ appId: APP_ID, ...values }, signal()))
    expect(failed.code).toBe('auth-failed')
    expect(failed.message).toBe('chat-adapter(feishu): the app secret is empty')
    expect(server.calls).toHaveLength(0)
  })

  it('refuses a site outside the declared choices before any request', async () => {
    const { server } = serve()
    const failed = await failure(feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET, domain: 'https://open.example.com' }, signal()))
    expect(failed.code).toBe('network')
    expect(failed.message).toBe('chat-adapter(feishu): the site is not a supported Open Platform origin')
    expect(failed.message).not.toContain(SECRET)
    expect(server.calls).toHaveLength(0)
  })

  it('classifies rejected app credentials as auth-failed', async () => {
    const { server } = serve()
    server.script(`POST ${TOKEN_PATH}`, { code: 10003, status: 400, msg: 'invalid param' })
    expect((await failure(feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET }, signal()))).code).toBe('auth-failed')
  })

  it('classifies an unreachable platform as network without echoing the secret', async () => {
    const { server } = serve()
    server.script(`POST ${TOKEN_PATH}`, { throws: new TypeError('fetch failed') })
    const failed = await failure(feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET }, signal()))
    expect(failed.code).toBe('network')
    const cause = failed.cause instanceof Error ? failed.cause.message : ''
    expect(`${failed.message} ${cause}`).not.toContain(SECRET)
  })

  it('reports a bot-info refusal with the platform message', async () => {
    const { server } = serve()
    server.script('GET /open-apis/bot/v3/info', { code: 230001, status: 400, msg: 'bad param' })
    const failed = await failure(feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET }, signal()))
    expect(failed.code).toBe('network')
    expect(failed.message).toBe('chat-adapter(feishu): bad param')
  })

  it('stops with the caller signal', async () => {
    let seen: AbortSignal | null | undefined
    Feishu.internals.fetch = (_input, init) => {
      seen = init.signal
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    }
    const controller = new AbortController()
    const probing = failure(feishuDescriptor.probe({ appId: APP_ID, appSecret: SECRET }, controller.signal))
    await vi.waitFor(() => { expect(seen).toBeDefined() })
    controller.abort()
    expect((await probing).code).toBe('network')
    expect(seen?.aborted).toBe(true)
  })
})

async function scope(credentials: Record<string, string>): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-descriptor-'))
  roots.push(root)
  const path = join(root, 'credentials.yaml')
  await writeFile(path, Object.entries(credentials).map(([key, value]) => `${key}: ${value}\n`).join(''), { mode: 0o600 })
  const ctx = new Context()
  await ctx.plugin(CredentialsLocal, { path, watch: false })
  await ctx.plugin(ChatAdapters)
  return ctx
}

describe('mount', () => {
  it('registers one adapter whose secret resolves through the secret reference', async () => {
    const { server, origins } = serve()
    const ctx = await scope({ FEISHU_MAIN: SECRET })
    await feishuDescriptor.mount(ctx, { values: { appId: APP_ID }, secretRefs: { appSecret: 'FEISHU_MAIN' } })
    expect(ctx.chatAdapters.list().map(adapter => `${adapter.platform}:${adapter.botId}`)).toEqual([`feishu:${APP_ID}`])
    await ctx.chatAdapters.get('feishu', APP_ID)!.send({ kind: 'direct', chatId: 'oc_dm' }, { text: 'hi' })
    expect(server.to(TOKEN_PATH)[0]?.json).toEqual({ app_id: APP_ID, app_secret: SECRET })
    expect(origins[0]).toBe('https://open.feishu.cn')
    await ctx.fiber.dispose()
  })

  it('uses the managed site and trims the app id', async () => {
    const { origins } = serve()
    const ctx = await scope({ FEISHU_MAIN: SECRET })
    await feishuDescriptor.mount(ctx, { values: { appId: ` ${APP_ID} `, domain: 'https://open.larksuite.com' }, secretRefs: { appSecret: 'FEISHU_MAIN' } })
    await ctx.chatAdapters.get('feishu', APP_ID)!.send({ kind: 'direct', chatId: 'oc_dm' }, { text: 'hi' })
    expect(origins[0]).toBe('https://open.larksuite.com')
    await ctx.fiber.dispose()
  })

  it('resolves the secret again at every token fetch, so a rotated credential applies', async () => {
    const { server } = serve()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const ctx = await scope({ FEISHU_MAIN: SECRET })
      await feishuDescriptor.mount(ctx, { values: { appId: APP_ID }, secretRefs: { appSecret: 'FEISHU_MAIN' } })
      const adapter = ctx.chatAdapters.get('feishu', APP_ID)!
      await adapter.send({ kind: 'direct', chatId: 'oc_dm' }, { text: 'first token' })
      await ctx.credentials.set(credentialRef('FEISHU_MAIN'), 'rotated')
      vi.setSystemTime(Date.now() + 7_200_000)
      await adapter.send({ kind: 'direct', chatId: 'oc_dm' }, { text: 'fresh token' })
      expect(server.to(TOKEN_PATH).map(call => (call.json as { app_secret: string }).app_secret)).toEqual([SECRET, 'rotated'])
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes the adapter when the scope that mounted it is disposed', async () => {
    serve()
    const ctx = await scope({ FEISHU_MAIN: SECRET })
    const fiber = await ctx.plugin({
      inject: ['chatAdapters', 'credentials'],
      apply: (inner: Context) => feishuDescriptor.mount(inner, { values: { appId: APP_ID }, secretRefs: { appSecret: 'FEISHU_MAIN' } }),
    })
    expect(ctx.chatAdapters.get('feishu', APP_ID)).toBeDefined()
    await fiber.dispose()
    expect(ctx.chatAdapters.get('feishu', APP_ID)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails the mount without a secret reference, with an unset secret, a malformed app id, or a bad site', async () => {
    serve()
    const ctx = await scope({ FEISHU_MAIN: SECRET })
    const secretRefs = { appSecret: 'FEISHU_MAIN' }
    await expect(feishuDescriptor.mount(ctx, { values: { appId: APP_ID }, secretRefs: {} })).rejects.toThrow('chat-adapter-feishu: the managed bot has no appSecret credential')
    await expect(feishuDescriptor.mount(ctx, { values: { appId: APP_ID }, secretRefs: { appSecret: 'FEISHU_MISSING' } })).rejects.toThrow('credential FEISHU_MISSING is unset')
    await expect(feishuDescriptor.mount(ctx, { values: { appId: 'nope' }, secretRefs })).rejects.toThrow('"nope" is not a Feishu app id')
    await expect(feishuDescriptor.mount(ctx, { values: {}, secretRefs })).rejects.toThrow('"" is not a Feishu app id')
    await expect(feishuDescriptor.mount(ctx, { values: { appId: APP_ID, domain: 'https://open.example.com' }, secretRefs })).rejects.toThrow('the site is not a supported Open Platform origin')
    expect(ctx.chatAdapters.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects a second mount of the same app', async () => {
    serve()
    const ctx = await scope({ FEISHU_MAIN: SECRET })
    const bot = { values: { appId: APP_ID }, secretRefs: { appSecret: 'FEISHU_MAIN' } }
    await feishuDescriptor.mount(ctx, bot)
    await expect(feishuDescriptor.mount(ctx, bot)).rejects.toThrow(`feishu:${APP_ID} is already registered`)
    await ctx.fiber.dispose()
  })
})
