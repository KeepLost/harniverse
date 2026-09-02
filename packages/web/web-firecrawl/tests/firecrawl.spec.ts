import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as firecrawlPlugin from '../src/index.ts'
import type { FirecrawlProviderOptions } from '../src/provider.ts'
import type { FirecrawlSearchResponse } from '../src/types.ts'
import {
  FirecrawlFetchProvider,
  FirecrawlSearchProvider,
  mapFirecrawlScrapeResponse,
  mapFirecrawlSearchResponse,
  mapFirecrawlSearchResult,
} from '../src/provider.ts'

const options: FirecrawlProviderOptions = {
  apiKey: 'firecrawl-key',
  baseURL: 'https://firecrawl.test',
  includeSearchContent: false,
  searchContentMaxChars: 10,
  maxChars: 100,
}
const anonymousOptions: FirecrawlProviderOptions = {
  baseURL: options.baseURL,
  includeSearchContent: options.includeSearchContent,
  searchContentMaxChars: options.searchContentMaxChars,
  maxChars: options.maxChars,
}

class EmptyCredentialProvider extends CredentialProvider {
  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined) }
  describe(_ref: CredentialRef): Promise<CredentialInfo> { return Promise.resolve({ configured: false, writable: false }) }
  set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.reject(new Error('read-only fixture')) }
  unset(_ref: CredentialRef): Promise<void> { return Promise.resolve() }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Firecrawl search mapping', () => {
  it('maps URL, title, description, and bounded optional markdown', () => {
    expect(mapFirecrawlSearchResult({
      url: 'https://a.test',
      title: 'A',
      description: 'description',
      markdown: '0123456789abcdef',
    }, true, 5)).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'description\n\n01234',
    })
    expect(mapFirecrawlSearchResult({ metadata: { sourceURL: 'https://meta.test' }, content: 'raw' }, false))
      .toEqual({ url: 'https://meta.test' })
  })

  it('omits results without a URL and selects metadata/title/content fallbacks', () => {
    expect(mapFirecrawlSearchResult({ title: 'ignored' })).toBeUndefined()
    expect(mapFirecrawlSearchResult({
      url: 'https://a.test',
      metadata: { title: 'Metadata title' },
      content: 'raw content',
    }, true, 20)).toEqual({
      url: 'https://a.test',
      title: 'Metadata title',
      snippet: 'raw content',
    })
    expect(mapFirecrawlSearchResult({ url: 'https://a.test', description: 'summary' }, true, 20))
      .toEqual({ url: 'https://a.test', snippet: 'summary' })
    expect(mapFirecrawlSearchResult({ url: 'https://a.test', markdown: 'markdown' }, false))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps results and data wrapper variants without an AI answer', () => {
    const item = { url: 'https://a.test', title: 'A', description: 'summary' }
    expect(mapFirecrawlSearchResponse({ results: [item] })).toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'summary' }],
      truncated: false,
    })
    expect(mapFirecrawlSearchResponse({ success: true, data: [item] }).sources).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'summary' },
    ])
    expect(mapFirecrawlSearchResponse({ success: true, data: { web: [item] } }).sources).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'summary' },
    ])
    expect(mapFirecrawlSearchResponse({ data: { results: [item] } }).sources).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'summary' },
    ])
    expect(mapFirecrawlSearchResponse({ data: [{ title: 'missing url' }, item] }).sources).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'summary' },
    ])
    expect(mapFirecrawlSearchResponse({ success: true }).sources).toEqual([])
    expect(mapFirecrawlSearchResponse({ data: { results: [] } }).sources).toEqual([])
    expect(mapFirecrawlSearchResponse({ data: { web: [] } }).sources).toEqual([])
    expect(mapFirecrawlSearchResponse([] as unknown as FirecrawlSearchResponse)).toEqual({ sources: [], truncated: false })
    expect(mapFirecrawlSearchResponse(null as unknown as FirecrawlSearchResponse)).toEqual({ sources: [], truncated: false })
    expect(mapFirecrawlSearchResponse({ data: 'invalid' } as unknown as FirecrawlSearchResponse))
      .toEqual({ sources: [], truncated: false })
  })
})

