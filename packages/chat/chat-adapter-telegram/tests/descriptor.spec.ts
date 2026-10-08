/** The Telegram platform descriptor: declared fields, token validation through `getMe`, and per-bot mounting. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ChatAdapters, { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as Telegram from '../src/index.ts'
import { telegramDescriptor } from '../src/index.ts'
import { FakeBotApi } from './fixtures/bot-api.ts'
import * as fixtures from './fixtures/updates.ts'

const TOKEN = '777000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const original = Telegram.internals.fetch
const roots: string[] = []

afterEach(async () => {
  Telegram.internals.fetch = original
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function serve(): FakeBotApi {
  const server = new FakeBotApi()
  Telegram.internals.fetch = server.fetch
  return server
}

async function failure(promise: Promise<unknown>): Promise<ChatAdapterError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ChatAdapterError)
  return error as ChatAdapterError
}

const signal = (): AbortSignal => new AbortController().signal

describe('descriptor', () => {
  it('declares the Telegram platform and its two fields', () => {
    expect(telegramDescriptor.platform).toBe('telegram')
    expect(telegramDescriptor.label).toBe('Telegram')
    expect(telegramDescriptor.fields).toEqual([
      { key: 'token', label: '机器人 Token', secret: true, required: true, placeholder: '123456789:AA…', hint: '在 @BotFather 创建机器人后获得' },
      {
        key: 'baseUrl', label: 'Bot API 地址', secret: false, required: false,
        hint: 'Bot API 地址，留空使用官方 https://api.telegram.org/（无法直连时可填自建代理）',
      },
    ])
  })
})

describe('probe', () => {
  it('resolves the bot identity from getMe, preferring the username handle when no first name exists', async () => {
    const server = serve()
    expect(await telegramDescriptor.probe({ token: TOKEN }, signal())).toEqual({ botId: '777000', displayName: '@HarniBot' })
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]?.url.href).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`)
  })

  it('prefers the first name and falls back to the bot id when the answer names nothing', async () => {
    const server = serve()
    server.script('getMe', { result: { id: 777000, first_name: 'Harni', username: 'HarniBot' } })
    expect((await telegramDescriptor.probe({ token: TOKEN }, signal())).displayName).toBe('Harni')
    server.script('getMe', { result: { id: 777000 } })
    expect((await telegramDescriptor.probe({ token: TOKEN }, signal())).displayName).toBe('777000')
  })

  it('takes the bot id from the token prefix and trims the typed values', async () => {
    const server = serve()
    server.script('getMe', { result: { id: 123456789, first_name: 'Other' } })
    const token = `123456789:${'x'.repeat(35)}`
    expect(await telegramDescriptor.probe({ token: `  ${token}\n`, baseUrl: '   ' }, signal())).toEqual({ botId: '123456789', displayName: 'Other' })
    expect(server.calls[0]?.url.href).toBe(`https://api.telegram.org/bot${token}/getMe`)
  })

  it('calls a custom Bot API origin when one is given', async () => {
    const server = serve()
    await telegramDescriptor.probe({ token: TOKEN, baseUrl: 'https://tg.proxy.example/prefix/' }, signal())
    expect(server.calls[0]?.url.href).toBe(`https://tg.proxy.example/prefix/bot${TOKEN}/getMe`)
  })

  it.each([[{}], [{ token: '' }], [{ token: 'not-a-token' }], [{ token: '12:short' }]])('refuses malformed token input %j before any request', async (values) => {
    const server = serve()
    const failed = await failure(telegramDescriptor.probe(values, signal()))
    expect(failed.code).toBe('auth-failed')
    expect(failed.message).toBe('chat-adapter(telegram): the value is not a Telegram bot token')
    expect(server.calls).toHaveLength(0)
  })

  it.each([['not a url'], ['ftp://tg.proxy.example/'], ['/relative']])('refuses the Bot API address %j before any request', async (baseUrl) => {
    const server = serve()
    const failed = await failure(telegramDescriptor.probe({ token: TOKEN, baseUrl }, signal()))
    expect(failed.code).toBe('network')
    expect(failed.message).toBe('chat-adapter(telegram): the Bot API address is not an http(s) URL')
    expect(failed.message).not.toContain(TOKEN)
    expect(server.calls).toHaveLength(0)
  })

  it('classifies a rejected token as auth-failed', async () => {
    const server = serve()
    server.script('getMe', { error: { status: 401, description: 'Unauthorized' } })
    expect((await failure(telegramDescriptor.probe({ token: TOKEN }, signal()))).code).toBe('auth-failed')
  })

  it('classifies an unreachable platform as network without echoing the token', async () => {
    const server = serve()
    server.script('getMe', { throws: new TypeError('fetch failed') })
    const failed = await failure(telegramDescriptor.probe({ token: TOKEN }, signal()))
    expect(failed.code).toBe('network')
    const cause = failed.cause instanceof Error ? failed.cause.message : ''
    expect(`${failed.message} ${cause}`).not.toContain(TOKEN)
  })

  it('stops with the caller signal', async () => {
    let seen: AbortSignal | null | undefined
    Telegram.internals.fetch = (_input, init) => {
      seen = init.signal
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    }
    const controller = new AbortController()
    const probing = failure(telegramDescriptor.probe({ token: TOKEN }, controller.signal))
    await vi.waitFor(() => { expect(seen).toBeDefined() })
    controller.abort()
    expect((await probing).code).toBe('network')
    expect(seen?.aborted).toBe(true)
  })
})

async function scope(credentials: Record<string, string>): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-telegram-descriptor-'))
  roots.push(root)
  const path = join(root, 'credentials.yaml')
  await writeFile(path, Object.entries(credentials).map(([key, value]) => `${key}: ${value}\n`).join(''), { mode: 0o600 })
  const ctx = new Context()
  await ctx.plugin(CredentialsLocal, { path, watch: false })
  await ctx.plugin(ChatAdapters)
  return ctx
}

describe('mount', () => {
  it('registers one adapter whose token resolves through the secret reference', async () => {
    const server = serve()
    const ctx = await scope({ TG_MAIN: TOKEN })
    await telegramDescriptor.mount(ctx, { values: {}, secretRefs: { token: 'TG_MAIN' } })
    expect(ctx.chatAdapters.list().map(adapter => `${adapter.platform}:${adapter.botId}`)).toEqual(['telegram:777000'])
    await ctx.chatAdapters.get('telegram', '777000')!.send({ kind: 'direct', chatId: '42' }, { text: 'hi' })
    expect(server.of('sendMessage')[0]?.url.href).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    await ctx.fiber.dispose()
  })

  it('uses the managed Bot API origin and the default long-poll wait', async () => {
    const server = serve()
    server.pending(fixtures.privateText)
    const ctx = await scope({ TG_MAIN: TOKEN })
    await telegramDescriptor.mount(ctx, { values: { baseUrl: ' https://tg.proxy.example ' }, secretRefs: { token: 'TG_MAIN' } })
    const controller = new AbortController()
    const run = ctx.chatAdapters.get('telegram', '777000')!.run({ accept: () => Promise.resolve() }, controller.signal)
    await vi.waitFor(() => { expect(server.of('getUpdates').length).toBeGreaterThanOrEqual(1) })
    controller.abort()
    await run
    expect(server.of('getUpdates')[0]?.url.href).toBe(`https://tg.proxy.example/bot${TOKEN}/getUpdates`)
    expect(server.of('getUpdates')[0]?.payload.timeout).toBe(25)
    await ctx.fiber.dispose()
  })

  it('resolves the token again for every request, so a rotated credential applies', async () => {
    const server = serve()
    const ctx = await scope({ TG_MAIN: TOKEN })
    await telegramDescriptor.mount(ctx, { values: {}, secretRefs: { token: 'TG_MAIN' } })
    const rotated = '777000:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    await ctx.credentials.set(credentialRef('TG_MAIN'), rotated)
    await ctx.chatAdapters.get('telegram', '777000')!.send({ kind: 'direct', chatId: '42' }, { text: 'after rotation' })
    expect(server.of('sendMessage')[0]?.url.pathname).toBe(`/bot${rotated}/sendMessage`)
    await ctx.fiber.dispose()
  })

  it('removes the adapter when the scope that mounted it is disposed', async () => {
    serve()
    const ctx = await scope({ TG_MAIN: TOKEN })
    const fiber = await ctx.plugin({
      inject: ['chatAdapters', 'credentials'],
      apply: (inner: Context) => telegramDescriptor.mount(inner, { values: {}, secretRefs: { token: 'TG_MAIN' } }),
    })
    expect(ctx.chatAdapters.get('telegram', '777000')).toBeDefined()
    await fiber.dispose()
    expect(ctx.chatAdapters.get('telegram', '777000')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails the mount without a token reference, with an unset or malformed token, and with a bad Bot API origin', async () => {
    serve()
    const ctx = await scope({ TG_BAD: 'not-a-token', TG_MAIN: TOKEN })
    await expect(telegramDescriptor.mount(ctx, { values: {}, secretRefs: {} })).rejects.toThrow('chat-adapter-telegram: the managed bot has no token credential')
    await expect(telegramDescriptor.mount(ctx, { values: {}, secretRefs: { token: 'TG_MISSING' } })).rejects.toThrow('credential TG_MISSING is unset or is not a Telegram bot token')
    await expect(telegramDescriptor.mount(ctx, { values: {}, secretRefs: { token: 'TG_BAD' } })).rejects.toThrow('credential TG_BAD is unset or is not a Telegram bot token')
    await expect(telegramDescriptor.mount(ctx, { values: { baseUrl: 'nope' }, secretRefs: { token: 'TG_MAIN' } })).rejects.toThrow('the Bot API address is not an http(s) URL')
    expect(ctx.chatAdapters.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects a second mount of the same bot', async () => {
    serve()
    const ctx = await scope({ TG_MAIN: TOKEN })
    await telegramDescriptor.mount(ctx, { values: {}, secretRefs: { token: 'TG_MAIN' } })
    await expect(telegramDescriptor.mount(ctx, { values: {}, secretRefs: { token: 'TG_MAIN' } })).rejects.toThrow('telegram:777000 is already registered')
    await ctx.fiber.dispose()
  })
})
