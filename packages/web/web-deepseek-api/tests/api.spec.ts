/** The DeepSeek Search and Fetch API providers over a fake transport. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  DEEPSEEK_DEFAULT_COUNT,
  DEEPSEEK_FETCH_API_PROVIDER_ID,
  DEEPSEEK_SEARCH_API_PROVIDER_ID,
  DEEPSEEK_WEB_API_BASE_URL,
  DeepSeekFetchApiProvider,
  DeepSeekSearchApiProvider,
  mapSearchResponse,
} from '@deepseek-ai/dsh-web-deepseek-api'
import type { DeepSeekFetchApiOptions, DeepSeekSearchApiOptions } from '@deepseek-ai/dsh-web-deepseek-api'

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

const searchProvider = (options: DeepSeekSearchApiOptions): DeepSeekSearchApiProvider =>
  new DeepSeekSearchApiProvider(() => options)

const fetchProvider = (options: DeepSeekFetchApiOptions): DeepSeekFetchApiProvider =>
  new DeepSeekFetchApiProvider(() => options)

const baseOptions = {
  apiKey: 'ds-key',
  baseURL: 'https://api.deepseek.test/v1/tools',
  count: DEEPSEEK_DEFAULT_COUNT,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** One Search API answer with every optional field present. */
const SEARCH_PAYLOAD = {
  results: [
    { url: 'https://a.test', title: 'A', snippet: 'excerpt A', summary: 'summary A', date: '2026-02-02' },
    { url: 'https://b.test', title: '', snippet: '', summary: '', date: null },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mapSearchResponse', () => {
  it('keeps non-empty title, snippet, and date, and drops the per-result summary the seam does not carry', () => {
    expect(mapSearchResponse(SEARCH_PAYLOAD)).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'excerpt A', publishedAt: '2026-02-02' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
  })

  it('rejects payloads without a results array', () => {
    expect(() => mapSearchResponse({})).toThrow(WebError)
    expect(() => mapSearchResponse(null)).toThrow(/invalid response body/u)
  })

  it('rejects result items without a usable url', () => {
    expect(() => mapSearchResponse({ results: [{ title: 'A' }] })).toThrow(WebError)
  })
})

