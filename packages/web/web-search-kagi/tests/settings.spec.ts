import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as kagiPlugin from '@deepseek-ai/dsh-web-search-kagi'
import { WEB_SEARCH_KAGI_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-kagi'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function response(): Response {
  return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: kagiPlugin.KAGI_PROVIDER_ID })
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(kagiPlugin, { apiKey: 'kagi-key', baseURL: 'https://kagi.entry.test/api/v1' })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => { vi.restoreAllMocks() })

describe('web-search-kagi settings', () => {
  it('uses the updated endpoint on the next search', async () => {
    const bench = await boot()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(response()))
    await bench.ctx.web.search({ query: 'anything' })
    expect((fetchSpy.mock.calls[0]?.[0] as URL).toString()).toContain('kagi.entry.test')
    await bench.ctx.settings.update(WEB_SEARCH_KAGI_SETTINGS_NAMESPACE, { baseURL: 'https://kagi.stored.test/api/v1' })
    await bench.ctx.web.search({ query: 'anything' })
    expect((fetchSpy.mock.calls[1]?.[0] as URL).toString()).toBe('https://kagi.stored.test/api/v1/search?q=anything')
    await bench.ctx.fiber.dispose()
  })

  it('releases the settings namespace on unload', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-kagi')
    await bench.pluginFiber.dispose()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-kagi')
    await bench.settingsFiber.dispose()
    await bench.ctx.fiber.dispose()
  })
})
