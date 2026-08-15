/** The `web-search-exa` settings section layered over the composition entry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as exaPlugin from '@deepseek-ai/dsh-web-search-exa'
import { WEB_SEARCH_EXA_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-exa'

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
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(exaPlugin, {
    apiKey: 'exa-key',
    baseURL: 'https://exa.entry.test',
    searchType: 'auto',
    highlightsPerResult: 1,
  })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function searchOnce(ctx: Context): Promise<{ url: string; body: Record<string, unknown> }> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse({ results: [] })))
  fetchSpy.mockClear()
  await ctx.web.search({ query: 'anything' })
  const [url, init] = fetchSpy.mock.calls.at(-1) as unknown as [string, RequestInit]
  return { url, body: JSON.parse(init.body as string) as Record<string, unknown> }
}

describe('web-search-exa settings section', () => {
  it('serves stored endpoint and request options to the next search without re-registering', async () => {
    const bench = await boot()
    expect(await searchOnce(bench.ctx)).toMatchObject({
      url: 'https://exa.entry.test/search',
      body: { type: 'auto', contents: { highlights: { highlightsPerUrl: 1 } } },
    })

    await bench.ctx.settings.update(WEB_SEARCH_EXA_SETTINGS_NAMESPACE, {
      baseURL: 'https://exa.stored.test',
      searchType: 'keyword',
      numResults: 8,
      highlightsPerResult: 3,
    })

    expect(await searchOnce(bench.ctx)).toEqual({
      url: 'https://exa.stored.test/search',
      body: {
        query: 'anything',
        type: 'keyword',
        numResults: 8,
        contents: { highlights: { highlightsPerUrl: 3 } },
      },
    })
    await bench.ctx.fiber.dispose()
  })

  it('keeps the literal key out of every described layer', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_EXA_SETTINGS_NAMESPACE, { apiKey: 'exa-stored-secret' })

    const [descriptor] = bench.ctx.settings.describe({ redactSecrets: true })
      .filter(row => String(row.ns) === 'web-search-exa')

    expect(JSON.stringify(descriptor)).not.toContain('exa-stored-secret')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SEARCH_EXA_SETTINGS_NAMESPACE, {
      baseURL: 'https://exa.stored.test',
    })
    expect((await searchOnce(bench.ctx)).url).toBe('https://exa.stored.test/search')

    await bench.settingsFiber.dispose()

    expect((await searchOnce(bench.ctx)).url).toBe('https://exa.entry.test/search')
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-exa')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-exa')
    await bench.ctx.fiber.dispose()
  })
})
