import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { TavilySearchProviderOptions } from '@deepseek-ai/dsh-web-search-tavily'
import * as tavilyPlugin from '../src/index.ts'
import { TavilySearchProvider, mapTavilyResponse, mapTavilyResult } from '../src/provider.ts'

const options: TavilySearchProviderOptions = {
  apiKey: 'tavily-key',
  baseURL: 'https://api.tavily.test',
  includeRawContent: false,
}

const provider = (value: TavilySearchProviderOptions): TavilySearchProvider =>
  new TavilySearchProvider(() => value)

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tavily response mapping', () => {
  it('maps title, content, publication date, and filters blank URLs', () => {
    expect(mapTavilyResult({
      url: 'https://a.test',
      title: 'A',
      content: 'summary',
      published_date: '2026-01-01',
      score: 0.9,
    })).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'summary',
      publishedAt: '2026-01-01',
    })
    expect(mapTavilyResult({ url: '', content: 'ignored' })).toBeUndefined()
  })

  it('uses raw content only when the normal content is absent', () => {
    expect(mapTavilyResult({ url: 'https://a.test', content: 'summary', raw_content: 'raw' }))
      .toMatchObject({ snippet: 'summary' })
    expect(mapTavilyResult({ url: 'https://b.test', raw_content: 'raw' }))
      .toMatchObject({ snippet: 'raw' })
  })

  it('maps the flat response without an AI answer', () => {
    expect(mapTavilyResponse({ results: [{ url: 'https://a.test', content: 'one' }] }))
      .toEqual({ sources: [{ url: 'https://a.test', snippet: 'one' }], truncated: false })
  })

  it('omits empty optional fields and filters empty content', () => {
    expect(mapTavilyResult({
      url: 'https://a.test',
      title: '',
      content: '  ',
      raw_content: '  ',
      published_date: '',
    })).toEqual({ url: 'https://a.test' })
    expect(mapTavilyResponse({}).sources).toEqual([])
  })
})

