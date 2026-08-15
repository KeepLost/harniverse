import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  PerplexitySearchProvider,
  PERPLEXITY_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-perplexity'
import * as perplexityPlugin from '@deepseek-ai/dsh-web-search-perplexity'
import { mapPerplexityResponse } from '../src/provider.ts'
import type { PerplexitySearchProviderOptions } from '@deepseek-ai/dsh-web-search-perplexity'

const options = { apiKey: 'pplx-key', baseURL: 'https://api.perplexity.test', model: 'sonar', maxTokens: 1024 }

/** Construct the provider over a fixed options value; production passes a live thunk. */
const searchProvider = (value: PerplexitySearchProviderOptions): PerplexitySearchProvider =>
  new PerplexitySearchProvider(() => value)

/** Credential seam fixture that deliberately declines every ambient reference. */
class EmptyCredentialProvider extends CredentialProvider {
  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.reject(new Error('read-only fixture'))
  }

  unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Perplexity response mapping', () => {
  it('maps the answer and prefers structured search_results', () => {
    const result = mapPerplexityResponse({
      choices: [{ message: { content: 'the answer' } }],
      search_results: [
        { url: 'https://a.test', title: 'A', snippet: 'snip', date: '2026-02-02' },
        { url: 'https://b.test' },
      ],
      citations: ['https://ignored.test'],
    })
    expect(result).toEqual({
      content: 'the answer',
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'snip', publishedAt: '2026-02-02' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
  })

  it('falls back to URL-only citations when search_results is absent', () => {
    const result = mapPerplexityResponse({
      choices: [{ message: { content: 'answer' } }],
      citations: ['https://a.test', 'https://b.test'],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }, { url: 'https://b.test' }])
  })

  it('omits content when the answer is empty or missing', () => {
    expect(mapPerplexityResponse({ citations: [] }).content).toBeUndefined()
    expect(mapPerplexityResponse({ choices: [{ message: { content: '' } }] }).content).toBeUndefined()
    expect(mapPerplexityResponse({ choices: [{ message: { content: null } }] }).content).toBeUndefined()
  })

  it('omits null/empty optional source fields', () => {
    const result = mapPerplexityResponse({
      search_results: [{ url: 'https://a.test', title: null, snippet: '', date: null }],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
  })

  it('yields no sources when neither search_results nor citations are present', () => {
    expect(mapPerplexityResponse({ choices: [{ message: { content: 'a' } }] }).sources).toEqual([])
  })
})

describe('PerplexitySearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('may report available when an asynchronous credential resolver exists', () => {
    expect(searchProvider({ ...options, apiKey: '', resolveApiKey: async () => undefined }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when maxTokens is not a positive integer', () => {
    expect(searchProvider({ ...options, maxTokens: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, maxTokens: 1.5 }).available()).toBe(false)
  })
})

describe('PerplexitySearchProvider request mapping', () => {
  it('sends a chat-completions request with the query, model and max_tokens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'hello' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.perplexity.test/chat/completions')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer pplx-key')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'sonar', max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] })
  })

  it('sends search_recency_filter when configured, and omits it otherwise', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, searchRecency: 'week' }).search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ search_recency_filter: 'week' })

    await searchProvider(options).search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).not.toHaveProperty('search_recency_filter')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('PerplexitySearchProvider settings changes mid-search', () => {
  it('serves one search from one section even when settings land during credential resolution', async () => {
    const before = { ...options, apiKey: '', baseURL: 'https://before.test', model: 'model-before', maxTokens: 128, searchRecency: 'day' as const }
    const after = { ...options, apiKey: '', baseURL: 'https://after.test', model: 'model-after', maxTokens: 512, searchRecency: 'year' as const }
    let current: PerplexitySearchProviderOptions = before
    let commitSettings = () => {}
    const resolveApiKey = () => new Promise<string>((resolve) => {
      commitSettings = () => { current = after; resolve('key-from-before') }
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ citations: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const resolveOptions = vi.fn(() => ({ ...current, resolveApiKey }))
    const provider = new PerplexitySearchProvider(resolveOptions)
    const search = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(typeof commitSettings).toBe('function') })
    commitSettings()
    await search

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    expect(endpoint).toBe('https://before.test/chat/completions')
    expect(init.headers.authorization).toBe('Bearer key-from-before')
    expect(JSON.parse(init.body)).toEqual({
      model: 'model-before',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'q' }],
      search_recency_filter: 'day',
    })
    expect(resolveOptions).toHaveBeenCalledOnce()
  })
})

