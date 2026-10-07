/** The Telegram adapter against a fake Bot API: polling, delivery, error classification, and outbound operations. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatAdapterError, type ChatInbound } from '@deepseek-ai/dsh-chat-adapter'
import { TelegramApi } from '../src/api.ts'
import { classify, TELEGRAM_CAPABILITIES, TelegramAdapter } from '../src/adapter.ts'
import { TelegramApiError } from '../src/api.ts'
import { FakeBotApi } from './fixtures/bot-api.ts'
import * as fixtures from './fixtures/updates.ts'

const TOKEN = '777000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function setup(): { adapter: TelegramAdapter; server: FakeBotApi; warnings: string[] } {
  const server = new FakeBotApi()
  const warnings: string[] = []
  const api = new TelegramApi({ baseUrl: 'https://api.telegram.org/', fetch: server.fetch, token: () => Promise.resolve(TOKEN) })
  return { server, warnings, adapter: new TelegramAdapter({ botId: '777000', api, pollTimeoutSeconds: 25, warn: message => warnings.push(message) }) }
}

const route = { kind: 'direct', chatId: '42' } as const

async function failure(promise: Promise<unknown>): Promise<ChatAdapterError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ChatAdapterError)
  return error as ChatAdapterError
}

describe('polling', () => {
  it('delivers normalized events in order, acknowledges offsets after acceptance, and answers button presses', async () => {
    const { adapter, server } = setup()
    server.pending(fixtures.privateText, fixtures.callback, fixtures.channelPost)
    const events: ChatInbound[] = []
    const controller = new AbortController()
    const run = adapter.run({ accept: (event) => { events.push(event); return Promise.resolve() } }, controller.signal)
    await vi.waitFor(() => { expect(server.of('getUpdates').length).toBeGreaterThanOrEqual(2) })
    controller.abort()
    await run
    expect(events.map(event => event.type)).toEqual(['message', 'interaction'])
    expect(server.of('getUpdates')[1]?.payload.offset).toBe(1014)
    expect(server.of('answerCallbackQuery')[0]?.payload).toEqual({ callback_query_id: 'cb-1' })
  })

  it('learns the bot username from getMe so group mentions address it', async () => {
    const { adapter, server } = setup()
    server.pending(fixtures.groupMention)
    const events: ChatInbound[] = []
    const controller = new AbortController()
    const run = adapter.run({ accept: (event) => { events.push(event); return Promise.resolve() } }, controller.signal)
    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    controller.abort()
    await run
    expect(events[0]).toMatchObject({ addressed: true })
  })

  it('accepts a getMe answer without a username', async () => {
    const { adapter, server } = setup()
    server.script('getMe', { result: { id: 777000 } })
    server.pending(fixtures.groupMention)
    const events: ChatInbound[] = []
    const controller = new AbortController()
    const run = adapter.run({ accept: (event) => { events.push(event); return Promise.resolve() } }, controller.signal)
    await vi.waitFor(() => { expect(events).toHaveLength(1) })
    controller.abort()
    await run
    expect(events[0]).toMatchObject({ addressed: false })
  })

  it('skips an update the bridge rejects, still advances, and tolerates a failed button acknowledgement', async () => {
    const { adapter, server, warnings } = setup()
    server.script('answerCallbackQuery', { error: { status: 400, description: 'query is too old' } })
    server.pending(fixtures.callback, fixtures.privateText)
    const controller = new AbortController()
    let calls = 0
    const run = adapter.run({ accept: () => { calls += 1; return calls === 1 ? Promise.reject(new Error('bridge broke')) : Promise.resolve() } }, controller.signal)
    await vi.waitFor(() => { expect(calls).toBe(2) })
    await vi.waitFor(() => { expect(server.of('getUpdates').length).toBeGreaterThanOrEqual(2) })
    controller.abort()
    await run
    expect(warnings).toEqual(['the bridge rejected an inbound event; skipping it'])
    expect(server.of('getUpdates')[1]?.payload.offset).toBe(1002)
  })

  it('ignores updates without an id when advancing the offset', async () => {
    const { adapter, server } = setup()
    server.pending({ message: { message_id: 1 } })
    const controller = new AbortController()
    const run = adapter.run({ accept: () => Promise.resolve() }, controller.signal)
    await vi.waitFor(() => { expect(server.of('getUpdates').length).toBeGreaterThanOrEqual(2) })
    controller.abort()
    await run
    expect(server.of('getUpdates')[1]?.payload).not.toHaveProperty('offset')
  })

  it('ends when stopped and when aborted before starting', async () => {
    const { adapter, server } = setup()
    const run = adapter.run({ accept: () => Promise.resolve() }, new AbortController().signal)
    await vi.waitFor(() => { expect(server.of('getUpdates')).toHaveLength(1) })
    await adapter.stop()
    await run
    await adapter.stop()
    const aborted = new AbortController()
    aborted.abort()
    await adapter.run({ accept: () => Promise.resolve() }, aborted.signal)
  })

  it.each([
    [{ status: 401, description: 'Unauthorized' }, 'auth-failed'],
    [{ status: 409, description: 'Conflict: terminated by other getUpdates request' }, 'poll-conflict'],
    [{ status: 429, description: 'Too Many Requests', retry_after: 3 }, 'rate-limited'],
    [{ status: 502, description: 'Bad Gateway' }, 'network'],
  ])('classifies a polling failure %j as %s', async (error, code) => {
    const { adapter, server } = setup()
    server.script('getUpdates', { error })
    const failed = await failure(adapter.run({ accept: () => Promise.resolve() }, new AbortController().signal))
    expect(failed.code).toBe(code)
    if (code === 'rate-limited') expect(failed.retryAfterMs).toBe(3_000)
  })

  it('classifies a failing getMe and a transport error as network failures', async () => {
    const { adapter, server } = setup()
    server.script('getMe', { throws: new TypeError('fetch failed') })
    expect((await failure(adapter.run({ accept: () => Promise.resolve() }, new AbortController().signal))).code).toBe('network')
  })
})

describe('classify', () => {
  it('keeps adapter errors and wraps unknown values', () => {
    const original = new ChatAdapterError('network', 'telegram', 'x')
    expect(classify(original, 'send')).toBe(original)
    expect(classify('plain', 'send')).toMatchObject({ code: 'send-failed' })
    expect(classify(new TelegramApiError('boom', { status: 500 }), 'edit')).toMatchObject({ code: 'edit-failed' })
    expect(classify(new TelegramApiError('Request Entity Too Large', { status: 413 }), 'send')).toMatchObject({ code: 'file-too-large' })
    expect(classify(new TelegramApiError('file is too big'), 'download')).toMatchObject({ code: 'file-too-large' })
    expect(classify(new TelegramApiError('conflict', { status: 409 }), 'send')).toMatchObject({ code: 'send-failed' })
    expect(classify(new TelegramApiError('slow', { status: 429 }), 'send')).toMatchObject({ code: 'rate-limited', retryAfterMs: 1_000 })
    expect(classify(new TelegramApiError('nope', { status: 400 }), 'download')).toMatchObject({ code: 'network' })
  })
})

describe('outbound', () => {
  it('declares what Telegram supports', () => {
    expect(TELEGRAM_CAPABILITIES).toMatchObject({ editOutbound: true, interactionButtons: true, maxTextLength: 4_096, minEditIntervalMs: 1_000, textFormat: 'plain' })
    expect(setup().adapter.directRoute('42')).toEqual({ kind: 'direct', chatId: '42' })
  })

  it('sends text with reply and thread targeting and returns the message reference', async () => {
    const { adapter, server } = setup()
    const ref = await adapter.send({ kind: 'group', chatId: '-100123', threadId: '9' }, { text: 'hi', replyToMessageId: '-100123:6' })
    expect(ref).toMatchObject({ route: { chatId: '-100123', threadId: '9' } })
    expect(server.calls[0]?.payload).toEqual({
      chat_id: -100123, message_thread_id: 9, text: 'hi', link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: 6, allow_sending_without_reply: true },
    })
    await adapter.send(route, { text: 'no reply', replyToMessageId: 'junk' })
    expect(server.calls[1]?.payload).not.toHaveProperty('reply_parameters')
  })

  it('classifies send failures', async () => {
    const { adapter, server } = setup()
    server.script('sendMessage', { error: { status: 403, description: 'Forbidden: bot was blocked by the user' } })
    expect((await failure(adapter.send(route, { text: 'x' }))).code).toBe('send-failed')
    server.script('sendMessage', { error: { status: 429, description: 'slow', retry_after: 2 } })
    expect(await failure(adapter.send(route, { text: 'x' }))).toMatchObject({ code: 'rate-limited', retryAfterMs: 2_000 })
    server.script('sendMessage', { error: { status: 401, description: 'Unauthorized' } })
    expect((await failure(adapter.send(route, { text: 'x' }))).code).toBe('auth-failed')
  })

  it('edits in place, treats an unchanged edit as success, and fails other edits as edit-failed', async () => {
    const { adapter, server } = setup()
    const ref = { messageId: '55', route }
    await adapter.edit(ref, { text: 'new' })
    expect(server.calls[0]).toMatchObject({ method: 'editMessageText', payload: { chat_id: 42, message_id: 55, text: 'new' } })
    server.script('editMessageText', { error: { status: 400, description: 'Bad Request: message is not modified' } })
    await expect(adapter.edit(ref, { text: 'new' })).resolves.toBeUndefined()
    server.script('editMessageText', { error: { status: 400, description: 'Bad Request: message to edit not found' } })
    expect((await failure(adapter.edit(ref, { text: 'new' }))).code).toBe('edit-failed')
  })

  it('recalls a message', async () => {
    const { adapter, server } = setup()
    await adapter.recall({ messageId: '55', route })
    expect(server.calls[0]).toMatchObject({ method: 'deleteMessage', payload: { chat_id: 42, message_id: 55 } })
  })

  it('sends an inline keyboard and later rewrites the prompt to its settled state', async () => {
    const { adapter, server } = setup()
    const ref = await adapter.sendInteraction(route, { kind: 'approval', body: 'Run bash?', actions: [{ id: 'approve:k1', label: 'Approve' }, { id: 'reject:k1', label: 'Reject' }] })
    expect(server.calls[0]?.payload.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:k1' }], [{ text: 'Reject', callback_data: 'reject:k1' }]] })
    await adapter.settleInteraction(ref, 'answered')
    expect(server.calls[1]?.payload).toMatchObject({ message_id: Number(ref.messageId), text: 'Run bash?\n\n(answered)' })
    expect(server.calls[1]?.payload).not.toHaveProperty('reply_markup')
    await adapter.settleInteraction(ref, 'expired')
    expect(server.calls[2]?.payload.text).toBe('(expired)')
  })

  it('rejects an action id Telegram would refuse and remembers a bounded number of prompts', async () => {
    const { adapter, server } = setup()
    expect((await failure(adapter.sendInteraction(route, { kind: 'approval', body: 'b', actions: [{ id: 'x'.repeat(65), label: 'L' }] }))).code).toBe('send-failed')
    expect(server.calls).toHaveLength(0)
    const first = await adapter.sendInteraction(route, { kind: 'question', body: 'first', actions: [{ id: 'a', label: 'A' }] })
    for (let index = 0; index < 200; index += 1) await adapter.sendInteraction(route, { kind: 'question', body: `q${String(index)}`, actions: [{ id: 'a', label: 'A' }] })
    await adapter.settleInteraction(first, 'answered')
    expect(server.calls.at(-1)?.payload.text).toBe('(answered)')
  })

  it('uploads a file as a document', async () => {
    const { adapter, server } = setup()
    const root = await mkdtemp(join(tmpdir(), 'dsh-telegram-'))
    roots.push(root)
    await writeFile(join(root, 'r.txt'), 'hello')
    const ref = await adapter.sendFile({ kind: 'group', chatId: '-5', threadId: '3' }, { filePath: join(root, 'r.txt'), fileName: 'r.txt', bytes: 5, mediaType: 'text/plain' })
    expect(ref.route.chatId).toBe('-5')
    const form = server.of('sendDocument')[0]!.form!
    expect([form.get('chat_id'), form.get('message_thread_id')]).toEqual(['-5', '3'])
    const document = form.get('document') as File
    expect([document.name, document.type, await document.text()]).toEqual(['r.txt', 'text/plain', 'hello'])
    await adapter.sendFile(route, { filePath: join(root, 'r.txt'), fileName: 'r.txt', bytes: 5 })
    expect((server.of('sendDocument')[1]!.form!.get('document') as File).type).toBe('application/octet-stream')
    server.script('sendDocument', { error: { status: 413, description: 'Request Entity Too Large' } })
    expect((await failure(adapter.sendFile(route, { filePath: join(root, 'r.txt'), fileName: 'r.txt', bytes: 5 }))).code).toBe('file-too-large')
    expect((await failure(adapter.sendFile(route, { filePath: join(root, 'absent'), fileName: 'absent', bytes: 1 }))).code).toBe('send-failed')
  })

  it('shows a typing hint', async () => {
    const { adapter, server } = setup()
    await adapter.setTyping({ kind: 'group', chatId: '-5', threadId: '3' })
    expect(server.calls[0]).toMatchObject({ method: 'sendChatAction', payload: { chat_id: -5, message_thread_id: 3, action: 'typing' } })
  })
})

describe('fetchAttachment', () => {
  async function read(stream: ReadableStream): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }

  it('streams a file within the cap with the declared media type or the response header', async () => {
    const { adapter, server } = setup()
    server.files.set('a', { path: 'documents/a.bin', size: 3, body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'application/zip' } })
    const declared = await adapter.fetchAttachment({ attachmentId: 'a', mediaType: 'image/png' }, 100, new AbortController().signal)
    expect(declared.mediaType).toBe('image/png')
    expect(await read(declared.stream)).toEqual(new Uint8Array([1, 2, 3]))
    const fromHeader = await adapter.fetchAttachment({ attachmentId: 'a' }, 100, new AbortController().signal)
    expect(fromHeader.mediaType).toBe('application/zip')
    await read(fromHeader.stream)
    server.files.set('b', { path: 'documents/b.bin', body: new Uint8Array([9]), headers: {} })
    expect((await adapter.fetchAttachment({ attachmentId: 'b' }, 100, new AbortController().signal)).mediaType).toMatch(/octet-stream|^$/)
  })

  it('refuses a file larger than the cap by declared size, by content-length, and while streaming', async () => {
    const { adapter, server } = setup()
    server.files.set('big', { path: 'documents/big.bin', size: 500, body: new Uint8Array(500) })
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'big' }, 100, new AbortController().signal))).code).toBe('file-too-large')
    server.files.set('len', { path: 'documents/len.bin', body: new Uint8Array(500), headers: { 'content-length': '500' } })
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'len' }, 100, new AbortController().signal))).code).toBe('file-too-large')
    server.files.set('stream', { path: 'documents/s.bin', body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(60)); controller.enqueue(new Uint8Array(60)); controller.close() } }) })
    const { stream } = await adapter.fetchAttachment({ attachmentId: 'stream' }, 100, new AbortController().signal)
    await expect(read(stream)).rejects.toMatchObject({ code: 'file-too-large' })
  })

  it('refuses a download that returns no body', async () => {
    const { adapter, server } = setup()
    server.files.set('none', { path: 'documents/none.bin', body: null })
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'none' }, 100, new AbortController().signal))).code).toBe('network')
  })

  it('caps downloads at the Bot API limit regardless of the caller cap', async () => {
    const { adapter, server } = setup()
    server.files.set('huge', { path: 'documents/h.bin', size: 30 * 1024 * 1024, body: new Uint8Array(1) })
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'huge' }, 100 * 1024 * 1024, new AbortController().signal))).code).toBe('file-too-large')
  })

  it('classifies a failed lookup as a network failure', async () => {
    const { adapter, server } = setup()
    server.script('getFile', { error: { status: 400, description: 'Bad Request: invalid file_id' } })
    expect((await failure(adapter.fetchAttachment({ attachmentId: 'x' }, 100, new AbortController().signal))).code).toBe('network')
  })
})