describe('TavilySearchProvider', () => {
  it('reports availability only for valid credentials, endpoint, and count', () => {
    expect(provider({ ...options, apiKey: '' }).available()).toBe(false)
    expect(provider({ ...options, apiKey: '', resolveApiKey: async () => undefined }).available()).toBe(true)
    expect(provider({ ...options, baseURL: 'not a URL' }).available()).toBe(false)
    expect(provider({ ...options, maxResults: 0 }).available()).toBe(false)
    expect(provider({ ...options, maxResults: 1.5 }).available()).toBe(false)
    expect(provider({ ...options, maxResults: 2 }).available()).toBe(true)
  })

  it('sends the query, count, answer suppression, raw-content option, and bearer key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await provider({ ...options, includeRawContent: true }).search({ query: 'hello', maxResults: 4 })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tavily-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      include_answer: false,
      max_results: 4,
      include_raw_content: true,
    })
  })

  it('uses the configured count and signal while omitting raw content when disabled', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider({ ...options, baseURL: `${options.baseURL}///`, maxResults: 8, includeRawContent: false })
      .search({ query: 'hello' }, controller.signal)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.test/search')
    expect(init.signal).toBe(controller.signal)
    expect(JSON.parse(init.body as string)).toEqual({ query: 'hello', include_answer: false, max_results: 8 })
  })

  it('resolves a fresh credential for each operation', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    let key = 'first-key'
    const resolveApiKey = vi.fn(async () => key)
    const search = provider({ ...options, apiKey: '', resolveApiKey })

    await search.search({ query: 'one' })
    key = 'rotated-key'
    await search.search({ query: 'two' })

    expect(resolveApiKey).toHaveBeenCalledTimes(2)
    const headers = fetchMock.mock.calls.map(call => (call[1] as RequestInit).headers as Record<string, string>)
    expect(headers.map(header => header.authorization)).toEqual(['Bearer first-key', 'Bearer rotated-key'])
  })

  it('reports missing credentials without dispatching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider({ ...options, apiKey: '', apiKeyEnv: credentialRef('TAVILY_ROTATED_KEY') })
      .search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    await expect(provider({ ...options, apiKey: '', apiKeyEnv: credentialRef('TAVILY_ROTATED_KEY') })
      .search({ query: 'q' })).rejects.toThrow('TAVILY_ROTATED_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not dispatch a pre-aborted operation', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))

    await expect(provider(options).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps HTTP failures to WEB_PROVIDER_ERROR without exposing the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'bad key',
    })
  })

  it('reports credential resolver failures and the default missing reference', async () => {
    await expect(provider({ ...options, apiKey: '', resolveApiKey: () => Promise.reject(new Error('credential backend failed')) })
      .search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Tavily search credential resolution failed: Error: credential backend failed',
    })
    await expect(provider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('Tavily search has no API key for "TAVILY_API_KEY"')
  })

  it('aborts an uncooperative resolver and maps resolver cancellation', async () => {
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

  it('exercises both abortable credential settlement paths', async () => {
    let resolveCredential!: (value: string) => void
    const resolveApiKey = vi.fn(() => new Promise<string>((resolve) => { resolveCredential = resolve }))
    const search = provider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, new AbortController().signal)
    resolveCredential('resolved-key')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    await expect(search).resolves.toEqual({ sources: [], truncated: false })

    let rejectCredential!: (reason: unknown) => void
    const rejection = provider({ ...options, apiKey: '', resolveApiKey: () => new Promise<string>((_resolve, reject) => { rejectCredential = reject }) })
      .search({ query: 'q' }, new AbortController().signal)
    rejectCredential(new Error('credential backend failed'))
    await expect(rejection).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    let rejectNonError!: (reason: unknown) => void
    const nonErrorRejection = provider({ ...options, apiKey: '', resolveApiKey: () => new Promise<string>((_resolve, reject) => { rejectNonError = reject }) })
      .search({ query: 'q' }, new AbortController().signal)
    rejectNonError('credential backend failed')
    await expect(nonErrorRejection).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('maps network, malformed body, and abort failures', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'Tavily search request failed: TypeError: connection refused',
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('uses status-line errors and handles body-parser aborts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ message: 'Tavily API error (HTTP 503)' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ message: 'Tavily API error (HTTP 500)' })

    const successBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => successBody as unknown as Response))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    const errorBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => errorBody as unknown as Response))
    await expect(provider(options).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('maps a caller abort during fetch', async () => {
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

describe('Tavily plugin registration', () => {
  it('registers through the aggregate seam and disposes on HMR unload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: tavilyPlugin.TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tavily-key' })

    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('is a namespace plugin rather than a default-export service', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('resolves the default key and endpoint from the launching environment', async () => {
    const previous = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'ambient-key'
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: tavilyPlugin.TAVILY_PROVIDER_ID })
      tavilyPlugin.apply(ctx, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.tavily.com/search')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer ambient-key')
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = previous
    }
  })

  it('reports the default credential reference when the environment is empty', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: tavilyPlugin.TAVILY_PROVIDER_ID })
      tavilyPlugin.apply(ctx, {})
      await expect(ctx.web.search({ query: 'q' })).rejects.toThrow('TAVILY_API_KEY')
    } finally {
      await ctx.fiber.dispose()
      if (previous !== undefined) process.env.TAVILY_API_KEY = previous
    }
  })
})

class MemoryCredentials extends CredentialProvider {
  private values = new Map<CredentialRef, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values.has(ref), writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }
}

describe('Tavily credential seam', () => {
  it('uses ctx.credentials on every search when the seam is mounted', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: tavilyPlugin.TAVILY_PROVIDER_ID })
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(tavilyPlugin, { baseURL: options.baseURL })

    const ref = credentialRef('TAVILY_API_KEY')
    await ctx.credentials.set(ref, 'stored-key')
    await ctx.web.search({ query: 'q' })
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer stored-key' })
    await ctx.fiber.dispose()
  })
})
