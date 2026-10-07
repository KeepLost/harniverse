/** Real Loader composition: credentials, the adapter registry, the Feishu row, and a bridge stand-in.
 * Only the Open API and socket are faked. */

import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import ChatAdapters, { type ChatInbound } from '@deepseek-ai/dsh-chat-adapter'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as Feishu from '../src/index.ts'
import * as FeishuInvariant from '../src/invariant.ts'
import { decodeFrame, encodeFrame, type Frame } from '../src/frame.ts'
import type { SocketLike } from '../src/runtime.ts'
import * as fixtures from './fixtures/events.ts'
import { FakeOpenApi } from './fixtures/open-api.ts'

const APP_ID = 'cli_a1b2c3d4e5f6a7b8'
const originals = { fetch: Feishu.internals.fetch, createSocket: Feishu.internals.createSocket }

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  Feishu.internals.fetch = originals.fetch
  Feishu.internals.createSocket = originals.createSocket
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class FakeSocket extends EventEmitter implements SocketLike {
  sent: Frame[] = []
  send(data: Uint8Array): void { this.sent.push(decodeFrame(data)) }
  terminate(): void { /* nothing to release */ }
  close(): void { /* nothing to release */ }
}

function consumer(events: ChatInbound[]): { name: string; inject: string[]; apply(ctx: Context): void } {
  return {
    name: 'test-consumer',
    inject: ['chatAdapters'],
    apply(ctx) {
      ctx.on('chat-adapter/registered', (adapter) => {
        const controller = new AbortController()
        ctx.effect(() => () => { controller.abort() })
        void adapter.run({
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          accept: (event) => { events.push(event); return event.type === 'message' && event.controlText === 'reject me' ? Promise.reject('plain failure') : Promise.resolve() },
        }, controller.signal).catch(() => undefined)
      })
    },
  }
}