describe('Firecrawl scrape mapping', () => {
  it('maps markdown, target metadata, and the local character bound', () => {
    expect(mapFirecrawlScrapeResponse({
      success: true,
      data: {
        markdown: '0123456789',
        metadata: {
          url: 'https://target.test/final',
          sourceURL: 'https://requested.test',
          statusCode: 404,
        },
      },
    }, 'https://requested.test', 5)).toEqual({
      url: 'https://target.test/final',
      statusCode: 404,
      body: { kind: 'text', content: '01234' },
      truncated: true,
    })
  })

  it('preserves an empty body and reports an absent body to the caller', () => {
    expect(mapFirecrawlScrapeResponse({ data: { content: '' } }, 'https://requested.test', 5))
      .toMatchObject({ body: { kind: 'text', content: '' }, truncated: false })
    expect(mapFirecrawlScrapeResponse({ success: true }, 'https://requested.test', 5)).toBeUndefined()
  })

  it('selects scrape content and metadata fallbacks', () => {
    expect(mapFirecrawlScrapeResponse({
      content: 'top-level content',
      url: 'https://top.test',
      metadata: { statusCode: Number.NaN },
    }, 'https://requested.test', 100, 418)).toEqual({
      url: 'https://top.test',
      statusCode: 418,
      body: { kind: 'text', content: 'top-level content' },
      truncated: false,
    })
    expect(mapFirecrawlScrapeResponse({
      data: { content: 'data content', url: 'https://data.test' },
    }, 'https://requested.test', 100)).toMatchObject({ url: 'https://data.test' })
    expect(mapFirecrawlScrapeResponse({
      metadata: { sourceURL: 'https://source.test' },
      markdown: 'markdown content',
    }, 'https://requested.test', 100)).toMatchObject({ url: 'https://source.test' })
    expect(mapFirecrawlScrapeResponse({ content: 'body' }, 'https://requested.test', 100))
      .toMatchObject({ url: 'https://requested.test', statusCode: 200 })
    expect(mapFirecrawlScrapeResponse({ data: null, content: 'body' }, 'https://requested.test', 100))
      .toMatchObject({ url: 'https://requested.test', statusCode: 200 })
    expect(mapFirecrawlScrapeResponse({ content: 'body' }, '', 100)).toMatchObject({ url: '' })
  })

  it('uses the first string body field and requested URL when nested values are invalid', () => {
    expect(mapFirecrawlScrapeResponse({
      data: { markdown: null, content: null, metadata: null },
      markdown: null,
      content: 'body',
    }, 'https://requested.test', 100)).toMatchObject({ url: 'https://requested.test' })
    expect(mapFirecrawlScrapeResponse({
      data: { markdown: 'body', metadata: { url: '   ', sourceURL: 'https://source.test' } },
    }, 'https://requested.test', 100)).toMatchObject({ url: 'https://source.test' })
  })
})