describe('PerplexitySearchProvider error handling', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending without dispatching', async () => {
    const resolveApiKey = vi.fn(() => new Promise<string>(() => {}))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = searchProvider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prefers a non-empty literal key without invoking the resolver', async () => {
    const resolveApiKey = vi.fn(async () => 'stored-key')
    const fetchMock = vi.fn(async () => jsonResponse({ citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, resolveApiKey }).search({ query: 'q' })
    expect(resolveApiKey).not.toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pplx-key')
  })

  it('reports the configured credential reference when resolution yields no key', async () => {
    let caught: unknown
    try {
      await searchProvider({
        ...options,
        apiKey: '',
        apiKeyEnv: credentialRef('PERPLEXITY_SECONDARY_KEY'),
        resolveApiKey: async () => undefined,
      }).search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toContain('PERPLEXITY_SECONDARY_KEY')
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }))
  })

  it('handles a string-form error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad request' }, { status: 400 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'bad request' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ search_results: null }, { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Perplexity API error (HTTP 503)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Perplexity API error (HTTP 500)' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('does not return a body that resolves after cancellation', async () => {
    let resolveBody!: (value: unknown) => void
    const json = vi.fn(() => new Promise((resolve) => { resolveBody = resolve }))
    const body = { json, ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    const controller = new AbortController()
    const pending = searchProvider(options).search({ query: 'q' }, controller.signal)
    await vi.waitFor(() => { expect(json).toHaveBeenCalled() })

    controller.abort(new Error('caller stopped'))
    resolveBody({ choices: [{ message: { content: 'answer' } }], citations: [] })

    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('web-search-perplexity plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    const fiber = await ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'a', sources: [] })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in perplexityPlugin).toBe(false)
  })

  it('threads maxTokens and searchRecency config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    const fiber = await ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key', maxTokens: 256, searchRecency: 'month' })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_tokens: 256, search_recency_filter: 'month' })
    await fiber.dispose()
  })

  it('rejects maxTokens: 0 at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    await expect(ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key', maxTokens: 0 }))
      .rejects.toThrow(/maxTokens expected number >= 1/)
  })

  it('rejects a fractional maxTokens at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
    await expect(ctx.plugin(perplexityPlugin, { apiKey: 'pplx-key', maxTokens: 1.5 }))
      .rejects.toThrow(/maxTokens expected number multiple of 1/)
  })

  it('falls back to env key and defaults for base URL and model when config omits them', async () => {
    const prev = process.env.PERPLEXITY_API_KEY
    process.env.PERPLEXITY_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a' } }], citations: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      const fiber = await ctx.plugin(perplexityPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.perplexity.ai/chat/completions')
      expect(JSON.parse(init.body as string)).toMatchObject({ model: 'sonar' })
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.PERPLEXITY_API_KEY
      else process.env.PERPLEXITY_API_KEY = prev
    }
  })

  it('resolves the credential for each search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.PERPLEXITY_API_KEY
    delete process.env.PERPLEXITY_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-perplexity-credentials-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ citations: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(perplexityPlugin, { baseURL: 'https://api.perplexity.test' })

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
      const ref = credentialRef('PERPLEXITY_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value.authorization)).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.PERPLEXITY_API_KEY
      else process.env.PERPLEXITY_API_KEY = previous
    }
  })

  it('treats a mounted credential service as authoritative over the launch environment', async () => {
    const previous = process.env.PERPLEXITY_API_KEY
    process.env.PERPLEXITY_API_KEY = 'ambient-key'
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      await ctx.plugin(EmptyCredentialProvider)
      await ctx.plugin(perplexityPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.PERPLEXITY_API_KEY
      else process.env.PERPLEXITY_API_KEY = previous
    }
  })

  it('reports a stable missing-credential failure when neither config nor env supplies a key', async () => {
    const prev = process.env.PERPLEXITY_API_KEY
    delete process.env.PERPLEXITY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: PERPLEXITY_PROVIDER_ID })
      await ctx.plugin(perplexityPlugin, {})
      let caught: unknown
      try {
        await ctx.web.search({ query: 'q' })
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
      expect(caught.message).toContain('PERPLEXITY_API_KEY')
    } finally {
      if (prev !== undefined) process.env.PERPLEXITY_API_KEY = prev
    }
  })
})
