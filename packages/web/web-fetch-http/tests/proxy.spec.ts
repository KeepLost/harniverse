import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'

const limits: HttpFetchLimits = {
  maxUrlLength: 2_000,
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 0,
  userAgent: 'test-agent/1.0',
}

/** Absolute-form targets the fake proxy saw; a populated entry proves the hop was tunnelled. */
let proxied: string[]
let proxy: Server
let proxyUrl: string

/**
 * The target for every assertion about a tunnelled hop. Loopback cannot serve: no policy routes
 * this machine through a proxy. The host never resolves — the proxy answers the absolute-form
 * request — which is also what makes the skipped resolver observable.
 */
const proxyTarget = 'http://origin.test/page'
let disposeProxy: (() => Promise<void>) | undefined

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
}

function respond(_request: IncomingMessage, response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(body)
}

beforeEach(async () => {
  proxied = []
  proxy = createServer((request, response) => {
    proxied.push(request.url ?? '')
    respond(request, response, 'via-proxy')
  })
  const proxyAddress = await listen(proxy)
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
})

afterEach(async () => {
  await disposeProxy?.()
  disposeProxy = undefined
  vi.restoreAllMocks()
  await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
})

/**
 * Install the policy of a user who exported one proxy for both schemes; the fixture disposes it
 * after every case.
 */
async function installProxy(): Promise<() => Promise<void>> {
  const env = { get: (name: string) => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
  return await installProxyFromEnvironment(env, () => undefined)
}

describe('fetching through a proxy', () => {
  it('tunnels the request and never resolves a public address for it', async () => {
    const resolve = vi.fn((_hostname: string, _signal: AbortSignal) => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]))
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits, { resolveHostname: resolve }).fetch({ url: proxyTarget })

    expect(result.body.content).toBe('via-proxy')
    expect(proxied).toEqual([proxyTarget])
    // Through a proxy the origin's DNS happens proxy-side, so the resolver that rejects non-public
    // destinations is not consulted at all.
    expect(resolve).not.toHaveBeenCalled()
  })

  it('keeps resolving and pinning a hop the policy does not proxy', async () => {
    const resolve = vi.fn((_hostname: string, _signal: AbortSignal) => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]))
    const request = vi.fn(async () => new Response('direct', { headers: { 'content-type': 'text/plain' } }))
    // The bypass list leaves this host direct under a policy that proxies everything else.
    const env = { get: (name: string) => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : name === 'NO_PROXY' || name === 'no_proxy' ? { value: 'direct.test' } : undefined) }
    disposeProxy = await installProxyFromEnvironment(env, () => undefined)

    const result = await new HttpFetchProvider(limits, { resolveHostname: resolve, request }).fetch({ url: 'http://direct.test/page' })

    expect(result.body.content).toBe('direct')
    expect(proxied).toEqual([])
    expect(resolve).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  it('resolves and pins when no proxy is installed', async () => {
    const resolve = vi.fn((_hostname: string, _signal: AbortSignal) => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]))
    const request = vi.fn(async () => new Response('direct', { headers: { 'content-type': 'text/plain' } }))

    const result = await new HttpFetchProvider(limits, { resolveHostname: resolve, request }).fetch({ url: 'http://direct.test/page' })

    expect(result.body.content).toBe('direct')
    expect(resolve).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
  })

  it.each(['10.0.0.5', '169.254.169.254', '127.0.0.2'])(
    'refuses %s instead of letting the proxy reach it for us',
    async (host) => {
      disposeProxy = await installProxy()

      // A literal is refused before any hop: the proxy would otherwise resolve nothing for us — it
      // would simply be handed the private or loopback destination the address checks exist to
      // refuse, from a network position of its own choosing.
      await expect(new HttpFetchProvider(limits).fetch({ url: `http://${host}:8080/` }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
      expect(proxied).toEqual([])
    },
  )

  it('still refuses a cross-origin redirect on the proxied path', async () => {
    proxy.removeAllListeners('request')
    proxy.on('request', (request, response) => {
      proxied.push(request.url ?? '')
      response.writeHead(302, { location: 'http://elsewhere.example/next' })
      response.end()
    })
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: proxyTarget }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('still refuses a URL the transport policy rejects before any hop', async () => {
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: 'ftp://example.com/x' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(proxied).toEqual([])
  })
})