describe('Firecrawl providers', () => {
  it('reports availability only for valid positive bounds', () => {
    expect(new FirecrawlSearchProvider(() => options).available()).toBe(true)
    expect(new FirecrawlFetchProvider(() => options).available()).toBe(true)
    expect(new FirecrawlSearchProvider(() => ({ ...options, baseURL: 'invalid' })).available()).toBe(false)
    expect(new FirecrawlSearchProvider(() => ({ ...options, searchContentMaxChars: 0 })).available()).toBe(false)
    expect(new FirecrawlFetchProvider(() => ({ ...options, maxChars: 0 })).available()).toBe(false)
    expect(new FirecrawlFetchProvider(() => ({ ...options, searchContentMaxChars: 1.5 })).available()).toBe(false)
  })

  it('sends Search query/limit and no AI-answer request by default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new FirecrawlSearchProvider(() => options).search({ query: 'hello', maxResults: 3 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://firecrawl.test/v2/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(JSON.parse(init.body as string)).toEqual({ query: 'hello', limit: 3 })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer firecrawl-key')
  })

  it('opts into markdown search content and sends scrape formats', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', markdown: '0123456789' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new FirecrawlSearchProvider(() => ({ ...options, includeSearchContent: true, searchContentMaxChars: 4 }))
      .search({ query: 'hello' })
    expect(result.sources[0]?.snippet).toBe('0123')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ query: 'hello', scrapeOptions: { formats: ['markdown'] } })
  })

  it('allows the anonymous Firecrawl search path without sending an authorization header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new FirecrawlSearchProvider(() => anonymousOptions).search({ query: 'hello' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).not.toHaveProperty('authorization')
  })

  it('uses Firecrawl Scrape markdown and preserves a target non-2xx status', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      success: true,
      data: { markdown: 'target body', metadata: { sourceURL: 'https://target.test', statusCode: 503 } },
    }, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' })
    expect(result).toEqual({
      url: 'https://target.test',
      statusCode: 503,
      body: { kind: 'text', content: 'target body' },
      truncated: false,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://firecrawl.test/v2/scrape')
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://requested.test', formats: ['markdown'] })
  })

  it('supports anonymous fetches and keeps the configured signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { markdown: 'body' } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new FirecrawlFetchProvider(() => anonymousOptions).fetch({ url: 'https://requested.test' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
    expect(init.headers).not.toHaveProperty('authorization')
  })

  it('allows anonymous requests, aborts, and reports API failures', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async () => jsonResponse({ results: [] }))
    await expect(new FirecrawlSearchProvider(() => anonymousOptions).search({ query: 'q' }))
      .resolves.toMatchObject({ sources: [], truncated: false })
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('authorization')
    fetchMock.mockClear()

    const controller = new AbortController()
    controller.abort()
    await expect(new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid key' }, { status: 401 })))
    await expect(new FirecrawlSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'invalid key' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true }, { status: 200 })))
    await expect(new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' }))
      .rejects.toThrow('no target body')
  })

  it('resolves an operation credential and omits authorization for an empty result', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new FirecrawlSearchProvider(() => ({ ...anonymousOptions, resolveApiKey: async () => 'resolved-key' }))
      .search({ query: 'q' })
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(firstCall[1].headers).toMatchObject({ authorization: 'Bearer resolved-key' })

    fetchMock.mockClear()
    await new FirecrawlSearchProvider(() => ({ ...anonymousOptions, resolveApiKey: async () => '' }))
      .search({ query: 'q' })
    const secondCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(secondCall[1].headers).not.toHaveProperty('authorization')
  })

  it('rejects when a credential resolver aborts during startup', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(new FirecrawlSearchProvider(() => ({
      ...anonymousOptions,
      resolveApiKey: () => {
        controller.abort(new Error('deadline'))
        return Promise.resolve('late-key')
      },
    })).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cleans up credential-resolution listeners on success, failure, and abort', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new FirecrawlSearchProvider(() => ({
      ...anonymousOptions,
      resolveApiKey: async () => 'resolved-key',
    })).search({ query: 'q' }, controller.signal)

    await expect(new FirecrawlSearchProvider(() => ({
      ...anonymousOptions,
      resolveApiKey: () => Promise.reject(new Error('resolver failed')),
    })).search({ query: 'q' }, new AbortController().signal)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(new FirecrawlSearchProvider(() => ({
      ...anonymousOptions,
      resolveApiKey: () => Promise.reject(new DOMException('resolver failed', 'Error')),
    })).search({ query: 'q' }, new AbortController().signal)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(new FirecrawlSearchProvider(() => ({
      ...anonymousOptions,
      resolveApiKey: () => new Promise<string>(() => { throw new URL('https://resolver.failed') }),
    })).search({ query: 'q' }, new AbortController().signal)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    let resolveKey!: (value: string) => void
    const abortController = new AbortController()
    const pending = new FirecrawlSearchProvider(() => ({
      ...anonymousOptions,
      resolveApiKey: () => new Promise<string>((resolve) => { resolveKey = resolve }),
    })).search({ query: 'q' }, abortController.signal)
    abortController.abort(new Error('caller stopped'))
    resolveKey('late-key')
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('maps credential resolution failures to WEB_PROVIDER_ERROR', async () => {
    await expect(new FirecrawlSearchProvider(() => ({
      ...anonymousOptions,
      resolveApiKey: async () => { throw new Error('credential store unavailable') },
    })).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('forwards the signal and maps network and abort failures', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new FirecrawlSearchProvider(() => options).search({ query: 'q' }, controller.signal)
    const requestCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(requestCall[1].signal).toBe(controller.signal)

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new FirecrawlSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new FirecrawlSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('maps Firecrawl API error detail variants and status fallback', async () => {
    for (const payload of [{ message: 'message detail' }, { detail: 'detail detail' }, {}, 'not an object']) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload, { status: 502 })))
      await expect(new FirecrawlSearchProvider(() => options).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 503 })))
    await expect(new FirecrawlSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toMatchObject({ message: 'Firecrawl search API error (HTTP 503)' })
  })

  it('reports malformed successful bodies and aborts while reading them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new FirecrawlSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })

    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new FirecrawlSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('keeps HTTP status errors when an error body is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 503 })))
    await expect(new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' }))
      .rejects.toMatchObject({ message: 'Firecrawl fetch API error (HTTP 503)' })
  })

  it('handles fetch API errors and preserves the HTTP status when no body exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: false }, { status: 502 })))
    await expect(new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' }))
      .rejects.toMatchObject({ message: 'Firecrawl fetch API error (HTTP 502)' })
  })

  it('aborts fetch on provider-level abort and during response parsing', async () => {
    const controller = new AbortController()
    let resolveBody!: (value: unknown) => void
    const json = vi.fn(() => new Promise((resolve) => { resolveBody = resolve }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ json, ok: true, status: 200 }) as unknown as Response))
    const pending = new FirecrawlFetchProvider(() => options).fetch({ url: 'https://requested.test' }, controller.signal)
    await vi.waitFor(() => { expect(json).toHaveBeenCalled() })
    controller.abort(new Error('caller stopped'))
    resolveBody({ data: { markdown: 'late body' } })
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})

describe('Firecrawl aggregate plugin', () => {
  it('registers search and explicitly enabled fetch together and disposes both on HMR unload', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      requestURL(input).includes('/scrape')
        ? jsonResponse({ data: { markdown: 'body' } })
        : jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {
      searchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
      fetchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
    })
    const fiber = await ctx.plugin(firecrawlPlugin, { apiKey: 'firecrawl-key', enableFetch: true })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await expect(ctx.web.fetch({ url: 'https://requested.test' })).resolves.toMatchObject({ body: { content: 'body' } })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    await expect(ctx.web.fetch({ url: 'https://requested.test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('does not register remote fetch by default', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {
      searchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
      fetchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
    })
    const fiber = await ctx.plugin(firecrawlPlugin, { apiKey: 'firecrawl-key' })
    await expect(ctx.web.fetch({ url: 'https://requested.test' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    await fiber.dispose()
  })

  it('uses the namespace plugin export shape', () => { expect('default' in firecrawlPlugin).toBe(false) })

  it('resolves direct config defaults from the launch environment', async () => {
    const previous = process.env.FIRECRAWL_API_KEY
    process.env.FIRECRAWL_API_KEY = 'ambient-firecrawl-key'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      requestURL(input).includes('/scrape')
        ? jsonResponse({ data: { markdown: 'body' } })
        : jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, {
        searchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
        fetchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
      })
      firecrawlPlugin.apply(ctx, { enableFetch: true })
      await ctx.web.search({ query: 'q' })
      await ctx.web.fetch({ url: 'https://requested.test' })
      process.env.FIRECRAWL_API_KEY = ''
      await ctx.web.search({ query: 'q' })
      expect(fetchMock.mock.calls.map(([input]) => requestURL(input))).toEqual([
        'https://api.firecrawl.dev/v2/search',
        'https://api.firecrawl.dev/v2/scrape',
        'https://api.firecrawl.dev/v2/search',
      ])
      const requestCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(requestCall[1].headers).toMatchObject({ authorization: 'Bearer ambient-firecrawl-key' })
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.FIRECRAWL_API_KEY
      else process.env.FIRECRAWL_API_KEY = previous
    }
  })

  it('prefers the mounted credential service over the ambient credential', async () => {
    const previous = process.env.FIRECRAWL_API_KEY
    process.env.FIRECRAWL_API_KEY = 'ambient-key'
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID })
      await ctx.plugin(EmptyCredentialProvider)
      firecrawlPlugin.apply(ctx, {})
      await ctx.web.search({ query: 'q' })
      const requestCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(requestCall[1].headers).not.toHaveProperty('authorization')
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.FIRECRAWL_API_KEY
      else process.env.FIRECRAWL_API_KEY = previous
    }
  })
})

function requestURL(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}
