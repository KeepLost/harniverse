import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as cloudflarePlugin from '../src/index.ts'
import { CloudflareSearchProvider, CLOUDFLARE_DEFAULT_BASE_URL } from '../src/provider.ts'

/**
 * Real-API smoke for the Cloudflare search provider. Self-skips without
 * `$CLOUDFLARE_API_TOKEN` and `$CLOUDFLARE_ACCOUNT_ID` (CI has no secrets), per
 * the with-key e2e policy in docs/testing.md. Uses Ceramic.ai, the cheapest engine.
 */
const apiKey = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID ?? 'default'
const configured = apiKey !== undefined && apiKey.length > 0 && accountId !== undefined && accountId.length > 0
const maybe = configured ? describe : describe.skip

maybe('CloudflareSearchProvider real API', () => {
  it('returns bounded sources for a live query', async () => {
    const provider = new CloudflareSearchProvider(() => ({
      apiKey: apiKey!,
      accountId: accountId!,
      gatewayId,
      engine: 'ceramic',
      baseURL: process.env.CLOUDFLARE_BASE_URL ?? CLOUDFLARE_DEFAULT_BASE_URL,
      snippetMaxChars: 300,
    }))
    const result = await provider.search({ query: 'Cloudflare Workers AI pricing', maxResults: 3 })
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources.length).toBeLessThanOrEqual(3)
    for (const source of result.sources) {
      expect(source.url).toMatch(/^https?:\/\//)
      expect(source.snippet?.length ?? 0).toBeLessThanOrEqual(300)
    }
  }, 30_000)

  it('searches through the registered ctx.web provider and honors an aborted signal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: cloudflarePlugin.CLOUDFLARE_PROVIDER_ID })
      await ctx.plugin(cloudflarePlugin, { apiKey: apiKey!, accountId: accountId!, gatewayId })
      const result = await ctx.web.search({ query: 'DeepSeek Harness', maxResults: 2 })
      expect(result.sources.length).toBeGreaterThan(0)
      expect(result.sources.length).toBeLessThanOrEqual(2)
      await expect(ctx.web.search({ query: 'x', provider: 'cloudflare' }, AbortSignal.abort()))
        .rejects.toMatchObject({ code: 'WEB_ABORTED' })
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('surfaces Cloudflare\'s own message for an unknown gateway', async () => {
    const provider = new CloudflareSearchProvider(() => ({
      apiKey: apiKey!,
      accountId: accountId!,
      gatewayId: 'no-such-gateway-for-dsh-e2e',
      engine: 'ceramic',
      baseURL: process.env.CLOUDFLARE_BASE_URL ?? CLOUDFLARE_DEFAULT_BASE_URL,
      snippetMaxChars: 300,
    }))
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('Cloudflare web search failed:') as unknown,
    })
  }, 30_000)
})