describe('DeepSeekSearchApiProvider', () => {
  it('posts one direct search request with bearer authentication', async () => {
    interface CapturedCall {
      url: string
      body: string
      method: string
      redirect: RequestRedirect
      authorization: string | null
      contentType: string | null
    }
    const calls: CapturedCall[] = []
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: urlText(url),
        body: bodyText(init),
        method: init?.method ?? 'GET',
        redirect: init?.redirect ?? 'follow',
        authorization: headers.get('authorization'),
        contentType: headers.get('content-type'),
      })
      return Promise.resolve(jsonResponse(SEARCH_PAYLOAD))
    }))
    const result = await searchProvider(baseOptions).search({ query: 'harniverse release' })

    expect(result).toEqual(mapSearchResponse(SEARCH_PAYLOAD))
    expect(calls).toEqual([{
      url: 'https://api.deepseek.test/v1/tools/search',
      body: JSON.stringify({
        query: 'harniverse release',
        count: DEEPSEEK_DEFAULT_COUNT,
        need_content: false,
      }),
      method: 'POST',
      redirect: 'error',
      authorization: 'Bearer ds-key',
      contentType: 'application/json',
    }])
  })

  it('lets a smaller request maxResults win over the configured count', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(bodyText(init))
      return Promise.resolve(jsonResponse({ results: [] }))
    }))
    await searchProvider(baseOptions).search({ query: 'q', maxResults: 3 })

    const sent = JSON.parse(bodies[0] ?? '{}') as { query?: string; count?: number }
    expect(sent).toEqual({ query: 'q', count: 3, need_content: false })
  })

  it('sends the bounded triggering question as ori_question when one is supplied', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(bodyText(init))
      return Promise.resolve(jsonResponse({ results: [] }))
    }))
    const question = `  ${'word '.repeat(40)}\n\n` // 200 chars, mixed whitespace
    await searchProvider({ ...baseOptions, originalQuestion: () => question }).search({ query: 'q' })

    const sent = JSON.parse(bodies[0] ?? '{}') as { ori_question?: string }
    expect(sent.ori_question).toBe(Array.from(question.replace(/\s+/gu, ' ').trim()).slice(0, 128).join(''))
  })

  it('omits ori_question when the question reader yields nothing usable', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(bodyText(init))
      return Promise.resolve(jsonResponse({ results: [] }))
    }))
    await searchProvider({ ...baseOptions, originalQuestion: () => '   ' }).search({ query: 'q' })
    await searchProvider(baseOptions).search({ query: 'q' })

    for (const body of bodies) expect(JSON.parse(body) as object).not.toHaveProperty('ori_question')
  })

  it('trims a trailing slash from the configured base before appending /search', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
      urls.push(urlText(url))
      return Promise.resolve(jsonResponse({ results: [] }))
    }))
    await searchProvider({ ...baseOptions, baseURL: 'https://api.deepseek.test/v1/tools/' }).search({ query: 'q' })

    expect(urls).toEqual(['https://api.deepseek.test/v1/tools/search'])
  })

  it('surfaces the provider detail, the endpoint, and the settings guidance on an API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: { message: 'quota exhausted' } }, { status: 429 })))
    const failure = await searchProvider(baseOptions).search({ query: 'q' }).then(
      () => { throw new Error('expected a provider failure') },
      (cause: unknown) => cause,
    )
    if (!(failure instanceof WebError)) throw failure
    const error: WebError = failure

    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('HTTP 429')
    expect(error.message).toContain('quota exhausted')
    expect(error.message).toContain('"https://api.deepseek.test/v1/tools/search"')
    expect(error.message).toContain('web-deepseek-api.baseURL')
  })

  it('reads a plain-string error field as the provider detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: 'plain failure detail' }, { status: 500 })))
    await expect(searchProvider(baseOptions).search({ query: 'q' }))
      .rejects.toThrow('plain failure detail')
  })

  it('reads a top-level message field when the error body carries no error object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ message: 'top-level detail' }, { status: 403 })))
    await expect(searchProvider(baseOptions).search({ query: 'q' }))
      .rejects.toThrow('top-level detail')
  })

  it('keeps the HTTP status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('gateway noise', { status: 502, headers: { 'content-type': 'text/plain' } })))
    await expect(searchProvider(baseOptions).search({ query: 'q' }))
      .rejects.toThrow('HTTP 502')
  })

  it('keeps the HTTP status when the error body is JSON but carries no usable detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null, { status: 503 })))
    await expect(searchProvider(baseOptions).search({ query: 'q' }))
      .rejects.toThrow('HTTP 503')
  })

  it('surfaces a mid-body abort as WEB_ABORTED rather than an HTTP error', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      // The transport starts reading the error body after the caller aborted.
      controller.abort()
      return new Response('busy', { status: 429, headers: { 'content-type': 'text/plain' } })
    }))
    await expect(searchProvider(baseOptions).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('wraps a malformed success body as an unprocessable provider response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('just a string')))
    const failure = await searchProvider(baseOptions).search({ query: 'q' }).then(
      () => { throw new Error('expected a provider failure') },
      (cause: unknown) => cause,
    )
    if (!(failure instanceof WebError)) throw failure
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('invalid response body')
  })

  it('forwards the caller signal to the dispatch and the fetch provider does the same', async () => {
    const inits: (RequestInit | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init)
      return Promise.resolve(jsonResponse(urlText(url).endsWith('/fetch') ? { content: '# page' } : SEARCH_PAYLOAD))
    }))
    const controller = new AbortController()
    await searchProvider(baseOptions).search({ query: 'q' }, controller.signal)
    await fetchProvider({ apiKey: 'ds-key', baseURL: baseOptions.baseURL }).fetch({ url: 'https://a.test' }, controller.signal)
    await fetchProvider({ apiKey: 'ds-key', baseURL: baseOptions.baseURL }).fetch({ url: 'https://a.test' })
    expect(inits[0]?.signal).toBe(controller.signal)
    expect(inits[1]?.signal).toBe(controller.signal)
    expect(inits[2]?.signal).toBeUndefined()
  })

  it('maps a rejecting credential resolver to a provider error without contacting the endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const failure = await searchProvider({
      baseURL: baseOptions.baseURL,
      count: baseOptions.count,
      resolveApiKey: () => Promise.reject(new Error('credential storage offline')),
    }).search({ query: 'q' }).then(
      () => { throw new Error('expected a provider failure') },
      (cause: unknown) => cause,
    )
    if (!(failure instanceof WebError)) throw failure
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('credential resolution failed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a credential resolver that rejects with an abort as WEB_ABORTED', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchProvider({
      baseURL: baseOptions.baseURL,
      count: baseOptions.count,
      resolveApiKey: () => Promise.reject(new DOMException('resolver aborted', 'AbortError')),
    }).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancels a pending credential resolution through the caller signal', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = searchProvider({
      baseURL: baseOptions.baseURL,
      count: baseOptions.count,
      resolveApiKey: () => new Promise(() => {}),
    }).search({ query: 'q' }, controller.signal)
    const outcome = pending.then(
      () => { throw new Error('expected an abort failure') },
      (cause: unknown) => cause,
    )
    controller.abort()
    const failure = await outcome
    expect(failure).toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('settles a resolved credential through a present caller signal', async () => {
    const headers: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers.push(String((init?.headers as Record<string, string>).authorization))
      return Promise.resolve(jsonResponse(SEARCH_PAYLOAD))
    }))
    const controller = new AbortController()
    await searchProvider({
      baseURL: baseOptions.baseURL,
      count: baseOptions.count,
      resolveApiKey: async () => 'ds-resolved-key',
    }).search({ query: 'q' }, controller.signal)
    expect(headers[0]).toBe('Bearer ds-resolved-key')
  })

  it('reports a rejecting credential resolver through a present caller signal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(SEARCH_PAYLOAD)))
    const failure = await searchProvider({
      baseURL: baseOptions.baseURL,
      count: baseOptions.count,
      resolveApiKey: () => Promise.reject(new Error('resolver failed late')),
    }).search({ query: 'q' }, new AbortController().signal).then(
      () => { throw new Error('expected a provider failure') },
      (cause: unknown) => cause,
    )
    expect(String(failure)).toContain('credential resolution failed')
  })

  it('reports an abort raised while reading a success body as WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new DOMException('body read aborted', 'AbortError')),
    }) as unknown as Response))
    await expect(searchProvider(baseOptions).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('names the credential reference when no key resolves', async () => {
    const failure = await searchProvider({ baseURL: baseOptions.baseURL, count: baseOptions.count })
      .search({ query: 'q' }).then(
        () => { throw new Error('expected a provider failure') },
        (cause: unknown) => cause,
      )
    if (!(failure instanceof WebError)) throw failure

    expect(failure.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
    expect(failure.message).toContain('DEEPSEEK_API_KEY')
    expect(failure.message).toContain('web-deepseek-api')
  })

  it('reports an already-aborted search as WEB_ABORTED without contacting the endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    const failure = await searchProvider(baseOptions).search({ query: 'q' }, controller.signal).then(
      () => { throw new Error('expected an abort failure') },
      (cause: unknown) => cause,
    )
    expect(failure).toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the bare HTTP status when the error detail is an empty string', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '' }, { status: 500 })))
    const failure = await searchProvider(baseOptions).search({ query: 'q' }).then(
      () => { throw new Error('expected a provider failure') },
      (cause: unknown) => cause,
    )
    expect(String(failure)).toContain('HTTP 500')
    expect(String(failure)).not.toContain('HTTP 500: ')
  })

  it('reports an abort raised while reading the error body as WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      json: () => Promise.reject(new DOMException('body read aborted', 'AbortError')),
    }) as unknown as Response))
    await expect(searchProvider(baseOptions).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('wraps a non-JSON success body as an unprocessable provider response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })))
    const failure = await searchProvider(baseOptions).search({ query: 'q' }).then(
      () => { throw new Error('expected a provider failure') },
      (cause: unknown) => cause,
    )
    if (!(failure instanceof WebError)) throw failure
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('unprocessable response body')
  })

  it('maps an abort raised inside dispatch to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    }))
    await expect(searchProvider(baseOptions).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('refuses a redirect-shaped response as a provider error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test' } })))
    await expect(searchProvider(baseOptions).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('stays unavailable without any credential source or a parseable endpoint', () => {
    expect(searchProvider(baseOptions).available()).toBe(true)
    const noCredential = { baseURL: baseOptions.baseURL, count: baseOptions.count } as const
    expect(searchProvider(noCredential).available()).toBe(false)
    expect(searchProvider({ ...baseOptions, baseURL: 'not a url' }).available()).toBe(false)
    expect(searchProvider({ ...baseOptions, count: 0 }).available()).toBe(false)
  })
})

