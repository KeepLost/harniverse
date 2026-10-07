/** The Feishu adapter against a fake Open API and socket: run, outbound cards, downloads, and error classification. */

import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatAdapterError, type ChatInbound } from '@deepseek-ai/dsh-chat-adapter'
import { classify, FEISHU_CAPABILITIES, FeishuAdapter } from '../src/adapter.ts'
import { FeishuApi, FeishuApiError } from '../src/api.ts'
import { decodeFrame, encodeFrame, type Frame } from '../src/frame.ts'
import type { SocketLike } from '../src/runtime.ts'
import * as fixtures from './fixtures/events.ts'
import { FakeOpenApi } from './fixtures/open-api.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class FakeSocket extends EventEmitter implements SocketLike {
  sent: Frame[] = []
  send(data: Uint8Array): void { this.sent.push(decodeFrame(data)) }
  terminate(): void { /* nothing to release */ }
  close(): void { /* nothing to release */ }
}

function setup(): { adapter: FeishuAdapter; server: FakeOpenApi; socket: FakeSocket; warnings: string[] } {
  const server = new FakeOpenApi()
  const socket = new FakeSocket()
  const warnings: string[] = []
  const secret = (): Promise<string> => Promise.resolve('s3cret')
  server.script('POST /callback/ws/endpoint', { data: undefined })
  const adapter = new FeishuAdapter({
    appId: 'cli_a1b2c3d4e5f6a7b8', domain: 'https://open.feishu.cn', secret,
    fetch: (input, init) => input.pathname === '/callback/ws/endpoint'
      ? Promise.resolve(Response.json({ code: 0, data: { URL: 'wss://x/ws?service_id=2', ClientConfig: { PingInterval: 30 } } }))
      : server.fetch(input, init),
    createSocket: () => socket,
    api: new FeishuApi({ appId: 'cli_a1b2c3d4e5f6a7b8', secret, domain: 'https://open.feishu.cn', fetch: server.fetch }),
    warn: message => warnings.push(message),
  })
  return { adapter, server, socket, warnings }
}

function dataFrame(event: unknown): Frame {
  return { SeqID: 1n, LogID: 1n, service: 2, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }], payload: new TextEncoder().encode(JSON.stringify(event)) }
}

const dm = { kind: 'direct', chatId: 'oc_dm' } as const

async function failure(promise: Promise<unknown>): Promise<ChatAdapterError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ChatAdapterError)
  return error as ChatAdapterError
}

describe('run', () => {
  it('learns the bot identity, delivers normalized events, and ignores unsupported ones', async () => {
    const { adapter, socket } = setup()
    const events: ChatInbound[] = []
    const controller = new AbortController()
    const run = adapter.run({ accept: (event) => { events.push(event); return Promise.resolve() } }, controller.signal)
    await vi.waitFor(() => { expect(socket.listenerCount('message')).toBe(1) })
    socket.emit('open')
    socket.emit('message', Buffer.from(encodeFrame(dataFrame(fixtures.groupMention))))
    socket.emit('message', Buffer.from(encodeFrame(dataFrame(fixtures.otherEvent))))
    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(events[0]).toMatchObject({ type: 'message', addressed: true })
    controller.abort()
    await run
  })

  it('runs without a known bot open id when the info answer has none', async () => {
    const { adapter, server, socket } = setup()
    server.script('GET /open-apis/bot/v3/info', { body: { bot: {} } })
    const events: ChatInbound[] = []
    const controller = new AbortController()
    const run = adapter.run({ accept: (event) => { events.push(event); return Promise.resolve() } }, controller.signal)
    await vi.waitFor(() => { expect(socket.listenerCount('message')).toBe(1) })
    socket.emit('open')
    socket.emit('message', Buffer.from(encodeFrame(dataFrame(fixtures.groupMention))))
    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    expect(events[0]).toMatchObject({ addressed: false })
    controller.abort()
    await run
  })

  it('classifies failures and stays quiet when aborted', async () => {
    const credentials = setup()
    credentials.server.script('GET /open-apis/bot/v3/info', { code: 99991663, status: 400, msg: 'invalid token' })
    expect((await failure(credentials.adapter.run({ accept: () => Promise.resolve() }, new AbortController().signal))).code).toBe('auth-failed')
    const dropped = setup()
    const run = dropped.adapter.run({ accept: () => Promise.resolve() }, new AbortController().signal)
    await vi.waitFor(() => { expect(dropped.socket.listenerCount('close')).toBe(1) })
    dropped.socket.emit('close')
    expect((await failure(run)).code).toBe('network')
    const quiet = setup()
    const controller = new AbortController()
    controller.abort()
    quiet.server.script('GET /open-apis/bot/v3/info', { throws: new TypeError('aborted') })
    await expect(quiet.adapter.run({ accept: () => Promise.resolve() }, controller.signal)).resolves.toBeUndefined()
    await quiet.adapter.stop()
  })
})

