import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import WebRuntime from '@deepseek-ai/dsh-web'
import { KagiSearchProvider } from '@deepseek-ai/dsh-web-search-kagi'
import type { KagiSearchProviderOptions } from '@deepseek-ai/dsh-web-search-kagi'
import * as kagiPlugin from '@deepseek-ai/dsh-web-search-kagi'
import { mapKagiResponse, mapKagiResult } from '../src/provider.ts'

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
})

describe('KagiSearchProvider', () => {
  it('sends q and Bot authorization while rejecting redirects', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider(options).search({ query: 'hello world' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://kagi.test/api/v1/search?q=hello+world')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect((init.headers as Record<string, string>).authorization).toBe('Bot kagi-key')
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
})
