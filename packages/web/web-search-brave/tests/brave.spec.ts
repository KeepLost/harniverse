import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import { BraveSearchProvider } from '@deepseek-ai/dsh-web-search-brave'
import type { BraveSearchProviderOptions } from '@deepseek-ai/dsh-web-search-brave'
import * as bravePlugin from '@deepseek-ai/dsh-web-search-brave'
import { mapBraveResponse, mapBraveResult } from '../src/provider.ts'

const options: BraveSearchProviderOptions = {
  apiKey: 'brave-key',
  baseURL: 'https://api.search.brave.test/res/v1/web',
}

function provider(value: BraveSearchProviderOptions): BraveSearchProvider {
  return new BraveSearchProvider(() => value)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Brave response mapping', () => {
  it('maps description and extra snippets into one portable snippet', () => {
    expect(mapBraveResult({
      url: 'https://a.test',
      title: 'A',
      description: 'description',
      extra_snippets: ['extra one', 'extra two'],
    })).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'description\n\nextra one\n\nextra two',
    })
  })

  it('maps the nested web results and omits blank optional fields', () => {
    expect(mapBraveResponse({ web: { results: [{ url: 'https://a.test', title: '', description: '' }] } }))
      .toEqual({ sources: [{ url: 'https://a.test' }], truncated: false })
    expect(mapBraveResponse({}).sources).toEqual([])
  })

  it('drops blank URLs and blank optional snippets', () => {
    expect(mapBraveResult({ url: '' })).toBeUndefined()
    expect(mapBraveResult({
      url: 'https://a.test',
      title: null,
      description: '  ',
      extra_snippets: ['', '  ', 'useful'],
    })).toEqual({ url: 'https://a.test', snippet: 'useful' })
  })
})

