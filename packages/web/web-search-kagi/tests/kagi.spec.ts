import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { KagiSearchProviderOptions } from '@deepseek-ai/dsh-web-search-kagi'
import * as kagiPlugin from '../src/index.ts'
import { KagiSearchProvider, mapKagiResponse, mapKagiResult } from '../src/provider.ts'

const options: KagiSearchProviderOptions = {
  apiKey: 'kagi-key',
  baseURL: 'https://kagi.test/api/v1',
}

function provider(value: KagiSearchProviderOptions): KagiSearchProvider {
  return new KagiSearchProvider(() => value)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Kagi response mapping', () => {
  it('maps direct result fields to the portable source shape', () => {
    expect(mapKagiResult({
      url: 'https://a.test',
      title: 'A',
      snippet: 'summary',
      published: '2026-01-01',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'summary', publishedAt: '2026-01-01' })
  })

  it('tolerates direct arrays and data/results wrappers', () => {
    const item = { url: 'https://a.test', title: 'A', snippet: 'summary' }
    expect(mapKagiResponse([item]).sources).toEqual([{ ...item }])
    expect(mapKagiResponse({ data: [item] }).sources).toEqual([{ ...item }])
    expect(mapKagiResponse({ results: [item] }).sources).toEqual([{ ...item }])
    expect(mapKagiResponse({ data: { items: [item] } }).sources).toEqual([{ ...item }])
  })

  it('drops invalid results and empty optional fields', () => {
    expect(mapKagiResult({ url: '' })).toBeUndefined()
    expect(mapKagiResult({ url: 'https://a.test', title: '', snippet: '', published: '' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapKagiResponse(null as unknown as never).sources).toEqual([])
    expect(mapKagiResponse({ data: { items: [{ title: 'missing url' }] } } as never).sources).toEqual([])
    expect(mapKagiResponse({ data: {} }).sources).toEqual([])
    expect(mapKagiResponse({ items: 'not an array' } as never).sources).toEqual([])
  })

  it('accepts a direct object and recursively unwraps nested result groups', () => {
    const item = { url: 'https://a.test', title: 'A' }
    expect(mapKagiResponse(item as never).sources).toEqual([{ ...item }])
    expect(mapKagiResponse({ data: { results: { items: [item] } } } as never).sources).toEqual([{ ...item }])
    expect(mapKagiResponse({ url: 'https://a.test', published: '2026-01-01' } as never).sources)
      .toEqual([{ url: 'https://a.test', publishedAt: '2026-01-01' }])
    expect(mapKagiResponse({ url: 'https://a.test', title: 1, published: 1 } as never).sources)
      .toEqual([{ url: 'https://a.test' }])
  })
})

describe('KagiSearchProvider', () => {
  it('reports availability only for a credential and valid endpoint', () => {
    expect(new KagiSearchProvider(() => ({ ...options, apiKey: '' })).available()).toBe(false)
    expect(new KagiSearchProvider(() => ({ ...options, apiKey: '', resolveApiKey: async () => undefined })).available()).toBe(true)
    expect(new KagiSearchProvider(() => ({ ...options, baseURL: 'not a URL' })).available()).toBe(false)
  })

  it('sends q and Bot authorization while rejecting redirects', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider(options).search({ query: 'hello world' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://kagi.test/api/v1/search?q=hello+world')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect((init.headers as Record<string, string>).authorization).toBe('Bot kagi-key')
  })

  it('passes an active signal to fetch and trims endpoint slashes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider({ ...options, baseURL: `${options.baseURL}///` }).search({ query: 'hello' }, controller.signal)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://kagi.test/api/v1/search?q=hello')
    expect(init.signal).toBe(controller.signal)
  })

  it('uses a resolved credential for the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ ...options, apiKey: '', resolveApiKey: async () => 'resolved-key' }).search({ query: 'hello' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bot resolved-key')
  })

  it('resolves a missing credential reference per operation', async () => {
    const resolveApiKey = vi.fn(async () => undefined)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider({ ...options, apiKey: '', apiKeyEnv: credentialRef('KAGI_ROTATED_KEY'), resolveApiKey })
      .search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    await expect(provider({ ...options, apiKey: '', apiKeyEnv: credentialRef('KAGI_ROTATED_KEY'), resolveApiKey })
      .search({ query: 'q' })).rejects.toThrow('KAGI_ROTATED_KEY')
    expect(resolveApiKey).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps pre-abort and HTTP failures', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    await expect(provider(options).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'quota exceeded' }, { status: 429 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'quota exceeded' })
  })

  it('reports credential resolver failures and the default missing reference', async () => {
    await expect(provider({ ...options, apiKey: '', resolveApiKey: () => Promise.reject(new Error('credential backend failed')) })
      .search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Kagi search credential resolution failed: Error: credential backend failed',
    })
    await expect(provider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('Kagi search has no API key for "KAGI_API_KEY"')
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
      message: 'Kagi search credential resolution failed: Error: credential backend failed',
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
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [] })))
    await expect(search).resolves.toEqual({ sources: [], truncated: false })
  })

  it('maps network and fetch abort failures', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Kagi search request failed: TypeError: connection refused',
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('uses the status-line message for unusable error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ message: 'Kagi API error (HTTP 503)' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ message: 'Kagi API error (HTTP 500)' })
  })

  it('accepts each documented HTTP error detail field', async () => {
    for (const detail of [{ error: 'bad request' }, { message: 'quota exceeded' }, { detail: 'invalid query' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(detail, { status: 400 })))
      await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ message: Object.values(detail)[0] })
    }
  })

  it('maps malformed success bodies and body-parser aborts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    const successBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => successBody as unknown as Response))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    const errorBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => errorBody as unknown as Response))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
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

describe('Kagi plugin registration', () => {
  it('registers and disposes through the aggregate web provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: kagiPlugin.KAGI_PROVIDER_ID })
    const fiber = await ctx.plugin(kagiPlugin, { apiKey: 'kagi-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('has no default export', () => { expect('default' in kagiPlugin).toBe(false) })

  it('resolves the default key and endpoint from the launching environment', async () => {
    const previous = process.env.KAGI_API_KEY
    process.env.KAGI_API_KEY = 'ambient-key'
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: kagiPlugin.KAGI_PROVIDER_ID })
      kagiPlugin.apply(ctx, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://kagi.com/api/v1/search?q=q')
      expect((init.headers as Record<string, string>).authorization).toBe('Bot ambient-key')
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.KAGI_API_KEY
      else process.env.KAGI_API_KEY = previous
    }
  })

  it('resolves and rotates a stored credential without restarting the plugin', async () => {
    const previous = process.env.KAGI_API_KEY
    delete process.env.KAGI_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-kagi-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: kagiPlugin.KAGI_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(kagiPlugin, { baseURL: 'https://kagi.entry.test/api/v1' })
      await expect(ctx.web.search({ query: 'missing' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      await ctx.credentials.set(credentialRef('KAGI_API_KEY'), 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(credentialRef('KAGI_API_KEY'), 'rotated-key')
      await ctx.web.search({ query: 'rotated' })
      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value.authorization)).toEqual(['Bot stored-key', 'Bot rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous !== undefined) process.env.KAGI_API_KEY = previous
    }
  })

  it('reports the default credential reference when the environment is empty', async () => {
    const previous = process.env.KAGI_API_KEY
    delete process.env.KAGI_API_KEY
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: kagiPlugin.KAGI_PROVIDER_ID })
      kagiPlugin.apply(ctx, {})
      await expect(ctx.web.search({ query: 'q' })).rejects.toThrow('KAGI_API_KEY')
    } finally {
      await ctx.fiber.dispose()
      if (previous !== undefined) process.env.KAGI_API_KEY = previous
    }
  })
})