async function load(credentials: Record<string, string>, row: string[], events: ChatInbound[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-feishu-loader-'))
  const credentialsPath = join(root, 'credentials.yaml')
  await writeFile(credentialsPath, Object.entries(credentials).map(([key, value]) => `${key}: ${value}\n`).join(''), { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'", '  config:', `    path: ${JSON.stringify(credentialsPath)}`, '    watch: false',
    "- name: '@deepseek-ai/dsh-chat-adapter'",
    '- name: test-consumer',
    "- name: '@deepseek-ai/dsh-chat-adapter-feishu'",
    ...row,
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
    ['@deepseek-ai/dsh-chat-adapter-feishu', Feishu],
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

const ROW = ['  config:', '    apps:', `      - appId: ${APP_ID}`, '        secretRef: FEISHU_SECRET']

function fakes(): { server: FakeOpenApi; socket: FakeSocket } {
  const server = new FakeOpenApi()
  const socket = new FakeSocket()
  Feishu.internals.fetch = (input, init) => input.pathname === '/callback/ws/endpoint'
    ? Promise.resolve(Response.json({ code: 0, data: { URL: 'wss://x/ws?service_id=2', ClientConfig: { PingInterval: 30 } } }))
    : server.fetch(input, init)
  Feishu.internals.createSocket = () => socket
  return { server, socket }
}

describe('real Loader composition', () => {
  it('registers an app from a credential reference, receives events over the connection, and sends cards', async () => {
    const { server, socket } = fakes()
    const events: ChatInbound[] = []
    const loaded = await load({ FEISHU_SECRET: 's3cret' }, ROW, events)
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const adapter = loaded.chatAdapters.get('feishu', APP_ID)
    expect(adapter).toBeDefined()
    await vi.waitFor(() => { expect(socket.listenerCount('message')).toBe(1) })
    socket.emit('open')
    socket.emit('message', Buffer.from(encodeFrame({
      SeqID: 1n, LogID: 1n, service: 2, method: 1,
      headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }],
      payload: new TextEncoder().encode(JSON.stringify(fixtures.p2pText)),
    })))
    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(events[0]).toMatchObject({ type: 'message', controlText: 'hello there', route: { kind: 'direct', chatId: 'oc_dm' } })
    await adapter!.send({ kind: 'direct', chatId: 'oc_dm' }, { text: 'reply' })
    expect(server.to('/open-apis/im/v1/messages')[0]?.json).toMatchObject({ receive_id: 'oc_dm' })
    expect(server.to('/open-apis/auth/v3/tenant_access_token/internal')[0]?.json).toMatchObject({ app_secret: 's3cret' })
  })

  it('resolves the secret at every token fetch, so a rotated credential applies on the next token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { server } = fakes()
    const loaded = await load({ FEISHU_SECRET: 's3cret' }, ROW)
    const adapter = loaded.chatAdapters.get('feishu', APP_ID)!
    await loaded.credentials.set(credentialRef('FEISHU_SECRET'), 'rotated')
    await adapter.send({ kind: 'direct', chatId: 'oc_dm' }, { text: 'cached token' })
    expect(server.to('/open-apis/auth/v3/tenant_access_token/internal').at(-1)?.json).toMatchObject({ app_secret: 's3cret' })
    vi.setSystemTime(Date.now() + 7_200_000)
    await adapter.send({ kind: 'direct', chatId: 'oc_dm' }, { text: 'fresh token' })
    expect(server.to('/open-apis/auth/v3/tenant_access_token/internal').at(-1)?.json).toMatchObject({ app_secret: 'rotated' })
    vi.setSystemTime(Date.now() + 7_200_000)
    await loaded.credentials.unset(credentialRef('FEISHU_SECRET'))
    await expect(adapter.send({ kind: 'direct', chatId: 'oc_dm' }, { text: 'no secret' })).rejects.toMatchObject({ code: 'send-failed' })
    vi.useRealTimers()
  })

  it('registers nothing for an empty app list and removes the adapter with its fiber', async () => {
    const empty = await load({}, [])
    expect(empty.chatAdapters.list()).toHaveLength(0)
    await empty.fiber.dispose()
    context = undefined
    fakes()
    const loaded = await load({ FEISHU_SECRET: 's3cret' }, ROW)
    const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-chat-adapter-feishu')
    await entry!.fiber!.dispose()
    expect(loaded.chatAdapters.get('feishu', APP_ID)).toBeUndefined()
  })

  it('refuses to mount with a malformed app id, a missing secret, or a duplicate app', async () => {
    fakes()
    await expect(load({ FEISHU_SECRET: 's' }, ['  config:', '    apps:', '      - appId: nope', '        secretRef: FEISHU_SECRET'])).rejects.toThrow('is not a Feishu app id')
    await context?.fiber.dispose()
    await expect(load({}, ROW)).rejects.toThrow('credential FEISHU_SECRET is unset')
    await context?.fiber.dispose()
    await expect(load({ FEISHU_SECRET: 's' }, [...ROW, `      - appId: ${APP_ID}`, '        secretRef: FEISHU_SECRET'])).rejects.toThrow('already registered')
  })

  it('warns through the logger about connection-level problems', async () => {
    const { socket } = fakes()
    const loaded = await load({ FEISHU_SECRET: 's3cret' }, ROW)
    const warn = vi.spyOn(loaded.logger, 'warn')
    await vi.waitFor(() => { expect(socket.listenerCount('message')).toBe(1) })
    socket.emit('open')
    socket.emit('message', Buffer.from([0x08, 0x80]))
    await vi.waitFor(() => { expect(warn.mock.calls.some(call => String(call[0]).startsWith('dropping a malformed frame: '))).toBe(true) })
    const rejected = JSON.parse(JSON.stringify(fixtures.p2pText)) as { event: { message: { content: string } } }
    rejected.event.message.content = JSON.stringify({ text: 'reject me' })
    socket.emit('message', Buffer.from(encodeFrame({ SeqID: 1n, LogID: 1n, service: 2, method: 1, headers: [{ key: 'type', value: 'event' }], payload: new TextEncoder().encode(JSON.stringify(rejected)) })))
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('handling an event failed: plain failure') })
  })

  it('supports a non-Error warning value and the default transports', async () => {
    const socket = Feishu.internals.createSocket('ws://127.0.0.1:1/x')
    socket.on('error', () => undefined)
    socket.terminate()
    await expect(originals.fetch(new URL('http://127.0.0.1:1/'), { method: 'GET' })).rejects.toThrow()
  })
})

describe('invariant companion', () => {
  it('registers under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(FeishuInvariant)
    await ctx.fiber.dispose()
  })
})
