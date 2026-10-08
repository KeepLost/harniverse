import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as cloudflarePlugin from '../src/index.ts'
import {
  CloudflareSearchProvider,
  mapCloudflareItem,
  mapCloudflareResponse,
} from '../src/provider.ts'
import type { CloudflareSearchProviderOptions } from '../src/provider.ts'

const options: CloudflareSearchProviderOptions = {
  apiKey: 'cf-token',
  baseURL: 'https://cloudflare.test/client/v4',
  accountId: 'acct123',
  gatewayId: 'default',
  engine: 'ceramic',
  snippetMaxChars: 2000,
}

const ENDPOINT = 'https://cloudflare.test/client/v4/accounts/acct123/ai/websearch/'

function provider(value: CloudflareSearchProviderOptions): CloudflareSearchProvider {
  return new CloudflareSearchProvider(() => value)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function sentBody(fetchMock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[index] as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Cloudflare response mapping', () => {
  it('maps url, title, and description to the portable source shape', () => {
    expect(mapCloudflareItem({
      url: 'https://a.test',
      title: 'A',
      description: 'summary',
      imageUrl: 'https://a.test/i.png',
      faviconUrl: 'https://a.test/f.ico',
      lastModifiedDate: '2026-10-01T16:47:53.939Z',
    }, 2000)).toEqual({ url: 'https://a.test', title: 'A', snippet: 'summary' })
  })

  it('drops unusable items and omits blank optional fields', () => {
    expect(mapCloudflareItem(null, 2000)).toBeUndefined()
    expect(mapCloudflareItem('https://a.test', 2000)).toBeUndefined()
    expect(mapCloudflareItem({ title: 'no url' }, 2000)).toBeUndefined()
    expect(mapCloudflareItem({ url: '  ' }, 2000)).toBeUndefined()
    expect(mapCloudflareItem({ url: 'https://a.test', title: '', description: '  ' }, 2000))
      .toEqual({ url: 'https://a.test' })
    expect(mapCloudflareItem({ url: 'https://a.test', title: 1, description: 2 }, 2000))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps the items array and tolerates a malformed envelope', () => {
    expect(mapCloudflareResponse({
      items: [{ url: 'https://a.test', title: 'A' }, { title: 'dropped' }, { url: 'https://b.test' }],
      metadata: { query: 'q', requestId: 'r', latencyMs: 1 },
    }, 2000)).toEqual({
      sources: [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test' }],
      truncated: false,
    })
    for (const body of [null, 'text', [], {}, { items: 'not an array' }]) {
      expect(mapCloudflareResponse(body, 2000)).toEqual({ sources: [], truncated: false })
    }
  })

  it('bounds snippets without splitting a surrogate pair', () => {
    const description = 'aaa😀b'
    expect(mapCloudflareItem({ url: 'https://a.test', description }, 10)?.snippet).toBe(description)
    expect(mapCloudflareItem({ url: 'https://a.test', description }, 6)?.snippet).toBe(description)
    expect(mapCloudflareItem({ url: 'https://a.test', description }, 5)?.snippet).toBe('aaa😀')
    expect(mapCloudflareItem({ url: 'https://a.test', description }, 4)?.snippet).toBe('aaa')
    expect(mapCloudflareItem({ url: 'https://a.test', description }, 3)?.snippet).toBe('aaa')
  })
})

describe('CloudflareSearchProvider', () => {
  it('reports availability only for a credential and valid local options', () => {
    expect(provider(options).available()).toBe(true)
    expect(provider({ ...options, apiKey: '' }).available()).toBe(false)
    expect(provider({ ...options, apiKey: '', resolveApiKey: async () => undefined }).available()).toBe(true)
    expect(provider({ ...options, baseURL: 'not a URL' }).available()).toBe(false)
    expect(provider({ ...options, gatewayId: '  ' }).available()).toBe(false)
    expect(provider({ ...options, byokAlias: 'my_alias-1' }).available()).toBe(true)
    expect(provider({ ...options, byokAlias: '' }).available()).toBe(false)
    expect(provider({ ...options, byokAlias: 'bad alias!' }).available()).toBe(false)
    expect(provider({ ...options, snippetMaxChars: 0 }).available()).toBe(false)
    expect(provider({ ...options, snippetMaxChars: 1.5 }).available()).toBe(false)
  })

  it('posts the documented body with bearer authorization and rejects redirects', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider(options).search({ query: 'hello world' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(ENDPOINT)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(init.headers).toMatchObject({
      authorization: 'Bearer cf-token',
      accept: 'application/json',
      'content-type': 'application/json',
    })
    expect(sentBody(fetchMock)).toEqual({
      query: 'hello world',
      provider: 'ceramic',
      options: { gateway: { id: 'default' } },
    })
  })

  it('sends the configured engine, gateway, BYOK alias, and a capped result limit', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const configured = { ...options, engine: 'exa' as const, gatewayId: 'team-gw', byokAlias: 'mine' }
    await provider(configured).search({ query: 'q', maxResults: 5 })
    await provider(configured).search({ query: 'q', maxResults: 50 })
    expect(sentBody(fetchMock, 0)).toEqual({
      query: 'q',
      provider: 'exa',
      limit: 5,
      byokAlias: 'mine',
      options: { gateway: { id: 'team-gw' } },
    })
    expect(sentBody(fetchMock, 1)).toMatchObject({ limit: 10 })
  })

  it('trims endpoint slashes and the account id, and passes an active signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider({ ...options, baseURL: `${options.baseURL}///`, accountId: '  acct123 ' })
      .search({ query: 'hello' }, controller.signal)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(ENDPOINT)
    expect(init.signal).toBe(controller.signal)
  })

  it('maps a real-shaped success body and bounds each snippet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      items: [
        { url: 'https://a.test', title: 'A', description: 'x'.repeat(50) },
        { url: 'https://b.test', title: 'B', description: 'short', lastModifiedDate: '2026-10-01T16:47:53.939Z' },
      ],
      metadata: { query: 'q', requestId: 'req-1', latencyMs: 612 },
    })))
    await expect(provider({ ...options, snippetMaxChars: 20 }).search({ query: 'q' })).resolves.toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'x'.repeat(20) },
        { url: 'https://b.test', title: 'B', snippet: 'short' },
      ],
      truncated: false,
    })
  })

  it.each([undefined, '', '  ', 'acct/../x', 'a b'])('rejects account id %j before any credential or network work', async (accountId) => {
    const resolveApiKey = vi.fn(async () => 'key')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { accountId: _omitted, ...rest } = options
    await expect(provider({ ...rest, ...accountId === undefined ? {} : { accountId }, apiKey: '', resolveApiKey })
      .search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIG_INVALID',
      message: expect.stringContaining('"accountId"') as unknown,
    })
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses a resolved credential for the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ ...options, apiKey: '', resolveApiKey: async () => 'resolved-key' }).search({ query: 'hello' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer resolved-key')
  })

  it('resolves a missing credential reference per operation', async () => {
    const resolveApiKey = vi.fn(async () => undefined)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const missing = { ...options, apiKey: '', apiKeyEnv: credentialRef('CF_ROTATED_TOKEN'), resolveApiKey }
    await expect(provider(missing).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    await expect(provider(missing).search({ query: 'q' })).rejects.toThrow('CF_ROTATED_TOKEN')
    expect(resolveApiKey).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports credential resolver failures and the default missing reference', async () => {
    await expect(provider({ ...options, apiKey: '', resolveApiKey: () => Promise.reject(new Error('credential backend failed')) })
      .search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Cloudflare search credential resolution failed: Error: credential backend failed',
    })
    await expect(provider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('Cloudflare search has no API token for "CLOUDFLARE_API_TOKEN"')
  })

  it('aborts an uncooperative credential resolver and observes synchronous cancellation', async () => {
    const resolveApiKey = vi.fn(() => new Promise<string>(() => {}))
    const controller = new AbortController()
    const search = provider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const cancelled = new AbortController()
    await expect(provider({
      ...options,
      apiKey: '',
      resolveApiKey: () => {
        cancelled.abort(new Error('resolver cancelled caller'))
        return Promise.resolve('unused-key')
      },
    }).search({ query: 'q' }, cancelled.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('normalizes credential rejection after an abortable wait', async () => {
    let rejectCredential!: (reason: unknown) => void
    const resolveApiKey = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectCredential = reject }))
    const search = provider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, new AbortController().signal)
    rejectCredential('credential backend failed')
    await expect(search).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Cloudflare search credential resolution failed: Error: credential backend failed',
    })
    let rejectError!: (reason: unknown) => void
    const errorSearch = provider({ ...options, apiKey: '', resolveApiKey: () => new Promise<string>((_resolve, reject) => { rejectError = reject }) })
      .search({ query: 'q' }, new AbortController().signal)
    rejectError(new Error('credential backend failed'))
    await expect(errorSearch).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('cleans up an active signal after credential resolution succeeds', async () => {
    let resolveCredential!: (value: string) => void
    const resolveApiKey = vi.fn(() => new Promise<string>((resolve) => { resolveCredential = resolve }))
    const controller = new AbortController()
    const search = provider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal)
    resolveCredential('resolved-key')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })))
    await expect(search).resolves.toEqual({ sources: [], truncated: false })
  })

  it('maps pre-abort, network, and fetch abort failures', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    await expect(provider(options).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Cloudflare search request failed: TypeError: connection refused',
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it.each([
    ['errors array', { success: false, errors: [{ code: 9106, message: 'Authentication failed (status: 400)' }], messages: [], result: null }, 'Authentication failed (status: 400)'],
    ['error array', { success: false, result: [], error: [{ code: 2001, message: 'Please configure AI Gateway in the Cloudflare dashboard' }], name: 'AiGatewayError' }, 'Please configure AI Gateway in the Cloudflare dashboard'],
    ['skips non-record entries', { errors: [null, { code: 1 }, { message: 'second wins' }] }, 'second wins'],
    ['top-level message', { success: false, message: 'plain message' }, 'plain message'],
    ['gateway error code', { ok: false, error: { category: 'gateway', code: 'invalid_web_search_input', status: 400, retryable: false } }, 'invalid_web_search_input'],
  ])('surfaces the Cloudflare error detail: %s', async (_name, body, detail) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, { status: 400 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: `Cloudflare web search failed: ${detail}`,
    })
  })

  it.each([
    ['plain text', new Response('upstream error', { status: 503 }), 503],
    ['empty object', jsonResponse({}, { status: 500 }), 500],
    ['non-object json', jsonResponse(['x'], { status: 502 }), 502],
    ['entries without a message', jsonResponse({ errors: [{ code: 1 }], error: {} }, { status: 504 }), 504],
  ])('uses the status-line message for unusable error bodies: %s', async (_name, response, status) => {
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: `Cloudflare API error (HTTP ${status})`,
    })
  })

  it('maps malformed success bodies and body-parser aborts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('Cloudflare returned an unprocessable response body') as unknown,
    })
    const successBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => successBody as unknown as Response))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    const errorBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => errorBody as unknown as Response))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('observes an abort that lands while the body is being read', async () => {
    const controller = new AbortController()
    const body = { json: () => { controller.abort(); return Promise.resolve({ items: [] }) }, ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(provider(options).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('maps a caller abort during the fetch operation', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('custom abort reason')) }, { once: true })
      })))
    const search = provider(options).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('timeout reason'))
    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})

