/** The `web-deepseek-api` settings section layered over the composition entry. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as deepseekApiPlugin from '@deepseek-ai/dsh-web-deepseek-api'
import { DEEPSEEK_SEARCH_API_PROVIDER_ID, DEEPSEEK_WEB_API_BASE_URL, WEB_DEEPSEEK_API_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-deepseek-api'

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

/** A session face with an arbitrary derived history. */
function sessionWithMessages(messages: unknown[]): { deriveMessages(): unknown[] } {
  return { deriveMessages: () => messages }
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

  it('omits ori_question by default and sends the initiating session prompt only when enabled', async () => {
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
    expect(JSON.parse(bodies[0] as string)).not.toHaveProperty('ori_question')

    await bench.ctx.settings.update(WEB_DEEPSEEK_API_SETTINGS_NAMESPACE, { sendOriginalQuestion: true })
    await bench.ctx.web.search({ query: 'release notes' })
    expect(JSON.parse(bodies[1] as string)).toMatchObject({ ori_question: 'what changed in the release?' })

    await bench.ctx.settings.update(WEB_DEEPSEEK_API_SETTINGS_NAMESPACE, { sendOriginalQuestion: false })
    await bench.ctx.web.search({ query: 'release notes' })
    expect(JSON.parse(bodies[2] as string)).not.toHaveProperty('ori_question')
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

  it('sends the latest human prompt, skipping injected user-role context and non-text blocks', async () => {
    const bench = await boot({ sendOriginalQuestion: true })
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(bodyText(init))
      return Promise.resolve(jsonResponse(SEARCH_PAYLOAD))
    })
    bench.ctx.provide('agents')
    bench.ctx.set('agents', {
      currentInitiator: () => ({
        session: sessionWithMessages([
          { role: 'assistant', source: { kind: 'user' }, content: [{ type: 'text', text: 'an answer' }] },
          { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'What changed' }] },
          { role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Injected instructions' }] },
        ]),
      }),
    } as never)

    await bench.ctx.web.search({ query: 'q' })
    expect(JSON.parse(bodies[0] as string)).toMatchObject({ ori_question: 'What changed' })
    await bench.ctx.fiber.dispose()
  })

  it('omits ori_question when no derived human prompt exists', async () => {
    const bench = await boot({ sendOriginalQuestion: true })
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(bodyText(init))
      return Promise.resolve(jsonResponse(SEARCH_PAYLOAD))
    })
    bench.ctx.provide('agents')
    bench.ctx.set('agents', {
      currentInitiator: () => ({
        session: sessionWithMessages([
          { role: 'assistant', source: { kind: 'user' }, content: [{ type: 'text', text: 'an answer' }] },
        ]),
      }),
    } as never)

    await bench.ctx.web.search({ query: 'q' })
    expect(JSON.parse(bodies[0] as string)).not.toHaveProperty('ori_question')
    await bench.ctx.fiber.dispose()
  })

  it('omits ori_question when the latest human prompt carries no text blocks', async () => {
    const bench = await boot({ sendOriginalQuestion: true })
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(bodyText(init))
      return Promise.resolve(jsonResponse(SEARCH_PAYLOAD))
    })
    bench.ctx.provide('agents')
    bench.ctx.set('agents', {
      currentInitiator: () => ({
        session: sessionWithMessages([
          { role: 'user', source: { kind: 'user' }, content: [{ type: 'reasoning', text: 'not prompt text' }] },
        ]),
      }),
    } as never)

    await bench.ctx.web.search({ query: 'q' })
    expect(JSON.parse(bodies[0] as string)).not.toHaveProperty('ori_question')
    await bench.ctx.fiber.dispose()
  })

  it('resolves the ambient environment key when no credentials seam exists', async () => {
    const bench = await boot({ apiKey: undefined, apiKeyEnv: 'DEEPSEEK_AMBIENT_KEY' })
    bench.ctx.provide('launchEnvironment')
    bench.ctx.set('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: { DEEPSEEK_AMBIENT_KEY: 'ds-ambient-key' } },
    ]))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(SEARCH_PAYLOAD))

    await expect(bench.ctx.web.search({ query: 'q' })).resolves.toBeDefined()

    // An empty ambient value is no credential at all.
    bench.ctx.set('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: { DEEPSEEK_AMBIENT_KEY: '' } },
    ]))
    await expect(bench.ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    await bench.ctx.fiber.dispose()
  })

  it('treats an empty literal key as absent and falls through to the environment', async () => {
    const bench = await boot({ apiKey: '', apiKeyEnv: 'DEEPSEEK_AMBIENT_KEY' })
    bench.ctx.provide('launchEnvironment')
    bench.ctx.set('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: { DEEPSEEK_AMBIENT_KEY: 'ds-ambient-key' } },
    ]))
    const authHeader: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      authHeader.push(String((init?.headers as Record<string, string>).authorization))
      return Promise.resolve(jsonResponse(SEARCH_PAYLOAD))
    })

    await bench.ctx.web.search({ query: 'q' })
    expect(authHeader[0]).toBe('Bearer ds-ambient-key')
    await bench.ctx.fiber.dispose()
  })

  it('keeps serving the composition entry endpoint after a partial section commit', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(WEB_DEEPSEEK_API_SETTINGS_NAMESPACE, { count: 7 })

    const urls: string[] = []
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(urlText(url))
      bodies.push(bodyText(init))
      return Promise.resolve(jsonResponse(urlText(url).endsWith('/fetch') ? FETCH_PAYLOAD : SEARCH_PAYLOAD))
    })

    await bench.ctx.web.search({ query: 'q' })
    await bench.ctx.web.fetch({ url: 'https://a.test' })
    // The committed count rides along; the untouched endpoint stays the entry's.
    expect(urls).toEqual(['https://api.entry.test/v1/tools/search', 'https://api.entry.test/v1/tools/fetch'])
    expect(JSON.parse(bodies[0] as string)).toMatchObject({ count: 7 })
    await bench.ctx.fiber.dispose()
  })

  it('serves the documented default base when the composition entry carries none', async () => {
    const bench = await boot({ baseURL: undefined })
    const urls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: RequestInfo | URL) => {
      urls.push(urlText(url))
      return Promise.resolve(jsonResponse(urlText(url).endsWith('/fetch') ? FETCH_PAYLOAD : SEARCH_PAYLOAD))
    })

    await bench.ctx.web.search({ query: 'q' })
    await bench.ctx.web.fetch({ url: 'https://a.test' })
    expect(urls).toEqual([`${DEEPSEEK_WEB_API_BASE_URL}/search`, `${DEEPSEEK_WEB_API_BASE_URL}/fetch`])
    await bench.ctx.fiber.dispose()
  })
})
