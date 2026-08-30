import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-tavily'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: tavilyPlugin.TAVILY_PROVIDER_ID })
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(tavilyPlugin, {
    apiKey: 'tavily-key',
    baseURL: 'https://tavily.entry.test',
    includeRawContent: false,
  })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function searchOnce(ctx: Context): Promise<{ url: string; body: Record<string, unknown> }> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse({ results: [] })))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  const [url, init] = fetchSpy.mock.calls.at(-1) as unknown as [string, RequestInit]
  return { url, body: JSON.parse(init.body as string) as Record<string, unknown> }
}

describe('web-search-tavily settings', () => {
  it('applies live endpoint and request settings without re-registering', async () => {
    const bench = await boot()
    expect(await searchOnce(bench.ctx)).toMatchObject({
      url: 'https://tavily.entry.test/search',
      body: { query: 'anything', include_answer: false },
    })

    await bench.ctx.settings.update(WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, {
      baseURL: 'https://tavily.stored.test',
      includeRawContent: true,
      maxResults: 8,
    })
    expect(await searchOnce(bench.ctx)).toEqual({
      url: 'https://tavily.stored.test/search',
      body: {
        query: 'anything',
        include_answer: false,
        max_results: 8,
        include_raw_content: true,
      },
    })
    await bench.ctx.fiber.dispose()
  })

  it('removes its settings namespace when the provider plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-tavily')
    await bench.pluginFiber.dispose()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-tavily')
    await bench.settingsFiber.dispose()
    await bench.ctx.fiber.dispose()
  })
})
