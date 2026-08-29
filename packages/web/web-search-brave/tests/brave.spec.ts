import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
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
})

describe('BraveSearchProvider', () => {
  it('sends q/count and the subscription token with redirect rejection', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await provider(options).search({ query: 'hello world', maxResults: 5 })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://api.search.brave.test/res/v1/web/search?q=hello+world&count=5')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key')
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
})