describe('DeepSeekFetchApiProvider', () => {
  it('retrieves page Markdown as one text body with HTTP 200 semantics', async () => {
    const calls: Array<{ url: string; body: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: urlText(url), body: bodyText(init) })
      return Promise.resolve(jsonResponse({ content: '# Page\n\nContents.' }))
    }))
    const result = await fetchProvider(baseOptions).fetch({ url: 'https://a.test/doc' })

    expect(result).toEqual({
      url: 'https://a.test/doc',
      statusCode: 200,
      body: { kind: 'text', content: '# Page\n\nContents.' },
      truncated: false,
    })
    expect(calls).toEqual([{
      url: 'https://api.deepseek.test/v1/tools/fetch',
      body: JSON.stringify({ url: 'https://a.test/doc' }),
    }])
  })

  it('rejects a payload without string content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: 7 })))
    await expect(fetchProvider(baseOptions).fetch({ url: 'https://a.test' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
    })
  })

  it('names the Fetch endpoint and its settings guidance on dispatch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hung up') }))
    const failure = await fetchProvider(baseOptions).fetch({ url: 'https://a.test' }).then(
      () => { throw new Error('expected a provider failure') },
      (cause: unknown) => cause,
    )
    if (!(failure instanceof WebError)) throw failure
    const error: WebError = failure

    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('socket hung up')
    expect(error.message).toContain('"https://api.deepseek.test/v1/tools/fetch"')
    expect(error.message).toContain('Fetch')
  })

  it('stays unavailable without a credential source', () => {
    expect(fetchProvider(baseOptions).available()).toBe(true)
    expect(fetchProvider({ baseURL: baseOptions.baseURL }).available()).toBe(false)
  })
})

describe('provider identity', () => {
  it('registers the stable ids and default base from the Search API documentation', () => {
    expect(DEEPSEEK_SEARCH_API_PROVIDER_ID).toBe('deepseek-search-api')
    expect(DEEPSEEK_FETCH_API_PROVIDER_ID).toBe('deepseek-fetch-api')
    expect(DEEPSEEK_WEB_API_BASE_URL).toBe('https://api.deepseek.com/v1/tools')
  })
})
