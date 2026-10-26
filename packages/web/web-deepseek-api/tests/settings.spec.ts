/** The `web-deepseek-api` settings section layered over the composition entry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as deepseekApiPlugin from '@deepseek-ai/dsh-web-deepseek-api'
import { DEEPSEEK_SEARCH_API_PROVIDER_ID, WEB_DEEPSEEK_API_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-deepseek-api'

/** The smallest real provider: one in-memory document, always writable. */
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

/** Request URL as text without `String(union)` (a Request stringifies to a placeholder). */
function urlText(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url
  if (url instanceof URL) return url.href
  return url.url
}

/** The JSON body a mock dispatch received, when the provider sent a string body. */
function bodyText(init: RequestInit | undefined): string {
  const body = init?.body
  return typeof body === 'string' ? body : ''
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const SEARCH_PAYLOAD = { results: [{ url: 'https://a.test', title: 'A', snippet: 's', date: null }] }
const FETCH_PAYLOAD = { content: '# page' }

/** A session face whose derived history ends with one human prompt. */
function sessionWithPrompt(text: string): { deriveMessages(): unknown[] } {
  return {
    deriveMessages: () => [{
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    }],
  }
}

async function boot(config: Record<string, unknown> = {}): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {
    searchProvider: DEEPSEEK_SEARCH_API_PROVIDER_ID,
    fetchProvider: 'deepseek-fetch-api',
  })
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const pluginFiber = ctx.plugin(deepseekApiPlugin, {
    apiKey: 'ds-key',
    baseURL: 'https://api.entry.test/v1/tools',
    ...config,
  })
  await pluginFiber.await()
  return { ctx, settingsFiber, pluginFiber }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** Answer every endpoint hit with the matching payload; returns the visited URLs. */
function answerEndpoints(): string[] {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url: RequestInfo | URL) => {
    const href = urlText(url)
    urls.push(href)
    return Promise.resolve(jsonResponse(href.endsWith('/fetch') ? FETCH_PAYLOAD : SEARCH_PAYLOAD))
  })
  return urls
}

describe('web-deepseek-api settings section', () => {
  it('registers both providers over one live section and serves a stored endpoint to the next operation', async () => {
    const bench = await boot()
    const urls = answerEndpoints()
    await bench.ctx.web.search({ query: 'anything' })
    await bench.ctx.web.fetch({ url: 'https://a.test' })
    expect(urls).toEqual(['https://api.entry.test/v1/tools/search', 'https://api.entry.test/v1/tools/fetch'])

    await bench.ctx.settings.update(WEB_DEEPSEEK_API_SETTINGS_NAMESPACE, {
      baseURL: 'https://api.stored.test/v1/tools',
    })

    urls.length = 0
    await bench.ctx.web.search({ query: 'anything' })
    expect(urls).toEqual(['https://api.stored.test/v1/tools/search'])
    await bench.ctx.fiber.dispose()
  })

  it('sends the initiating session prompt as ori_question by default and stops when disabled', async () => {
    const bench = await boot()
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(bodyText(init))
      return Promise.resolve(jsonResponse(SEARCH_PAYLOAD))
    })
    bench.ctx.provide('agents')
    bench.ctx.set('agents', {
      currentInitiator: () => ({ session: sessionWithPrompt('what changed in the release?') }),
    } as never)

    await bench.ctx.web.search({ query: 'release notes' })
    expect(JSON.parse(bodies[0] as string)).toMatchObject({ ori_question: 'what changed in the release?' })

    await bench.ctx.settings.update(WEB_DEEPSEEK_API_SETTINGS_NAMESPACE, { sendOriginalQuestion: false })
    await bench.ctx.web.search({ query: 'release notes' })
    expect(JSON.parse(bodies[1] as string)).not.toHaveProperty('ori_question')
    await bench.ctx.fiber.dispose()
  })

  it('resolves the key through the credentials service for each operation and names the plugin when none resolves', async () => {
    const bench = await boot({ apiKey: undefined, apiKeyEnv: 'DEEPSEEK_API_KEY' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(SEARCH_PAYLOAD))
    const stored: string[] = []
    bench.ctx.provide('credentials')
    bench.ctx.set('credentials', {
      resolve: async (ref: ReturnType<typeof credentialRef>) => {
        stored.push(ref)
        return { value: 'ds-resolved-key' }
      },
    } as never)

    await bench.ctx.web.search({ query: 'q' })
    expect(stored).toEqual(['DEEPSEEK_API_KEY'])

    bench.ctx.set('credentials', {
      resolve: async () => undefined,
    } as never)
    const error = await bench.ctx.web.search({ query: 'q' }).catch((cause: unknown) => cause)
    expect(String(error)).toContain('DEEPSEEK_API_KEY')
    expect(String(error)).toContain('web-deepseek-api')
    await bench.ctx.fiber.dispose()
  })

  it('keeps the literal key out of every described layer', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_DEEPSEEK_API_SETTINGS_NAMESPACE, { apiKey: 'ds-stored-secret' })

    const [descriptor] = bench.ctx.settings.describe({ redactSecrets: true })
      .filter(row => String(row.ns) === 'web-deepseek-api')

    expect(JSON.stringify(descriptor)).not.toContain('ds-stored-secret')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    await bench.ctx.fiber.dispose()
  })

  it('releases the namespace when the plugin unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('web-deepseek-api')

    await bench.pluginFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-deepseek-api')
    await bench.ctx.fiber.dispose()
  })
})
