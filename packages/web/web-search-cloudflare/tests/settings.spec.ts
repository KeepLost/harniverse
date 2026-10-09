import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as cloudflarePlugin from '../src/index.ts'
import { WEB_SEARCH_CLOUDFLARE_SETTINGS_NAMESPACE } from '../src/index.ts'

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
  return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function boot(): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: cloudflarePlugin.CLOUDFLARE_PROVIDER_ID })
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(cloudflarePlugin, {
    apiKey: 'cf-token',
    accountId: 'entryacct',
    baseURL: 'https://cloudflare.entry.test/client/v4',
  })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => { vi.restoreAllMocks() })

describe('web-search-cloudflare settings', () => {
  it('uses the updated account, gateway, engine, and snippet bound on the next search', async () => {
    const bench = await boot()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(response()))
    await bench.ctx.web.search({ query: 'anything' })
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://cloudflare.entry.test/client/v4/accounts/entryacct/ai/websearch/')
    await bench.ctx.settings.update(WEB_SEARCH_CLOUDFLARE_SETTINGS_NAMESPACE, {
      accountId: 'storedacct',
      gatewayId: 'stored-gw',
      engine: 'exa',
      byokAlias: 'stored-key',
      baseURL: 'https://cloudflare.stored.test/client/v4',
      snippetMaxChars: 500,
    })
    await bench.ctx.web.search({ query: 'anything' })
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://cloudflare.stored.test/client/v4/accounts/storedacct/ai/websearch/')
    expect(JSON.parse((fetchSpy.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      query: 'anything',
      provider: 'exa',
      byokAlias: 'stored-key',
      options: { gateway: { id: 'stored-gw' } },
    })
    await bench.ctx.fiber.dispose()
  })

  it('marks the literal token secret and the token reference as a credential reference', async () => {
    const bench = await boot()
    const row = bench.ctx.settings.describe().find(entry => String(entry.ns) === 'web-search-cloudflare')
    const schema = JSON.stringify(row?.schema)
    expect(schema).toContain('"role":"secret"')
    expect(schema).toContain('"role":"credential-ref"')
    await bench.ctx.fiber.dispose()
  })

  it('releases the settings namespace on unload', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-cloudflare')
    await bench.pluginFiber.dispose()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-cloudflare')
    await bench.settingsFiber.dispose()
    await bench.ctx.fiber.dispose()
  })
})