describe('classify', () => {
  it('maps every failure shape', () => {
    const original = new ChatAdapterError('network', 'feishu', 'x')
    expect(classify(original, 'send')).toBe(original)
    expect(classify('plain', 'send')).toMatchObject({ code: 'send-failed' })
    expect(classify(new FeishuApiError('x', { code: 99991663 }), 'send')).toMatchObject({ code: 'auth-failed' })
    expect(classify(new FeishuApiError('x', { status: 401 }), 'edit')).toMatchObject({ code: 'auth-failed' })
    expect(classify(new FeishuApiError('x', { status: 429, retryAfterSeconds: 4 }), 'send')).toMatchObject({ code: 'rate-limited', retryAfterMs: 4_000 })
    expect(classify(new FeishuApiError('x', { status: 429 }), 'send')).toMatchObject({ retryAfterMs: 1_000 })
    expect(classify(new FeishuApiError('x', { status: 413 }), 'send')).toMatchObject({ code: 'file-too-large' })
    expect(classify(new FeishuApiError('file size exceeds the limit'), 'send')).toMatchObject({ code: 'file-too-large' })
    expect(classify(new FeishuApiError('x', { status: 500 }), 'run')).toMatchObject({ code: 'network' })
    expect(classify(new FeishuApiError('x', { status: 404 }), 'download')).toMatchObject({ code: 'network' })
    expect(classify(new FeishuApiError('x', { status: 400 }), 'edit')).toMatchObject({ code: 'edit-failed' })
    expect(classify(new FeishuApiError('x', { status: 400 }), 'send')).toMatchObject({ code: 'send-failed' })
  })
})

