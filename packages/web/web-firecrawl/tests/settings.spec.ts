import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as firecrawlPlugin from '@deepseek-ai/dsh-web-firecrawl'
import { WEB_FIRECRAWL_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-firecrawl'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function response(input: RequestInfo | URL): Response {
  return requestURL(input).includes('/scrape')
    ? new Response(JSON.stringify({ data: { markdown: '0123456789' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function requestURL(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {
    searchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
    fetchProvider: firecrawlPlugin.FIRECRAWL_PROVIDER_ID,
  })
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(firecrawlPlugin, {
    apiKey: 'firecrawl-key',
    baseURL: 'https://firecrawl.entry.test',
    includeSearchContent: false,
    searchContentMaxChars: 10,
    maxChars: 100,
  })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => { vi.restoreAllMocks() })

describe('web-firecrawl settings', () => {
  it('updates endpoint and bounds for both registered capabilities', async () => {
    const bench = await boot()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(input => Promise.resolve(response(input)))
    await bench.ctx.web.search({ query: 'anything' })
    await bench.ctx.web.fetch({ url: 'https://requested.test' })
    await bench.ctx.settings.update(WEB_FIRECRAWL_SETTINGS_NAMESPACE, {
      baseURL: 'https://firecrawl.stored.test',
      includeSearchContent: true,
      searchContentMaxChars: 4,
      maxChars: 5,
    })
    await bench.ctx.web.search({ query: 'anything' })
    await bench.ctx.web.fetch({ url: 'https://requested.test' })
    const [searchUrl, searchInit, fetchUrl, fetchInit] = [
      fetchSpy.mock.calls[2]?.[0], fetchSpy.mock.calls[2]?.[1],
      fetchSpy.mock.calls[3]?.[0], fetchSpy.mock.calls[3]?.[1],
    ] as [string, RequestInit, string, RequestInit]
    expect(searchUrl).toBe('https://firecrawl.stored.test/v2/search')
    expect(JSON.parse(searchInit.body as string)).toMatchObject({ scrapeOptions: { formats: ['markdown'] } })
    expect(fetchUrl).toBe('https://firecrawl.stored.test/v2/scrape')
    expect(JSON.parse(fetchInit.body as string)).toEqual({ url: 'https://requested.test', formats: ['markdown'] })
    await bench.ctx.fiber.dispose()
  })

  it('releases the shared settings namespace on unload', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-firecrawl')
    await bench.pluginFiber.dispose()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-firecrawl')
    await bench.settingsFiber.dispose()
    await bench.ctx.fiber.dispose()
  })
})
