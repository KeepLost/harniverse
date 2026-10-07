/** Real Loader composition: credentials, the adapter registry, the Telegram row, and a bridge stand-in; only the Bot API is faked. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ChatAdapters, { type ChatInbound } from '@deepseek-ai/dsh-chat-adapter'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as Telegram from '../src/index.ts'
import { FakeBotApi } from './fixtures/bot-api.ts'
import * as fixtures from './fixtures/updates.ts'

const TOKEN = '777000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const original = Telegram.internals.fetch

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  Telegram.internals.fetch = original
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A stand-in for the bridge: runs every registered adapter and collects what it emits. */
function consumer(events: ChatInbound[]): { name: string; inject: string[]; apply(ctx: Context): void } {
  return {
    name: 'test-consumer',
    inject: ['chatAdapters'],
    apply(ctx) {
      ctx.on('chat-adapter/registered', (adapter) => {
        const controller = new AbortController()
        ctx.effect(() => () => { controller.abort() })
        void adapter.run({ accept: (event) => { events.push(event); return Promise.resolve() } }, controller.signal)
      })
    },
  }
}

async function load(credentials: Record<string, string>, telegramRow: string[], events: ChatInbound[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-telegram-loader-'))
  const credentialsPath = join(root, 'credentials.yaml')
  await writeFile(credentialsPath, Object.entries(credentials).map(([key, value]) => `${key}: ${value}\n`).join(''), { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-chat-adapter'",
    '- name: test-consumer',
    "- name: '@deepseek-ai/dsh-chat-adapter-telegram'",
    ...telegramRow,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
    ['@deepseek-ai/dsh-chat-adapter', ChatAdapters],
    ['test-consumer', consumer(events)],
    ['@deepseek-ai/dsh-chat-adapter-telegram', Telegram],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('registers a bot from a credential reference, receives updates, and sends through the Bot API', async () => {
    const server = new FakeBotApi()
    Telegram.internals.fetch = server.fetch
    server.pending(fixtures.privateText)
    const events: ChatInbound[] = []
    const loaded = await load({ TG_MAIN: TOKEN }, ['  config:', '    bots:', '      - tokenRef: TG_MAIN', '        pollTimeoutSeconds: 5'], events)
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const adapter = loaded.chatAdapters.get('telegram', '777000')
    expect(adapter).toBeDefined()
    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(events[0]).toMatchObject({ type: 'message', controlText: 'hello there' })
    expect(server.of('getUpdates')[0]?.payload.timeout).toBe(5)
    await adapter!.send({ kind: 'direct', chatId: '42' }, { text: 'reply' })
    expect(server.of('sendMessage')[0]?.payload).toMatchObject({ chat_id: 42, text: 'reply' })
    expect(server.of('sendMessage')[0]?.url.pathname).toBe(`/bot${TOKEN}/sendMessage`)
  })

  it('resolves the token per request, so a rotated credential applies without a restart', async () => {
    const server = new FakeBotApi()
    Telegram.internals.fetch = server.fetch
    const loaded = await load({ TG_MAIN: TOKEN }, ['  config:', '    bots:', '      - tokenRef: TG_MAIN'])
    const rotated = '777000:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    await loaded.credentials.set(credentialRef('TG_MAIN'), rotated)
    await loaded.chatAdapters.get('telegram', '777000')!.send({ kind: 'direct', chatId: '42' }, { text: 'after rotation' })
    expect(server.of('sendMessage')[0]?.url.pathname).toBe(`/bot${rotated}/sendMessage`)
    await loaded.credentials.unset(credentialRef('TG_MAIN'))
    await expect(loaded.chatAdapters.get('telegram', '777000')!.send({ kind: 'direct', chatId: '42' }, { text: 'no token' })).rejects.toMatchObject({ code: 'send-failed' })
  })

  it('registers nothing for an empty bot list and removes the adapter with its fiber', async () => {
    const empty = await load({}, [])
    expect(empty.chatAdapters.list()).toHaveLength(0)
    await empty.fiber.dispose()
    context = undefined
    const server = new FakeBotApi()
    Telegram.internals.fetch = server.fetch
    const loaded = await load({ TG_MAIN: TOKEN }, ['  config:', '    bots:', '      - tokenRef: TG_MAIN'])
    const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-chat-adapter-telegram')
    await entry!.fiber!.dispose()
    expect(loaded.chatAdapters.get('telegram', '777000')).toBeUndefined()
  })

  it('refuses to mount with a missing or malformed token, and a duplicate bot', async () => {
    await expect(load({}, ['  config:', '    bots:', '      - tokenRef: TG_MISSING'])).rejects.toThrow('TG_MISSING is unset or is not a Telegram bot token')
    await context?.fiber.dispose()
    await expect(load({ TG_BAD: 'not-a-token' }, ['  config:', '    bots:', '      - tokenRef: TG_BAD'])).rejects.toThrow('not a Telegram bot token')
    await context?.fiber.dispose()
    await expect(load({ TG_A: TOKEN, TG_B: TOKEN }, ['  config:', '    bots:', '      - tokenRef: TG_A', '      - tokenRef: TG_B'])).rejects.toThrow('already registered')
  })

  it('warns through the logger when the bridge rejects an inbound event', async () => {
    const server = new FakeBotApi()
    Telegram.internals.fetch = server.fetch
    server.pending(fixtures.privateText)
    const loaded = await load({ TG_MAIN: TOKEN }, ['  config:', '    bots:', '      - tokenRef: TG_MAIN'])
    const warn = vi.spyOn(loaded.logger, 'warn')
    const adapter = loaded.chatAdapters.get('telegram', '777000')!
    const controller = new AbortController()
    server.pending(fixtures.callback)
    const run = adapter.run({ accept: () => Promise.reject(new Error('bridge broke')) }, controller.signal)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('the bridge rejected an inbound event; skipping it: bridge broke') })
    controller.abort()
    await run
    const second = new AbortController()
    server.pending(fixtures.callback)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the warning path must also describe a non-Error rejection.
    const again = adapter.run({ accept: () => Promise.reject('plain failure') }, second.signal)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('the bridge rejected an inbound event; skipping it: plain failure') })
    second.abort()
    await again
  })
})