describe('outbound', () => {
  it('declares what Feishu supports', () => {
    expect(FEISHU_CAPABILITIES).toMatchObject({ textFormat: 'lark-md', editOutbound: true, typingIndicator: false, interactionButtons: true, threads: false })
    expect(setup().adapter.directRoute('ou_1')).toEqual({ kind: 'direct', chatId: 'ou_1' })
  })

  it('sends text as a markdown card to a chat or, for a user id, to that user', async () => {
    const { adapter, server } = setup()
    const ref = await adapter.send(dm, { text: '**hi**' })
    expect(ref.route).toEqual(dm)
    const sent = server.to('/open-apis/im/v1/messages')[0]!
    expect(sent.query).toEqual({ receive_id_type: 'chat_id' })
    expect(sent.json).toMatchObject({ receive_id: 'oc_dm', msg_type: 'interactive' })
    expect(JSON.parse((sent.json as { content: string }).content)).toMatchObject({ elements: [{ tag: 'markdown', content: '**hi**' }] })
    await adapter.send({ kind: 'direct', chatId: 'ou_alice' }, { text: 'private' })
    expect(server.to('/open-apis/im/v1/messages')[1]?.query).toEqual({ receive_id_type: 'open_id' })
  })

  it('replies to a message when asked', async () => {
    const { adapter, server } = setup()
    await adapter.send({ kind: 'group', chatId: 'oc_group' }, { text: 'answer', replyToMessageId: 'om_1' })
    expect(server.to('/open-apis/im/v1/messages/om_1/reply')).toHaveLength(1)
    expect(server.to('/open-apis/im/v1/messages')).toHaveLength(0)
  })

  it('updates a card in place and recalls a message', async () => {
    const { adapter, server } = setup()
    const ref = { messageId: 'om_9', route: dm }
    await adapter.edit(ref, { text: 'updated' })
    expect(server.calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_9' })
    await adapter.recall(ref)
    expect(server.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/open-apis/im/v1/messages/om_9' })
  })

  it('classifies send, edit, and recall failures', async () => {
    const { adapter, server } = setup()
    server.script('POST /open-apis/im/v1/messages', { code: 230001, status: 400, msg: 'bad' })
    expect((await failure(adapter.send(dm, { text: 'x' }))).code).toBe('send-failed')
    server.script('PATCH /open-apis/im/v1/messages/om_9', { code: 230001, status: 400, msg: 'bad' })
    expect((await failure(adapter.edit({ messageId: 'om_9', route: dm }, { text: 'x' }))).code).toBe('edit-failed')
    server.script('DELETE /open-apis/im/v1/messages/om_9', { code: 230001, status: 400, msg: 'bad' })
    expect((await failure(adapter.recall({ messageId: 'om_9', route: dm }))).code).toBe('send-failed')
  })

  it('sends a button card and later settles it with the remembered body', async () => {
    const { adapter, server } = setup()
    const ref = await adapter.sendInteraction(dm, { kind: 'approval', body: 'Run bash?', actions: [{ id: 'approve:k1', label: 'Approve' }, { id: 'reject:k1', label: 'Reject' }] })
    const card = JSON.parse((server.to('/open-apis/im/v1/messages')[0]!.json as { content: string }).content) as { elements: Array<{ tag: string; actions?: Array<{ type: string; value: unknown; text: { content: string } }> }> }
    expect(card.elements[1]?.actions?.map(button => [button.type, button.text.content, button.value])).toEqual([['primary', 'Approve', { action: 'approve:k1' }], ['default', 'Reject', { action: 'reject:k1' }]])
    await adapter.settleInteraction(ref, 'answered')
    const settled = JSON.parse((server.calls.at(-1)!.json as { content: string }).content) as { elements: Array<{ content: string }> }
    expect(settled.elements[0]?.content).toBe('Run bash?\n\n*(answered)*')
    await adapter.settleInteraction(ref, 'expired')
    expect(JSON.parse((server.calls.at(-1)!.json as { content: string }).content)).toMatchObject({ elements: [{ content: '*(expired)*' }] })
  })

  it('remembers a bounded number of prompts', async () => {
    const { adapter } = setup()
    const first = await adapter.sendInteraction(dm, { kind: 'question', body: 'first', actions: [{ id: 'a', label: 'A' }] })
    for (let index = 0; index < 200; index += 1) await adapter.sendInteraction(dm, { kind: 'question', body: `q${String(index)}`, actions: [{ id: 'a', label: 'A' }] })
    await adapter.settleInteraction(first, 'answered')
  })

  it('uploads a file and sends it as a file message', async () => {
    const { adapter, server } = setup()
    const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-'))
    roots.push(root)
    await writeFile(join(root, 'r.txt'), 'hello')
    await adapter.sendFile(dm, { filePath: join(root, 'r.txt'), fileName: 'r.txt', bytes: 5, mediaType: 'text/plain' })
    const form = server.to('/open-apis/im/v1/files')[0]!.form!
    expect([form.get('file_type'), form.get('file_name')]).toEqual(['stream', 'r.txt'])
    expect(await (form.get('file') as File).text()).toBe('hello')
    expect(server.to('/open-apis/im/v1/messages')[0]?.json).toMatchObject({ msg_type: 'file', content: JSON.stringify({ file_key: 'file_key_1' }) })
    await adapter.sendFile(dm, { filePath: join(root, 'r.txt'), fileName: 'r.txt', bytes: 5 })
    expect((server.to('/open-apis/im/v1/files')[1]!.form!.get('file') as File).type).toBe('application/octet-stream')
    expect((await failure(adapter.sendFile(dm, { filePath: join(root, 'absent'), fileName: 'absent', bytes: 1 }))).code).toBe('send-failed')
  })
})

describe('fetchAttachment', () => {
  async function read(stream: ReadableStream): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }

  it('streams a resource with the response or declared media type', async () => {
    const { adapter, server } = setup()
    server.resources.set('key1', { body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/png' } })
    const fromHeader = await adapter.fetchAttachment({ attachmentId: 'om_1:key1:image' }, 100, new AbortController().signal)
    expect(fromHeader.mediaType).toBe('image/png')
    expect(await read(fromHeader.stream)).toEqual(new Uint8Array([1, 2, 3]))
    const declared = await adapter.fetchAttachment({ attachmentId: 'om_1:key1:image', mediaType: 'image/jpeg' }, 100, new AbortController().signal)
    expect(declared.mediaType).toBe('image/jpeg')
    await read(declared.stream)
    server.resources.set('bare', { body: new Uint8Array([1]) })
    expect((await adapter.fetchAttachment({ attachmentId: 'om_1:bare:file' }, 100, new AbortController().signal)).mediaType).toMatch(/octet-stream|^$/)
  })

  it('refuses oversized, malformed, and missing resources', async () => {
    const { adapter, server } = setup()
    server.resources.set('big', { body: new Uint8Array(500), headers: { 'content-length': '500' } })
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'om_1:big:file' }, 100, new AbortController().signal))).code).toBe('file-too-large')
    server.resources.set('stream', { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(60)); controller.enqueue(new Uint8Array(60)); controller.close() } }) })
    const { stream } = await adapter.fetchAttachment({ attachmentId: 'om_1:stream:file' }, 100, new AbortController().signal)
    await expect(read(stream)).rejects.toMatchObject({ code: 'file-too-large' })
    server.resources.set('empty', { body: null })
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'om_1:empty:file' }, 100, new AbortController().signal))).code).toBe('network')
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'garbage' }, 100, new AbortController().signal))).code).toBe('network')
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'om_1:absent:file' }, 100, new AbortController().signal))).code).toBe('network')
  })
})
