/** Live provider selection layered over the composed WebRuntime entry. */

import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime, { WEB_SETTINGS_NAMESPACE, type WebFetchProvider, type WebSearchProvider } from '@deepseek-ai/dsh-web'
import { describe, expect, it } from 'vitest'

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

function provider(id: string): WebSearchProvider {
  return {
    id,
    available: () => true,
    search: () => Promise.resolve({ content: id, sources: [], truncated: false }),
  }
}

function fetchProvider(id: string): WebFetchProvider {
  return {
    id,
    available: () => true,
    fetch: () => Promise.resolve({
      url: 'https://example.com', statusCode: 200,
      body: { kind: 'text', content: id }, truncated: false,
    }),
  }
}

async function boot(searchProvider = 'deepseek-official', fetchProviderId = 'http') {
  const ctx = new Context()
  const webFiber = ctx.plugin(WebRuntime, { searchProvider, fetchProvider: fetchProviderId })
  await webFiber.await()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  ctx.web.registerSearchProvider(provider('deepseek-official'))
  ctx.web.registerSearchProvider(provider('exa'))
  ctx.web.registerSearchProvider(provider('perplexity'))
  ctx.web.registerFetchProvider(fetchProvider('http'))
  ctx.web.registerFetchProvider(fetchProvider('firecrawl'))
  return { ctx, webFiber, settingsFiber }
}

describe('WebRuntime settings section', () => {
  it('uses a live override for the next search and clearing it restores composition', async () => {
    const bench = await boot()
    await expect(bench.ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'deepseek-official' })

    await bench.ctx.settings.update(WEB_SETTINGS_NAMESPACE, { searchProvider: 'exa' })
    await expect(bench.ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })

    await bench.ctx.settings.replace(WEB_SETTINGS_NAMESPACE, {})
    await expect(bench.ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'deepseek-official' })
    await bench.ctx.fiber.dispose()
  })

  it('uses a live fetch default override and clearing it restores composition', async () => {
    const bench = await boot('deepseek-official', 'http')
    await expect(bench.ctx.web.fetch({ url: 'https://example.com' })).resolves.toMatchObject({
      body: { content: 'http' },
    })

    await bench.ctx.settings.update(WEB_SETTINGS_NAMESPACE, { fetchProvider: 'firecrawl' })
    await expect(bench.ctx.web.fetch({ url: 'https://example.com' })).resolves.toMatchObject({
      body: { content: 'firecrawl' },
    })

    await bench.ctx.settings.replace(WEB_SETTINGS_NAMESPACE, {})
    await expect(bench.ctx.web.fetch({ url: 'https://example.com' })).resolves.toMatchObject({
      body: { content: 'http' },
    })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to composition when the settings service detaches', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_SETTINGS_NAMESPACE, { searchProvider: 'perplexity' })
    await expect(bench.ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'perplexity' })

    await bench.settingsFiber.dispose()
    await expect(bench.ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'deepseek-official' })
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when WebRuntime unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web')

    await bench.webFiber.dispose()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web')
    await bench.ctx.fiber.dispose()
  })
})
