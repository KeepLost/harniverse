import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import WebRuntime from '@deepseek-ai/dsh-web'
import { TavilySearchProvider } from '@deepseek-ai/dsh-web-search-tavily'
import type { TavilySearchProviderOptions } from '@deepseek-ai/dsh-web-search-tavily'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { mapTavilyResponse, mapTavilyResult } from '../src/provider.ts'

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
})

describe('TavilySearchProvider', () => {
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
