import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import * as fetchPlugin from '@deepseek-ai/dsh-web-fetch-http'
import { classifyContentType, decoderForCharset, isPublicIp, isSameOrigin, parseCharset, validateFetchUrl } from '../src/policy.ts'

const limits: HttpFetchLimits = {
  maxUrlLength: 2048,
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 0,
  userAgent: 'test-agent/1.0',
}

type RequestStub = {
  once: (event: 'error', listener: (error: Error) => void) => RequestStub
  end: () => void
}
type RequestCallback = (response: IncomingMessage) => void
type RequestMock = (options: object, callback: RequestCallback) => RequestStub
type LookupMock = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<readonly { address: string; family: 4 | 6 }[]>

const httpRequestMock = vi.hoisted(() => vi.fn<RequestMock>())
const httpsRequestMock = vi.hoisted(() => vi.fn<RequestMock>())
const lookupMock = vi.hoisted(() => vi.fn<LookupMock>())

vi.mock('node:dns/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:dns/promises')>(),
  lookup: lookupMock,
}))

vi.mock('node:http', async importOriginal => ({
  ...await importOriginal<typeof import('node:http')>(),
  request: httpRequestMock,
}))

vi.mock('node:https', async importOriginal => ({
  ...await importOriginal<typeof import('node:https')>(),
  request: httpsRequestMock,
}))

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let port: number
let handler: Handler

beforeEach(async () => {
  vi.clearAllMocks()
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('default') }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  base = `http://public.test:${port}`
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

function provider(overrides: Partial<HttpFetchLimits> = {}): HttpFetchProvider {
  return new HttpFetchProvider({ ...limits, ...overrides }, {
    resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, _address, options) => {
      const target = new URL(url)
      target.hostname = '127.0.0.1'
      return await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': options.userAgent },
        signal: options.signal,
      })
    },
  })
}