describe('BraveSearchProvider', () => {
  it('reports availability only for valid credentials, URLs, and result limits', () => {
    expect(provider({ ...options, apiKey: '' }).available()).toBe(false)
    expect(provider({ ...options, apiKey: '', resolveApiKey: async () => undefined }).available()).toBe(true)
    expect(provider({ ...options, baseURL: 'not a URL' }).available()).toBe(false)
    expect(provider({ ...options, maxResults: 0 }).available()).toBe(false)
    expect(provider({ ...options, maxResults: 1.5 }).available()).toBe(false)
    expect(provider({ ...options, maxResults: 3 }).available()).toBe(true)
  })

  it('sends q/count and the subscription token with redirect rejection', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await provider(options).search({ query: 'hello world', maxResults: 5 })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://api.search.brave.test/res/v1/web/search?q=hello+world&count=5')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key')
  })

  it('uses the configured count and passes an active signal to fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider({ ...options, baseURL: `${options.baseURL}///`, maxResults: 7 })
      .search({ query: 'hello' }, controller.signal)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.search.brave.test/res/v1/web/search?q=hello&count=7')
    expect(init.signal).toBe(controller.signal)
  })

  it('uses a resolved credential and omits count when no limit is configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ ...options, apiKey: '', resolveApiKey: async () => 'resolved-key' })
      .search({ query: 'hello' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.search.brave.test/res/v1/web/search?q=hello')
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('resolved-key')
  })

  it('resolves credentials per operation and reports a missing reference', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => undefined)
    await expect(provider({ ...options, apiKey: '', apiKeyEnv: credentialRef('BRAVE_ROTATED_KEY'), resolveApiKey })
      .search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    await expect(provider({ ...options, apiKey: '', apiKeyEnv: credentialRef('BRAVE_ROTATED_KEY'), resolveApiKey })
      .search({ query: 'q' })).rejects.toThrow('BRAVE_ROTATED_KEY')
    expect(resolveApiKey).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps pre-abort and HTTP errors', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    await expect(provider(options).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'bad token' }, { status: 401 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'bad token',
    })
  })

  it('reports credential resolver failures', async () => {
    await expect(provider({ ...options, apiKey: '', resolveApiKey: () => Promise.reject(new Error('credential backend failed')) })
      .search({ query: 'q' }))
      .rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Brave search credential resolution failed: Error: credential backend failed',
      })
  })

  it('aborts an uncooperative credential resolver', async () => {
    const resolveApiKey = vi.fn(() => new Promise<string>(() => {}))
    const controller = new AbortController()
    const search = provider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(resolveApiKey).toHaveBeenCalledOnce()
  })

  it('cleans up an active signal after credential resolution settles', async () => {
    let resolveCredential!: (value: string) => void
    const resolveApiKey = vi.fn(() => new Promise<string>((resolve) => { resolveCredential = resolve }))
    const controller = new AbortController()
    const search = provider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal)
    resolveCredential('resolved-key')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: [] } })))
    await expect(search).resolves.toEqual({ sources: [], truncated: false })
  })

  it('normalizes a non-Error rejection after an abortable credential wait', async () => {
    let rejectCredential!: (reason: unknown) => void
    const resolveApiKey = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectCredential = reject }))
    const controller = new AbortController()
    const search = provider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal)
    rejectCredential('credential backend failed')
    await expect(search).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Brave search credential resolution failed: Error: credential backend failed',
    })
  })

  it('preserves an Error rejection after an abortable credential wait', async () => {
    let rejectCredential!: (reason: unknown) => void
    const resolveApiKey = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectCredential = reject }))
    const search = provider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, new AbortController().signal)
    rejectCredential(new Error('credential backend failed'))
    await expect(search).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Brave search credential resolution failed: Error: credential backend failed',
    })
  })

  it('observes cancellation triggered by credential resolution', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await expect(provider({
      ...options,
      apiKey: '',
      resolveApiKey: () => {
        controller.abort(new Error('resolver cancelled caller'))
        return Promise.resolve('unused-key')
      },
    }).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the default credential reference when no resolver is configured', async () => {
    await expect(provider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('Brave search has no API key for "BRAVE_API_KEY"')
  })

  it('maps network and abort failures from fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Brave search request failed: TypeError: connection refused' })

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('keeps the HTTP status when the error body has no usable detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ message: 'Brave API error (HTTP 503)' })

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ message: 'Brave API error (HTTP 500)' })
  })

  it('accepts each documented HTTP error detail field', async () => {
    for (const detail of [{ error: 'bad request' }, { message: 'quota exceeded' }, { detail: 'invalid query' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(detail, { status: 400 })))
      await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
        message: Object.values(detail)[0],
      })
    }
  })

  it('maps malformed success bodies to a provider error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(provider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('maps an abort while parsing either response body', async () => {
    const abortedBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => abortedBody as unknown as Response))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    const abortedErrorBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => abortedErrorBody as unknown as Response))
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

describe('Brave plugin registration', () => {
  it('registers a search capability and removes it with its fiber', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: [] } })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: bravePlugin.BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, { apiKey: 'brave-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('has the required namespace plugin export shape', () => {
    expect('default' in bravePlugin).toBe(false)
  })

  it('resolves the default key and endpoint from the launching environment', async () => {
    const previous = process.env.BRAVE_API_KEY
    process.env.BRAVE_API_KEY = 'ambient-key'
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: bravePlugin.BRAVE_PROVIDER_ID })
      bravePlugin.apply(ctx, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.search.brave.com/res/v1/web/search?q=q')
      expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('ambient-key')
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = previous
    }
  })

  it('resolves a stored credential on every search', async () => {
    const previous = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-brave-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: bravePlugin.BRAVE_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(bravePlugin, { baseURL: 'https://brave.entry.test/res/v1/web' })
      await expect(ctx.web.search({ query: 'missing' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      await ctx.credentials.set(credentialRef('BRAVE_API_KEY'), 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(credentialRef('BRAVE_API_KEY'), 'rotated-key')
      await ctx.web.search({ query: 'rotated' })
      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value['x-subscription-token'])).toEqual(['stored-key', 'rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous !== undefined) process.env.BRAVE_API_KEY = previous
    }
  })

  it('reports the default credential reference when the environment is empty', async () => {
    const previous = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: bravePlugin.BRAVE_PROVIDER_ID })
      bravePlugin.apply(ctx, {})
      await expect(ctx.web.search({ query: 'q' })).rejects.toThrow('BRAVE_API_KEY')
    } finally {
      await ctx.fiber.dispose()
      if (previous !== undefined) process.env.BRAVE_API_KEY = previous
    }
  })
})
