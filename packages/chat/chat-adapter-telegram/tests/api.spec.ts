/** Bot API client: request shape, error facts, and file download safety. */

import { describe, expect, it } from 'vitest'
import { TelegramApi, TelegramApiError } from '../src/api.ts'
import { FakeBotApi } from './fixtures/bot-api.ts'

const TOKEN = '777000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function client(server = new FakeBotApi()): { api: TelegramApi; server: FakeBotApi } {
  return { server, api: new TelegramApi({ baseUrl: 'https://api.telegram.org/', fetch: server.fetch, token: () => Promise.resolve(TOKEN) }) }
}

async function failure(promise: Promise<unknown>): Promise<TelegramApiError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(TelegramApiError)
  return error as TelegramApiError
}

describe('TelegramApi.call', () => {
  it('posts JSON to the token-bearing method URL and returns the result', async () => {
    const { api, server } = client()
    expect(await api.call('getMe', {})).toMatchObject({ id: 777000 })
    expect(server.calls[0]?.url.href).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`)
  })

  it('long-polls with the documented parameters', async () => {
    const { api, server } = client()
    server.pending({ update_id: 1 })
    expect(await api.getUpdates(5, 25, new AbortController().signal)).toEqual([{ update_id: 1 }])
    expect(server.calls[0]?.payload).toEqual({ timeout: 25, limit: 100, allowed_updates: ['message', 'edited_message', 'callback_query'], offset: 5 })
    server.pending()
    await api.getUpdates(undefined, 25, new AbortController().signal)
    expect(server.calls[1]?.payload).not.toHaveProperty('offset')
  })

  it('reports the status, provider code, and retry hint of a refusal', async () => {
    const { api, server } = client()
    server.script('sendMessage', { error: { status: 429, description: 'Too Many Requests', retry_after: 7 } })
    const limited = await failure(api.call('sendMessage', {}))
    expect(limited).toMatchObject({ status: 429, providerCode: 429, retryAfterSeconds: 7, transport: false, aborted: false })
    server.script('sendMessage', { error: { status: 403, error_code: 403, description: 'Forbidden: bot was blocked' } })
    expect(await failure(api.call('sendMessage', {}))).toMatchObject({ status: 403, message: 'Forbidden: bot was blocked' })
    server.script('sendMessage', { raw: Response.json({ ok: false }, { status: 400 }) })
    expect((await failure(api.call('sendMessage', {}))).message).toBe('Telegram sendMessage failed')
    server.script('sendMessage', { raw: Response.json({ ok: false, parameters: { retry_after: -1 } }, { status: 400 }) })
    expect((await failure(api.call('sendMessage', {}))).retryAfterSeconds).toBeUndefined()
  })

  it('reports a transport failure, an aborted request, and a non-JSON answer', async () => {
    const { api, server } = client()
    server.script('getMe', { throws: new TypeError('fetch failed') })
    expect(await failure(api.call('getMe', {}))).toMatchObject({ transport: true, aborted: false })
    const controller = new AbortController()
    controller.abort()
    expect(await failure(api.call('getMe', {}, { signal: controller.signal }))).toMatchObject({ transport: true, aborted: true })
    server.script('getMe', { raw: new Response('<html>', { status: 502 }) })
    expect(await failure(api.call('getMe', {}))).toMatchObject({ transport: true, status: 502 })
  })

  it('sends multipart bodies without a JSON content type', async () => {
    const { api, server } = client()
    const form = new FormData()
    form.append('chat_id', '1')
    await api.call('sendDocument', form)
    expect(server.calls[0]?.form?.get('chat_id')).toBe('1')
  })
})

describe('TelegramApi.download', () => {
  it('resolves the file path and fetches the file URL', async () => {
    const { api, server } = client()
    server.files.set('f1', { path: 'documents/file_1.bin', size: 3, body: new Uint8Array([1, 2, 3]) })
    const { response, size } = await api.download('f1', new AbortController().signal)
    expect(size).toBe(3)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(server.fileRequests[0]?.href).toBe(`https://api.telegram.org/file/bot${TOKEN}/documents/file_1.bin`)
  })

  it.each(['/etc/passwd', 'a/../b', 'a//b', 'a\\b', './x'])('refuses the file path %j', async (path) => {
    const { api, server } = client()
    server.script('getFile', { result: { file_path: path } })
    expect((await failure(api.download('f', new AbortController().signal))).message).toBe('Telegram returned an invalid file path')
  })

  it('refuses a missing file path, a failed download, and a transport failure', async () => {
    const { api, server } = client()
    server.script('getFile', { result: {} })
    expect((await failure(api.download('f', new AbortController().signal))).message).toBe('Telegram returned an invalid file path')
    server.script('getFile', { result: { file_path: 'x/y' } })
    expect(await failure(api.download('f', new AbortController().signal))).toMatchObject({ status: 404 })
    const failing = new TelegramApi({ baseUrl: 'https://api.telegram.org', fetch: (input, init) => input.pathname.includes('/file/') ? Promise.reject(new TypeError('down')) : server.fetch(input, init), token: () => Promise.resolve(TOKEN) })
    expect(await failure(failing.download('f', new AbortController().signal))).toMatchObject({ transport: true })
  })
})