describe('Cloudflare plugin registration', () => {
  it('registers and disposes through the aggregate web provider', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: cloudflarePlugin.CLOUDFLARE_PROVIDER_ID })
    const fiber = await ctx.plugin(cloudflarePlugin, {
      apiKey: 'cf-token',
      accountId: 'acct123',
      engine: 'linkup',
      byokAlias: 'mine',
      gatewayId: 'team-gw',
      baseURL: 'https://cloudflare.test/client/v4',
    })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    expect(sentBody(fetchMock)).toEqual({
      query: 'q',
      provider: 'linkup',
      byokAlias: 'mine',
      options: { gateway: { id: 'team-gw' } },
    })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('has no default export', () => { expect('default' in cloudflarePlugin).toBe(false) })

  it('requires an account id even when a credential exists', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: cloudflarePlugin.CLOUDFLARE_PROVIDER_ID })
    await ctx.plugin(cloudflarePlugin, { apiKey: 'cf-token' })
    try {
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIG_INVALID' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves the default token and endpoint from the launching environment', async () => {
    const previous = process.env.CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = 'ambient-token'
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: cloudflarePlugin.CLOUDFLARE_PROVIDER_ID })
      cloudflarePlugin.apply(ctx, { accountId: 'acct123' })
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/websearch/')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer ambient-token')
      expect(sentBody(fetchMock)).toEqual({ query: 'q', provider: 'ceramic', options: { gateway: { id: 'default' } } })
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = previous
    }
  })

  it('resolves and rotates a stored credential without restarting the plugin', async () => {
    const previous = process.env.CLOUDFLARE_API_TOKEN
    delete process.env.CLOUDFLARE_API_TOKEN
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-cloudflare-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: cloudflarePlugin.CLOUDFLARE_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(cloudflarePlugin, { accountId: 'acct123', baseURL: 'https://cloudflare.entry.test/client/v4' })
      await expect(ctx.web.search({ query: 'missing' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      await ctx.credentials.set(credentialRef('CLOUDFLARE_API_TOKEN'), 'stored-token')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(credentialRef('CLOUDFLARE_API_TOKEN'), 'rotated-token')
      await ctx.web.search({ query: 'rotated' })
      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value.authorization)).toEqual(['Bearer stored-token', 'Bearer rotated-token'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous !== undefined) process.env.CLOUDFLARE_API_TOKEN = previous
    }
  })

  it('reports the default credential reference when the environment is empty', async () => {
    const previous = process.env.CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = ''
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: cloudflarePlugin.CLOUDFLARE_PROVIDER_ID })
      cloudflarePlugin.apply(ctx, { accountId: 'acct123' })
      await expect(ctx.web.search({ query: 'q' })).rejects.toThrow('CLOUDFLARE_API_TOKEN')
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = previous
    }
  })
})
