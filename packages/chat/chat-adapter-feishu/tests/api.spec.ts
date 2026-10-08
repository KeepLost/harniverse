/** Open API client: token caching and refresh, error facts, and resource download. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeishuApi, FeishuApiError, APP_ID_PATTERN } from '../src/api.ts'
import { FakeOpenApi } from './fixtures/open-api.ts'

afterEach(() => { vi.useRealTimers() })

function client(server = new FakeOpenApi()): { api: FeishuApi; server: FakeOpenApi } {
  return { server, api: new FeishuApi({ appId: 'cli_a1b2c3d4e5f6a7b8', secret: () => Promise.resolve('s3cret'), domain: 'https://open.feishu.cn', fetch: server.fetch }) }
}

async function failure(promise: Promise<unknown>): Promise<FeishuApiError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(FeishuApiError)
  return error as FeishuApiError
}

describe('FeishuApi.call', () => {
  it('fetches a tenant token once, caches it, and sends it as a Bearer header with query and JSON', async () => {
    const { api, server } = client()
    await api.call({ method: 'POST', path: '/open-apis/im/v1/messages', query: { receive_id_type: 'chat_id' }, json: { a: 1 } })
    await api.call({ method: 'GET', path: '/open-apis/bot/v3/info' })
    expect(server.tokens).toBe(1)
    const sent = server.to('/open-apis/im/v1/messages')[0]!
    expect(sent.headers.get('authorization')).toBe('Bearer t-1')
    expect(sent.query).toEqual({ receive_id_type: 'chat_id' })
    expect(sent.json).toEqual({ a: 1 })
    expect(server.to('/open-apis/auth/v3/tenant_access_token/internal')[0]?.json).toEqual({ app_id: 'cli_a1b2c3d4e5f6a7b8', app_secret: 's3cret' })
  })

  it('fetches a new token shortly before the old one expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { api, server } = client()
    await api.call({ method: 'GET', path: '/open-apis/bot/v3/info' })
    vi.setSystemTime(Date.now() + 7_100_000)
    await api.call({ method: 'GET', path: '/open-apis/bot/v3/info' })
    expect(server.tokens).toBe(1)
    vi.setSystemTime(Date.now() + 50_000)
    await api.call({ method: 'GET', path: '/open-apis/bot/v3/info' })
    expect(server.tokens).toBe(2)
  })

  it('replaces a rejected token once and retries', async () => {
    const { api, server } = client()
    server.script('GET /open-apis/bot/v3/info', { code: 99991663, msg: 'invalid token', status: 400 }, { data: { fine: true } })
    expect(await api.call({ method: 'GET', path: '/open-apis/bot/v3/info' })).toEqual({ fine: true })
    expect(server.tokens).toBe(2)
  })

  it('surfaces a token that stays rejected and other failures', async () => {
    const { api, server } = client()
    server.script('GET /open-apis/bot/v3/info', { code: 99991663, msg: 'invalid token', status: 400 })
    const rejected = await failure(api.call({ method: 'GET', path: '/open-apis/bot/v3/info' }))
    expect(rejected).toMatchObject({ code: 99991663, status: 400, credentialRejected: true })
    server.script('POST /open-apis/im/v1/messages', { code: 230001, msg: 'bad param', status: 400, headers: { 'x-ogw-ratelimit-reset': '7' } })
    expect(await failure(api.call({ method: 'POST', path: '/open-apis/im/v1/messages' }))).toMatchObject({ code: 230001, retryAfterSeconds: 7, credentialRejected: false })
    server.script('POST /open-apis/im/v1/messages', { raw: Response.json({ nope: true }, { status: 500 }) })
    const bare = await failure(api.call({ method: 'POST', path: '/open-apis/im/v1/messages' }))
    expect(bare).toMatchObject({ status: 500, message: 'Feishu /open-apis/im/v1/messages failed', credentialRejected: false })
    expect(bare.code).toBeUndefined()
  })

  it('reports transport failures, unreadable answers, and a token endpoint without a token', async () => {
    const { api, server } = client()
    server.script('GET /open-apis/bot/v3/info', { throws: new TypeError('fetch failed') })
    expect(await failure(api.call({ method: 'GET', path: '/open-apis/bot/v3/info' }))).toMatchObject({ transport: true })
    server.script('GET /open-apis/bot/v3/info', { raw: new Response('<html>', { status: 502 }) })
    expect(await failure(api.call({ method: 'GET', path: '/open-apis/bot/v3/info' }))).toMatchObject({ transport: true, status: 502 })
    const { api: tokenless, server: tokenServer } = client()
    tokenServer.script('POST /open-apis/auth/v3/tenant_access_token/internal', { data: {} })
    expect((await failure(tokenless.call({ method: 'GET', path: '/x' }))).message).toBe('token endpoint returned no token')
  })

  it('defaults the token lifetime and accepts an answer without a code', async () => {
    const { api, server } = client()
    server.script('POST /open-apis/auth/v3/tenant_access_token/internal', { body: { tenant_access_token: 'tok' } })
    server.script('GET /x', { raw: Response.json({}) })
    expect(await api.call({ method: 'GET', path: '/x' })).toEqual({})
  })

  it('returns the whole body for endpoints that answer outside data', async () => {
    const { api } = client()
    expect(await api.callBody({ method: 'GET', path: '/open-apis/bot/v3/info' })).toMatchObject({ code: 0, bot: { open_id: 'ou_bot' } })
  })

  it('answers an authenticated call without data with an empty object and honors a caller signal', async () => {
    const { api, server } = client()
    server.script('DELETE /open-apis/im/v1/messages/om_1', { code: 0 })
    expect(await api.call({ method: 'DELETE', path: '/open-apis/im/v1/messages/om_1', signal: new AbortController().signal })).toEqual({})
  })

  it('recognizes credential error codes', () => {
    expect(new FeishuApiError('x', { code: 10014 }).credentialRejected).toBe(true)
    expect(new FeishuApiError('x', { code: 1 }).credentialRejected).toBe(false)
    expect(new FeishuApiError('x').credentialRejected).toBe(false)
    expect(APP_ID_PATTERN.test('cli_a1b2c3d4e5f6a7b8')).toBe(true)
    expect(APP_ID_PATTERN.test('app_1')).toBe(false)
  })
})

describe('FeishuApi.download', () => {
  it('fetches a message resource with the resource type', async () => {
    const { api, server } = client()
    server.resources.set('key1', { body: new Uint8Array([1, 2]) })
    const response = await api.download('om_1', 'key1', 'image', new AbortController().signal)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
    expect(server.to('/open-apis/im/v1/messages/om_1/resources/key1')[0]?.query).toEqual({ type: 'image' })
  })

  it('replaces a rejected token once and refuses other failures', async () => {
    const { api, server } = client()
    server.resources.set('k', { body: new Uint8Array([9]) })
    server.script('GET /open-apis/im/v1/messages/om_1/resources/k', { code: 99991668, status: 400 }, { raw: new Response(new Uint8Array([9])) })
    await api.download('om_1', 'k', 'file', new AbortController().signal)
    expect(server.tokens).toBe(2)
    expect(await failure(api.download('om_1', 'missing', 'file', new AbortController().signal))).toMatchObject({ status: 404 })
    server.script('GET /open-apis/im/v1/messages/om_1/resources/k', { code: 99991663, status: 400 })
    expect(await failure(api.download('om_1', 'k', 'file', new AbortController().signal))).toMatchObject({ credentialRejected: true })
  })
})