describe('policy helpers', () => {
  it('validates scheme, credentials, and length', () => {
    expect(validateFetchUrl('https://example.com/x', 2048).hostname).toBe('example.com')
    expect(() => validateFetchUrl('ftp://example.com', 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateFetchUrl('not a url', 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateFetchUrl('https://user:pass@example.com', 2048)).toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(() => validateFetchUrl(`https://example.com/${'a'.repeat(3000)}`, 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it.each([
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects a non-public literal before network access: %s', (url) => {
    expect(() => validateFetchUrl(url, 2048)).toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('classifies public and non-public IP addresses', () => {
    expect(isPublicIp('93.184.216.34')).toBe(true)
    expect(isPublicIp('192.0.2.1')).toBe(false)
    expect(isPublicIp('2001:4860:4860::8888')).toBe(true)
    expect(isPublicIp('2001:db8::1')).toBe(false)
    expect(isPublicIp('::ffff:93.184.216.34')).toBe(false)
  })

  it('treats a non-IP string as non-public', () => {
    expect(isPublicIp('example.com')).toBe(false)
    expect(isPublicIp('')).toBe(false)
  })

  it('classifies full-form and trailing-compression IPv6 addresses', () => {
    expect(isPublicIp('2606:4700:4700:1111:2222:3333:4444:5555')).toBe(true)
    expect(isPublicIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(false)
    expect(isPublicIp('2606:4700::')).toBe(true)
    expect(isPublicIp('64:ff9b::1')).toBe(false)
  })

  it('compares URLs by scheme, hostname, and port', () => {
    const base = new URL('https://example.com:8443/path')
    expect(isSameOrigin(base, new URL('https://example.com:8443/other'))).toBe(true)
    expect(isSameOrigin(base, new URL('http://example.com:8443/'))).toBe(false)
    expect(isSameOrigin(base, new URL('https://other.example.com:8443/'))).toBe(false)
    expect(isSameOrigin(base, new URL('https://example.com/'))).toBe(false)
  })

  it('classifies content types', () => {
    expect(classifyContentType('text/html; charset=utf-8')).toBe('html')
    expect(classifyContentType('application/xhtml+xml')).toBe('html')
    expect(classifyContentType('text/plain')).toBe('text')
    expect(classifyContentType('application/json')).toBe('text')
    expect(classifyContentType('image/png')).toBeUndefined()
    expect(classifyContentType(null)).toBeUndefined()
  })

  it('parses the charset parameter', () => {
    expect(parseCharset('text/html; charset=UTF-8')).toBe('utf-8')
    expect(parseCharset('text/plain; charset="iso-8859-1"')).toBe('iso-8859-1')
    expect(parseCharset('text/plain')).toBeUndefined()
    expect(parseCharset(null)).toBeUndefined()
  })

  it('builds a decoder for a charset and defaults to UTF-8', () => {
    expect(decoderForCharset(undefined).encoding).toBe('utf-8')
    expect(decoderForCharset('iso-8859-1').encoding).toBe('windows-1252')
    expect(() => decoderForCharset('not-a-charset')).toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })
})

describe('HttpFetchProvider success', () => {
  it('fetches a text body', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello world') }
    const result = await provider().fetch({ url: base })
    expect(provider().available()).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ kind: 'text', content: 'hello world' })
    expect(result.truncated).toBe(false)
  })

  it('fetches an html body and classifies it as html', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>hi</h1>') }
    const result = await provider().fetch({ url: base })
    expect(result.body).toEqual({ kind: 'html', content: '<h1>hi</h1>' })
  })

  it('sends the configured user agent', async () => {
    let seen: string | undefined
    handler = (req, res) => { seen = req.headers['user-agent']; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') }
    await provider().fetch({ url: base })
    expect(seen).toBe('test-agent/1.0')
  })

  it('returns a non-2xx response as a result, not an error', async () => {
    handler = (_req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope') }
    const result = await provider().fetch({ url: base })
    expect(result.statusCode).toBe(404)
    expect(result.body).toEqual({ kind: 'text', content: 'nope' })
  })

  it('handles a no-body HTTP status without creating an invalid Response', async () => {
    handler = (_req, res) => { res.writeHead(204, { 'content-type': 'text/plain' }); res.end() }
    const result = await provider().fetch({ url: base })
    expect(result.statusCode).toBe(204)
    expect(result.body).toEqual({ kind: 'text', content: '' })
  })

  it('uses the built-in DNS resolver when only the transport is replaced', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])
    const resolved = new HttpFetchProvider(limits, {
      request: async () => new Response('resolved', { headers: { 'content-type': 'text/plain' } }),
    })
    const result = await resolved.fetch({ url: 'http://public.test/' })
    expect(lookupMock).toHaveBeenCalledWith('public.test', { all: true, order: 'verbatim' })
    expect(result.body).toEqual({ kind: 'text', content: 'resolved' })
  })

  it('accepts a public IPv6 literal without DNS lookup', async () => {
    let seenAddress: { address: string; family: 4 | 6 } | undefined
    const literal = new HttpFetchProvider(limits, {
      request: async (_url, address) => {
        seenAddress = address
        return new Response('ipv6', { headers: { 'content-type': 'text/plain' } })
      },
    })
    const result = await literal.fetch({ url: 'http://[2001:4860:4860::8888]/' })
    expect(seenAddress).toEqual({ address: '2001:4860:4860::8888', family: 6 })
    expect(lookupMock).not.toHaveBeenCalled()
    expect(result.body).toEqual({ kind: 'text', content: 'ipv6' })
  })

  it('uses the direct HTTP transport and converts response headers and body', async () => {
    const request = { once: vi.fn(), end: vi.fn() }
    const response = Object.assign(Readable.from([new Uint8Array([100, 105, 114, 101, 99, 116])]), {
      statusCode: 200,
      headers: { 'content-type': 'text/plain', 'x-test': ['one', 'two'], 'x-empty': undefined },
    })
    httpRequestMock.mockImplementationOnce((_options, onResponse) => {
      onResponse(response as unknown as IncomingMessage)
      return request
    })
    const direct = new HttpFetchProvider(limits, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    const result = await direct.fetch({ url: 'http://public.test/' })
    expect(result.body).toEqual({ kind: 'text', content: 'direct' })
    expect(httpRequestMock).toHaveBeenCalledOnce()
    expect(request.once).toHaveBeenCalledWith('error', expect.any(Function))
    expect(request.end).toHaveBeenCalledOnce()
  })

  it('uses the direct HTTPS transport and resumes a no-body response', async () => {
    const request = { once: vi.fn(), end: vi.fn() }
    const response = Object.assign(Readable.from([]), {
      statusCode: 204,
      headers: { 'content-type': 'text/plain' },
    })
    httpsRequestMock.mockImplementationOnce((_options, onResponse) => {
      onResponse(response as unknown as IncomingMessage)
      return request
    })
    const direct = new HttpFetchProvider(limits, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    const result = await direct.fetch({ url: 'https://public.test/' })
    expect(result.body).toEqual({ kind: 'text', content: '' })
    expect(httpsRequestMock).toHaveBeenCalledOnce()
    expect(httpsRequestMock.mock.calls[0]?.[0]).toMatchObject({ servername: 'public.test' })
    expect(request.end).toHaveBeenCalledOnce()
  })

  it('omits SNI for an HTTPS IPv4 literal', async () => {
    const request = { once: vi.fn(), end: vi.fn() }
    const response = Object.assign(Readable.from([]), {
      statusCode: 204,
      headers: { 'content-type': 'text/plain' },
    })
    httpsRequestMock.mockImplementationOnce((_options, onResponse) => {
      onResponse(response as unknown as IncomingMessage)
      return request
    })
    const direct = new HttpFetchProvider(limits)
    const result = await direct.fetch({ url: 'https://93.184.216.34/' })
    expect(result.body).toEqual({ kind: 'text', content: '' })
    expect(httpsRequestMock.mock.calls[0]?.[0]).toMatchObject({ servername: undefined })
  })

  it('translates malformed direct responses and destroys their streams', async () => {
    const request = { once: vi.fn(), end: vi.fn() }
    const destroy = vi.fn()
    const response = { statusCode: undefined, headers: {}, destroy } as unknown as IncomingMessage
    httpRequestMock.mockImplementationOnce((_options, onResponse) => {
      onResponse(response)
      return request
    })
    const direct = new HttpFetchProvider(limits, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    await expect(direct.fetch({ url: 'http://public.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('translates a direct request construction failure', async () => {
    httpRequestMock.mockImplementationOnce(() => { throw 'invalid request options' })
    const direct = new HttpFetchProvider(limits, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    await expect(direct.fetch({ url: 'http://public.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('HttpFetchProvider caps', () => {
  it('rejects an over-cap Content-Length with WEB_FETCH_TOO_LARGE', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' }); res.end('x'.repeat(999999)) }
    await expect(provider({ maxResponseBytes: 10 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TOO_LARGE' }))
  })

  it('truncates a stream that grows past the byte cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghij') }
    const result = await provider({ maxResponseBytes: 4 }).fetch({ url: base })
    expect(result.body.content).toBe('abcd')
    expect(result.truncated).toBe(true)
  })

  it('does not flag a body that exactly fills the byte cap as truncated', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcd') }
    const result = await provider({ maxResponseBytes: 4 }).fetch({ url: base })
    expect(result.body.content).toBe('abcd')
    expect(result.truncated).toBe(false)
  })

  it('truncates a decoded body past the character cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghij') }
    const result = await provider({ maxBodyChars: 3 }).fetch({ url: base })
    expect(result.body.content).toBe('abc')
    expect(result.truncated).toBe(true)
  })

  it('rejects an unsupported content type', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('binary') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('rejects a response with no content type at all', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('no type') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('accepts a declared content-length within the cap', async () => {
    handler = (_req, res) => { const body = 'sized'; res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) }); res.end(body) }
    const result = await provider().fetch({ url: base })
    expect(result.body.content).toBe('sized')
  })

  it('decodes a non-UTF-8 declared charset', async () => {
    // 0xE9 is "é" in ISO-8859-1; decoded as UTF-8 it would be a replacement char.
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }); res.end(Buffer.from([0x63, 0x61, 0x66, 0xE9])) }
    const result = await provider().fetch({ url: base })
    expect(result.body.content).toBe('café')
  })

  it('rejects an unsupported declared charset', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=not-a-charset' }); res.end('x') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })
})

describe('HttpFetchProvider redirects', () => {
  it.each([300, 301, 302, 303, 305, 306, 307, 308])('rejects HTTP %i redirects without contacting the target', async (status) => {
    let requests = 0
    let targetHits = 0
    handler = (req, res) => {
      requests++
      if (req.url === '/start') {
        res.writeHead(status, { location: `http://target.test:${port}/target` })
      } else {
        targetHits++
        res.writeHead(200, { 'content-type': 'text/plain' })
      }
      res.end()
    }
    await expect(provider().fetch({ url: `${base}/start` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    expect(requests).toBe(1)
    expect(targetHits).toBe(0)
  })

  it('rejects a redirect without a Location header under the same fixed policy', async () => {
    handler = (_req, res) => { res.writeHead(302); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })
})

describe('HttpFetchProvider invalid URLs and abort', () => {
  it('rejects a non-http scheme before any network access', async () => {
    await expect(provider().fetch({ url: 'ftp://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it.each([
    'http://127.0.0.1:1/',
    'http://10.0.0.1/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects a non-public literal before invoking transport: %s', async (url) => {
    let lookups = 0
    let requests = 0
    const guardedProvider = new HttpFetchProvider(limits, {
      resolveHostname: async () => {
        lookups++
        return [{ address: '93.184.216.34', family: 4 }]
      },
      request: async () => {
        requests++
        return new Response('unexpected', { headers: { 'content-type': 'text/plain' } })
      },
    })
    await expect(guardedProvider.fetch({ url }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(lookups).toBe(0)
    expect(requests).toBe(0)
  })

  it('fails closed when DNS resolution fails before invoking transport', async () => {
    let requests = 0
    const guardedProvider = new HttpFetchProvider(limits, {
      resolveHostname: async () => { throw new Error('DNS unavailable') },
      request: async () => {
        requests++
        return new Response('unexpected', { headers: { 'content-type': 'text/plain' } })
      },
    })
    await expect(guardedProvider.fetch({ url: 'http://unresolvable.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(requests).toBe(0)
  })

  it('fails closed when DNS returns a mixed public and non-public answer set', async () => {
    let requests = 0
    const guardedProvider = new HttpFetchProvider(limits, {
      resolveHostname: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ],
      request: async () => {
        requests++
        return new Response('unexpected', { headers: { 'content-type': 'text/plain' } })
      },
    })
    await expect(guardedProvider.fetch({ url: 'http://mixed.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(requests).toBe(0)
  })

  it('fails closed when DNS returns no addresses', async () => {
    const guardedProvider = new HttpFetchProvider(limits, {
      resolveHostname: async () => [],
      request: async () => new Response('unexpected', { headers: { 'content-type': 'text/plain' } }),
    })
    await expect(guardedProvider.fetch({ url: 'http://empty.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('rejects credentials in the URL', async () => {
    await expect(provider().fetch({ url: 'http://user:pass@127.0.0.1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('honors a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(provider().fetch({ url: base }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('aborts an in-flight fetch via the signal', async () => {
    handler = (_req, _res) => { /* never responds */ }
    const controller = new AbortController()
    const promise = provider().fetch({ url: base }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('aborts while DNS resolution is pending and cleans up the wait listener', async () => {
    const controller = new AbortController()
    const guardedProvider = new HttpFetchProvider(limits, {
      resolveHostname: async () => await new Promise<readonly { address: string; family: 4 }[]>(() => {}),
      request: async () => new Response('unexpected', { headers: { 'content-type': 'text/plain' } }),
    })
    const promise = guardedProvider.fetch({ url: 'http://pending.test/' }, controller.signal)
    controller.abort(new Error('caller stopped'))
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('observes an abort that happens before DNS wait registration', async () => {
    const controller = new AbortController()
    const guardedProvider = new HttpFetchProvider(limits, {
      resolveHostname: async () => {
        controller.abort(new Error('caller stopped'))
        return [{ address: '93.184.216.34', family: 4 }]
      },
      request: async () => new Response('unexpected', { headers: { 'content-type': 'text/plain' } }),
    })
    await expect(guardedProvider.fetch({ url: 'http://pending.test/' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('uses a generic abort error when an abort signal has no reason', async () => {
    const controller = new AbortController()
    Object.defineProperty(controller.signal, 'reason', { value: undefined })
    const guardedProvider = new HttpFetchProvider(limits, {
      resolveHostname: async () => {
        controller.abort(new Error('caller stopped'))
        return [{ address: '93.184.216.34', family: 4 }]
      },
      request: async () => new Response('unexpected', { headers: { 'content-type': 'text/plain' } }),
    })
    await expect(guardedProvider.fetch({ url: 'http://pending.test/' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))

    const pendingController = new AbortController()
    Object.defineProperty(pendingController.signal, 'reason', { value: undefined })
    const pendingProvider = new HttpFetchProvider(limits, {
      resolveHostname: async () => await new Promise<readonly { address: string; family: 4 }[]>(() => {}),
      request: async () => new Response('unexpected', { headers: { 'content-type': 'text/plain' } }),
    })
    const promise = pendingProvider.fetch({ url: 'http://pending.test/' }, pendingController.signal)
    pendingController.abort()
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('times out a slow response with WEB_FETCH_TIMEOUT', async () => {
    handler = (_req, _res) => { /* never responds */ }
    await expect(provider({ timeoutMs: 50 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('classifies a timeout DURING the body read as WEB_FETCH_TIMEOUT, not WEB_ABORTED', async () => {
    // Promise body that resolves headers (so fetch() returns) but a content-length
    // that outlasts the bytes sent, so readCapped()'s reader awaits more and the
    // timeout fires mid-read — the reader then surfaces a generic AbortError that
    // must still be recovered as the timeout reason via signal.reason.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      res.write('partial')
      // never send the remaining bytes nor end the response
    }
    await expect(provider({ timeoutMs: 80 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('maps a connection failure to WEB_PROVIDER_ERROR', async () => {
    // Port 1 on loopback is not listening: a real connection failure through the test transport.
    await expect(provider().fetch({ url: 'http://public.test:1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

})

describe('HttpFetchProvider body cancellation on error paths', () => {
  /** A fake Response whose body.cancel is observable. */
  type FakeInit = { status: number; headers: Record<string, string>; location?: string }
  function fakeResponse(init: FakeInit): { response: Response; cancelled: () => boolean } {
    let cancelled = false
    const headers = new Headers(init.headers)
    if (init.location !== undefined) headers.set('location', init.location)
    const response = {
      status: init.status,
      headers,
      body: { cancel: () => { cancelled = true; return Promise.resolve() } },
    } as unknown as Response
    return { response, cancelled: () => cancelled }
  }

  it('cancels the body when a redirect is blocked', async () => {
    const { response, cancelled } = fakeResponse({ status: 302, headers: {}, location: 'https://elsewhere.test/' })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'http://public.test:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    expect(cancelled()).toBe(true)
  })

  it('cancels the body when an unsupported charset is rejected', async () => {
    const { response, cancelled } = fakeResponse({ status: 200, headers: { 'content-type': 'text/plain; charset=not-a-charset' } })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'http://public.test:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
    expect(cancelled()).toBe(true)
  })

  it('cancels the body when a redirect has no Location header', async () => {
    const { response, cancelled } = fakeResponse({ status: 302, headers: {} })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'http://public.test:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    expect(cancelled()).toBe(true)
  })
})

describe('web-fetch-http plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, {})
    await expect(ctx.web.fetch({ url: 'http://127.0.0.1:1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await fiber.dispose()
    await expect(ctx.web.fetch({ url: 'http://127.0.0.1:1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in fetchPlugin).toBe(false)
  })

  it('rejects a non-positive resource limit at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxResponseBytes: -1 }))
      .rejects.toThrow(/maxResponseBytes must be a positive finite number/)
  })

  it('rejects a zero timeout at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { timeoutMs: 0 }))
      .rejects.toThrow(/timeoutMs must be a positive finite number/)
  })

  it('rejects a timeout beyond Node timer range at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { timeoutMs: 2_147_483_648 }))
      .rejects.toThrow(/timeoutMs must be no greater than 2147483647/)
  })

  it('rejects a fractional redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: 1.5 }))
      .rejects.toThrow(/maxRedirects must be 0 because redirects are disabled/)
  })

  it('rejects a negative redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: -1 }))
      .rejects.toThrow(/maxRedirects must be 0 because redirects are disabled/)
  })

  it('rejects a positive redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: 1 }))
      .rejects.toThrow(/maxRedirects must be 0 because redirects are disabled/)
  })

  it('accepts maxRedirects: 0 as valid config', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, { maxRedirects: 0 })
    await expect(ctx.web.fetch({ url: 'http://127.0.0.1:1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await fiber.dispose()
  })
})
