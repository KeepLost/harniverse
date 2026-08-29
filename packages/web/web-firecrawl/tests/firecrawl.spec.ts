import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  FirecrawlFetchProvider,
  FirecrawlSearchProvider,
} from '@deepseek-ai/dsh-web-firecrawl'
import type { FirecrawlProviderOptions } from '@deepseek-ai/dsh-web-firecrawl'
import * as firecrawlPlugin from '@deepseek-ai/dsh-web-firecrawl'
import {
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
})

describe('Firecrawl providers', () => {
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
})

describe('Firecrawl aggregate plugin', () => {
  it('registers search and fetch together and disposes both on HMR unload', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      requestURL(input).includes('/scrape')
        ? jsonResponse({ data: { markdown: 'body' } })
        : jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {
      searchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
      fetchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
    })
    const fiber = await ctx.plugin(firecrawlPlugin, { apiKey: 'firecrawl-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await expect(ctx.web.fetch({ url: 'https://requested.test' })).resolves.toMatchObject({ body: { content: 'body' } })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    await expect(ctx.web.fetch({ url: 'https://requested.test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('uses the namespace plugin export shape', () => { expect('default' in firecrawlPlugin).toBe(false) })
})

function requestURL(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}
