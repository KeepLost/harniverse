import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import {
  clearedProxyEnv,
  installProxyFromEnvironment,
  proxyRouteFor,
} from '../src/index.ts'
import { PROXY_ENV_NAMES, resolveProxyPolicy } from '../src/policy.ts'
import { ProxyDispatcher, type DispatchHandlers, type DispatchOptions, type Dispatcher } from '../src/dispatcher.ts'

/**
 * The symbol Node's global fetch resolves its dispatcher through, re-read per call. `undefined`
 * means Node's own internal default — the state a fresh process starts in.
 */
const DISPATCHER = Symbol.for('undici.globalDispatcher.1')

/** The dispatcher global fetch is using right now. */
function currentDispatcher(): unknown {
  return (globalThis as Record<symbol, unknown>)[DISPATCHER]
}

/** Set the dispatcher global fetch uses; `undefined` restores Node's internal default. */
function setDispatcher(value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, DISPATCHER)
  else (globalThis as Record<symbol, unknown>)[DISPATCHER] = value
}

/** Sockets the fake proxy tunnelled; destroyed at teardown so server.close need not wait on them. */
const tunneled = new Set<Duplex>()
/** WebSocket sockets accepted by the loopback origin; closed after each case. */
const upgraded = new Set<Duplex>()

/** Absolute-form request targets the fake proxy received; a populated entry proves a request was tunnelled. */
let proxied: string[] = []
let upgradeHeaders: IncomingMessage['headers'][] = []
let connectHeaders: IncomingMessage['headers'][] = []
/** How the fake proxy answers CONNECT: tunnel to the origin, or hang up. */
let connectMode: 'tunnel' | 'hangup' | 'refuse' | 'stall' | 'tls-stall' = 'hangup'
let upgradeMode: 'accept' | 'refuse' | 'stall' = 'accept'
let tlsStarted = false
let proxy: Server
let origin: Server
let secureOrigin: HttpsServer
let proxyUrl: string
let originUrl: string
let secureUrl: string
const secure = readFileSync(new URL('fixtures/loopback-self-signed.pem', import.meta.url), 'utf8')
const [keyMaterial, certMaterial] = secure.split('-----BEGIN CERTIFICATE-----')
const certificate = `-----BEGIN CERTIFICATE-----${certMaterial}`

/**
 * The target for every assertion about a tunnelled hop. It is deliberately not loopback: no policy
 * routes this machine through a proxy, so a loopback target could only ever prove a direct hop. The
 * host never resolves — the client connects to the proxy, which answers the absolute-form request.
 */
const proxyTarget = 'http://origin.test/probe'

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeIdleConnections?.()
    server.close(() => { resolve() })
  })
}

/** The fixture only accepts the short, masked text/close frames used by these cases. */
function acceptWebSocket(request: IncomingMessage, socket: Duplex): void {
  upgraded.add(socket)
  socket.once('close', () => { upgraded.delete(socket) })
  socket.once('end', () => { socket.end() })
  socket.on('error', () => { socket.destroy() })
  upgradeHeaders.push(request.headers)
  if (upgradeMode === 'stall') { socket.resume(); return }
  if (upgradeMode === 'refuse') {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string') { socket.destroy(); return }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  // Coalesce the first frame with the HTTP response to exercise Node's upgrade `head` bytes.
  socket.write(Buffer.concat([
    Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`),
    Buffer.from([0x81, 5]), Buffer.from('ready'),
  ]))
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 6) {
      const opcode = buffered[0]! & 0x0f
      const length = buffered[1]! & 0x7f
      if (length > 125) { socket.destroy(); return }
      if (buffered.length < 6 + length) return
      const payload = Buffer.from(buffered.subarray(6, 6 + length))
      for (let i = 0; i < length; i++) payload[i] = payload[i]! ^ buffered[2 + i % 4]!
      buffered = buffered.subarray(6 + length)
      const frame = Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
      if (opcode === 8) { socket.end(frame); return }
      socket.write(frame)
    }
  })
}

async function webSocketEcho(url: string, afterOpen?: () => Promise<void>): Promise<void> {
  const socket = new WebSocket(url)
  try {
    const [message] = await once(socket, 'message', { signal: AbortSignal.timeout(1500) }) as [MessageEvent]
    expect(message.data).toBe('ready')
    expect(socket.readyState).toBe(WebSocket.OPEN)
    await afterOpen?.()
    const echoed = once(socket, 'message', { signal: AbortSignal.timeout(1500) })
    socket.send('proxy-round-trip')
    expect((await echoed as [MessageEvent])[0].data).toBe('proxy-round-trip')
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(1500) })
      socket.close()
      await closed
    }
  }
}

function upgradeRequest(url: string, extra: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    origin: url, path: '/socket', method: 'GET', upgrade: 'websocket',
    signal: AbortSignal.timeout(1500),
    headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
    ...extra,
  }
}

/** Exercise the dispatcher callbacks as well as the native WebSocket entry point. */
function dispatchUpgrade(dispatcher: Dispatcher, options: DispatchOptions) {
  const errors: Error[] = []
  let abort!: (reason?: unknown) => void
  const result = new Promise<Duplex | Error>((resolve) => {
    const handlers: DispatchHandlers = {
      onConnect: (callback) => { abort = callback },
      onHeaders: () => { throw new Error('unexpected HTTP response callback') },
      onData: () => { throw new Error('unexpected HTTP body callback') },
      onComplete: () => { throw new Error('unexpected HTTP completion callback') },
      onUpgrade: (_status, _headers, socket) => { resolve(socket) },
      onError: (error) => { errors.push(error); resolve(error) },
    }
    dispatcher.dispatch(options, handlers)
  })
  return { result, errors, abort: (reason?: unknown) => { abort(reason) } }
}

function nativeDispatcher(): ProxyDispatcher {
  return new ProxyDispatcher(resolveProxyPolicy(proxyAll()).policy, undefined)
}

beforeAll(async () => {
  proxy = createServer((request, response) => {
    proxied.push(`${request.method} ${request.url}`)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('VIA-PROXY')
  })
  proxy.on('connect', (request, socket) => {
    proxied.push(`CONNECT ${request.url ?? ''}`)
    connectHeaders.push(request.headers)
    tunneled.add(socket)
    socket.once('close', () => { tunneled.delete(socket) })
    socket.once('end', () => { socket.end() })
    socket.on('error', () => { socket.destroy() })
    if (connectMode === 'stall') { socket.resume(); return }
    if (connectMode === 'tls-stall') {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.on('data', () => { tlsStarted = true })
      return
    }
    if (connectMode === 'refuse') {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (connectMode === 'tunnel') {
      const [, port] = (request.url ?? '').split(':')
      const upstream = connect(Number(port ?? 443), '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      tunneled.add(upstream)
      upstream.once('close', () => { tunneled.delete(upstream); socket.destroy() })
      socket.once('close', () => { upstream.destroy() })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      return
    }
    socket.end()
  })
  origin = createServer((_request, response) => { response.end('DIRECT') })
  origin.on('upgrade', acceptWebSocket)
  secureOrigin = createHttpsServer(
    { cert: certificate, key: keyMaterial },
    (_request, response) => { response.end('SECURE-VIA-PROXY') },
  )
  secureOrigin.on('upgrade', acceptWebSocket)
  const [proxyAddress, originAddress, secureAddress] = await Promise.all([
    listen(proxy),
    listen(origin),
    listen(secureOrigin),
  ])
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
  originUrl = `http://127.0.0.1:${String(originAddress.port)}/probe`
  secureUrl = `https://secure-origin.test:${String(secureAddress.port)}/probe`
})

afterAll(async () => {
  for (const socket of tunneled) socket.destroy()
  await Promise.all([close(proxy), close(origin), close(secureOrigin)])
})

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  proxied = []
  upgradeHeaders = []
  connectHeaders = []
  connectMode = 'hangup'
  upgradeMode = 'accept'
  tlsStarted = false
  const sockets = [...upgraded, ...tunneled]
  await Promise.all(sockets.map(async (socket) => {
    if (socket.closed) return
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(1500) })
    socket.destroy()
    await closed
  }))
})

/** A launch environment built from the names a user would export, in the casings they wrote. */
function env(values: Record<string, string>): { get(name: string): { value: string } | undefined } {
  return { get: name => (name in values ? { value: values[name] as string } : undefined) }
}

/** The environment of a user who exported one proxy for both schemes. */
function proxyAll(noProxy?: string): { get(name: string): { value: string } | undefined } {
  return env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ...noProxy === undefined ? {} : { NO_PROXY: noProxy } })
}

/** Install and collect whatever the resolution reported, so a case can assert on both. */
async function install(
  lookup: { get(name: string): { value: string } | undefined },
): Promise<{ dispose: () => Promise<void>; reported: string[] }> {
  const reported: string[] = []
  const dispose = await installProxyFromEnvironment(lookup, (message) => { reported.push(message) })
  return { dispose, reported }
}

/** Run one case from a known-empty proxy environment, then restore what the machine had. */
async function withCleanProxyEnv(run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
  for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
  try {
    await run()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

describe('installProxyFromEnvironment', () => {
  it('routes the built-in global fetch through the proxy', async () => {
    const { dispose } = await install(proxyAll())
    try {
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      expect(proxied).toEqual([`GET ${proxyTarget}`])
    } finally {
      await dispose()
    }
  })

  it('tunnels https targets through CONNECT and surfaces the proxy\'s refusal', async () => {
    const { dispose } = await install(proxyAll())
    try {
      // The fake proxy records the CONNECT and hangs up, so the hop fails — what the case asserts
      // is the method and the exact authority the tunnel asked for.
      await expect(fetch('https://secure-origin.test/x', { signal: AbortSignal.timeout(1500) })).rejects.toThrow()
      expect(proxied).toEqual(['CONNECT secure-origin.test:443'])
    } finally {
      await dispose()
    }
  })

  it('tunnels an https target through an established CONNECT and returns the origin response', async () => {
    connectMode = 'tunnel'
    // The fixture certificate is self-signed for the loopback; the tunnel's TLS arm honors the
    // standard opt-out for the duration of this one case.
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const { dispose } = await install(proxyAll())
    try {
      await expect((await fetch(secureUrl)).text()).resolves.toBe('SECURE-VIA-PROXY')
      expect(proxied).toHaveLength(1)
      expect(proxied[0]).toMatch(/^CONNECT secure-origin\.test:\d+$/)
    } finally {
      await dispose()
      if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_TLS_REJECT_UNAUTHORIZED')
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous
    }
  })

  it('aborts a proxied fetch through the caller\'s signal', async () => {
    const { dispose } = await install(proxyAll())
    try {
      const controller = new AbortController()
      const pending = fetch(originUrl, { signal: controller.signal })
      controller.abort()
      await expect(pending).rejects.toThrow(/abort/i)
    } finally {
      await dispose()
    }
  })

  it('routes direct URLs through the dispatcher it displaced, not its own transport', async () => {
    // A third party (SDK, embedding app) may already have installed a dispatcher; a proxied policy
    // layered over it must keep handing direct URLs to that dispatcher untouched.
    const marker = new Error('delegate-marker')
    const stub = {
      dispatch(_options: unknown, handler: { onError(error: Error): void }): boolean {
        queueMicrotask(() => { handler.onError(marker) })
        return false
      },
    }
    const previous = currentDispatcher()
    setDispatcher(stub)
    try {
      const { dispose } = await install(env({ HTTPS_PROXY: proxyUrl }))
      try {
        const failure = await fetch(proxyTarget).then(() => undefined, (error: unknown) => error as Error & { cause?: unknown })
        expect(failure).toBeDefined()
        expect((failure?.cause as Error | undefined)?.message).toBe('delegate-marker')
        expect(proxied).toEqual([])
      } finally {
        await dispose()
      }
    } finally {
      setDispatcher(previous)
    }
  })

  it('connects directly when the bypass list covers the target', async () => {
    const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, NO_PROXY: 'origin.test' }))
    try {
      await expect(fetch(proxyTarget, { signal: AbortSignal.timeout(1500) })).rejects.toThrow()
      expect(proxied).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('keeps a loopback WebSocket upgrade direct while a proxy is installed', async () => {
    const { dispose } = await install(proxyAll())
    try {
      await webSocketEcho(originUrl.replace('http:', 'ws:'))
      expect(proxied).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('tunnels a non-loopback WebSocket upgrade through CONNECT', async () => {
    connectMode = 'tunnel'
    const { dispose } = await install(proxyAll())
    try {
      await webSocketEcho(`ws://origin.test:${new URL(originUrl).port}/socket`)
      expect(proxied[0]).toMatch(/^CONNECT origin\.test:\d+$/)
    } finally {
      await dispose()
    }
  })

  it('reports a value it cannot use and installs the rest', async () => {
    const { dispose, reported } = await install(env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1080' }))
    try {
      // A variable exported for another tool must not stop the agent from starting, and the user
      // has to learn that this scheme stays direct rather than discover it from a failing request.
      // The message names the variable, never its value: a proxy URL may carry `user:password`.
      expect(reported).toHaveLength(1)
      expect(reported[0]).toContain('HTTPS_PROXY')
      expect(reported[0]).toContain('SOCKS')
      expect(reported[0]).not.toContain('1080')
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
    } finally {
      await dispose()
    }
  })

  it('leaves the user\'s process environment untouched while the policy routes', async () => {
    await withCleanProxyEnv(async () => {
      process.env.HTTP_PROXY = proxyUrl
      process.env.https_proxy = 'socks5://127.0.0.1:1080'
      process.env.no_proxy = 'example.com'
      const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, https_proxy: 'socks5://127.0.0.1:1080', no_proxy: 'example.com' }))
      try {
        // A child that copies `process.env` must receive what the user exported, in the casing they
        // wrote it — never a normalization this process derived (a merged bypass list among others)
        // that other tools cannot parse.
        await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
        expect(process.env.HTTP_PROXY).toBe(proxyUrl)
        expect(process.env.https_proxy).toBe('socks5://127.0.0.1:1080')
        expect(process.env.no_proxy).toBe('example.com')
      } finally {
        await dispose()
      }
    })
  })

  it('restores the dispatcher and the route on disposal', async () => {
    const before = currentDispatcher()
    const { dispose } = await install(proxyAll())
    expect(currentDispatcher()).not.toBe(before)
    expect(proxyRouteFor(new URL(proxyTarget)).proxied).toBe(true)
    await dispose()
    expect(currentDispatcher()).toBe(before)
    expect(proxyRouteFor(new URL(proxyTarget)).proxied).toBe(false)
    await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT')
  })

  it('installs no dispatcher and touches no environment when the user exported none', async () => {
    const before = currentDispatcher()
    process.env.HTTP_PROXY = 'http://untouched.example'
    const { dispose, reported } = await install(env({}))
    try {
      expect(currentDispatcher()).toBe(before)
      expect(process.env.HTTP_PROXY).toBe('http://untouched.example')
      expect(reported).toEqual([])
      expect(proxyRouteFor(new URL(proxyTarget))).toEqual({ proxied: false })
    } finally {
      await dispose()
      delete process.env.HTTP_PROXY
    }
  })

  it('keeps a scheme direct when the policy refused the proxy the user named for it', async () => {
    // What `HTTPS_PROXY=socks5://…` plus `HTTP_PROXY=http://p` resolves to: http proxied, https
    // direct. The route and the reported diagnostic must agree on that split.
    const { dispose } = await install(env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1080' }))
    try {
      // The direct path here fails on a DNS miss whose latency is the machine's resolver to decide;
      // the deadline bounds it. Either rejection proves the same thing — no CONNECT reached the
      // proxy — and a proxied hop would have answered in milliseconds instead.
      await expect(fetch('https://refused-scheme.invalid/', { signal: AbortSignal.timeout(1500) })).rejects.toThrow()
      expect(proxied).toEqual([])
      // The same policy still tunnels http, so the empty expectation above is not vacuous.
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      expect(proxied).toEqual([`GET ${proxyTarget}`])
    } finally {
      await dispose()
    }
  })
})

describe('WebSocket proxy routing and lifecycle', () => {
  it('serves a direct upgrade without a displaced dispatcher and releases ownership after handoff', async () => {
    const previous = currentDispatcher()
    setDispatcher(undefined)
    const { dispose } = await install(proxyAll())
    const dispatcher = currentDispatcher() as Dispatcher
    try {
      await webSocketEcho(originUrl.replace('http:', 'ws:'), async () => {
        await dispose()
        dispatcher.destroy()
      })
      expect(proxied).toEqual([])
    } finally {
      await dispose()
      setDispatcher(previous)
    }
  })

  it.each(['127.0.0.1', 'bypassed.test'])('delegates the direct WebSocket for %s unchanged', async (host) => {
    // Capture Node's real dispatcher so the delegate still exercises a complete WebSocket exchange.
    await fetch(originUrl)
    const previous = currentDispatcher() as Dispatcher
    const seen: DispatchOptions[] = []
    setDispatcher({
      dispatch(options: DispatchOptions, handlers: DispatchHandlers): boolean {
        seen.push(options)
        return previous.dispatch({ ...options, origin: new URL(originUrl).origin }, handlers)
      },
    })
    const { dispose } = await install(proxyAll('bypassed.test'))
    try {
      await webSocketEcho(`ws://${host}:${new URL(originUrl).port}/socket`)
      expect(seen).toHaveLength(1)
      expect(String(seen[0]?.origin)).toContain(host)
      expect(seen[0]?.upgrade).toBe('websocket')
      expect(proxied).toEqual([])
    } finally {
      await dispose()
      setDispatcher(previous)
    }
  })

  it('sends basic proxy credentials only on CONNECT and keeps global fetch working', async () => {
    connectMode = 'tunnel'
    const authenticated = new URL(proxyUrl)
    authenticated.username = 'proxy-user'
    authenticated.password = 'p%40ss'
    const { dispose } = await install(env({ HTTP_PROXY: authenticated.href }))
    try {
      await webSocketEcho(`ws://origin.test:${new URL(originUrl).port}/socket`, dispose)
      expect(connectHeaders[0]?.['proxy-authorization']).toBe(`Basic ${Buffer.from('proxy-user:p@ss').toString('base64')}`)
      expect(upgradeHeaders[0]?.['proxy-authorization']).toBeUndefined()
      expect(upgradeHeaders[0]?.host).toBe(`origin.test:${new URL(originUrl).port}`)
    } finally {
      await dispose()
    }
    const next = await install(proxyAll())
    try {
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
    } finally {
      await next.dispose()
    }
  })

  it('tunnels wss using TLS and the origin server name with certificate verification enabled', async () => {
    connectMode = 'tunnel'
    // The existing certificate names localhost. Adapt only this fixture's identity and trust;
    // tls.connect still performs its real certificate and hostname checks over the CONNECT socket.
    const nativeConnect = tls.connect
    const names: (string | undefined)[] = []
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => {
      names.push(options.servername)
      return nativeConnect({ ...options, ca: certificate, servername: 'localhost' })
    }) as typeof tls.connect)
    syncBuiltinESMExports()
    const { dispose } = await install(proxyAll())
    try {
      await webSocketEcho(secureUrl.replace('https:', 'wss:'))
      expect(names).toEqual(['secure-origin.test'])
      expect(proxied).toEqual([`CONNECT secure-origin.test:${new URL(secureUrl).port}`])
    } finally {
      await dispose()
    }
  })

  it.each(['refuse', 'hangup'] as const)('reports a CONNECT %s exactly once and closes its sockets', async (mode) => {
    connectMode = mode
    const dispatcher = nativeDispatcher()
    const request = dispatchUpgrade(dispatcher, upgradeRequest('http://origin.test'))
    try {
      const error = await request.result
      expect(error).toBeInstanceOf(Error)
      if (mode === 'refuse') expect((error as Error).message).toContain('407')
      await dispatcher.close()
      expect(request.errors).toEqual([error])
      await vi.waitFor(() => { expect(tunneled.size).toBe(0) })
      expect(upgradeHeaders).toEqual([])
    } finally {
      dispatcher.destroy()
      await dispatcher.close()
    }
  })

  it('reports a non-101 origin response once and closes both sides of the tunnel', async () => {
    connectMode = 'tunnel'
    upgradeMode = 'refuse'
    const dispatcher = nativeDispatcher()
    const request = dispatchUpgrade(dispatcher, upgradeRequest(originUrl.replace('127.0.0.1', 'origin.test')))
    try {
      const error = await request.result
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('403')
      await dispatcher.close()
      await vi.waitFor(() => { expect(tunneled.size + upgraded.size).toBe(0) })
      expect(request.errors).toEqual([error])
    } finally {
      dispatcher.destroy()
      await dispatcher.close()
    }
  })

  it('rejects an untrusted wss certificate without delivering an upgrade', async () => {
    connectMode = 'tunnel'
    const dispatcher = nativeDispatcher()
    const request = dispatchUpgrade(dispatcher, upgradeRequest(secureUrl))
    try {
      const error = await request.result
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/certificate/i)
      await dispatcher.close()
      await vi.waitFor(() => { expect(tunneled.size).toBe(0) })
      expect(request.errors).toEqual([error])
      expect(upgradeHeaders).toEqual([])
    } finally {
      dispatcher.destroy()
      await dispatcher.close()
    }
  })

  it.each([
    ['CONNECT', 'callback'], ['CONNECT', 'destroy'],
    ['TLS', 'signal'], ['TLS', 'destroy'],
    ['upgrade', 'callback'], ['upgrade', 'signal'], ['upgrade', 'destroy'],
  ] as const)('cancels during %s via %s, settles close, and releases all sockets', async (phase, cancellation) => {
    connectMode = phase === 'CONNECT' ? 'stall' : phase === 'TLS' ? 'tls-stall' : 'tunnel'
    upgradeMode = 'stall'
    const dispatcher = nativeDispatcher()
    const controller = new AbortController()
    const target = phase === 'TLS' ? secureUrl : originUrl.replace('127.0.0.1', 'origin.test')
    const request = dispatchUpgrade(dispatcher, upgradeRequest(target, { signal: controller.signal }))
    try {
      await vi.waitFor(() => {
        expect(phase === 'TLS' ? tlsStarted : phase === 'upgrade' ? upgradeHeaders.length > 0 : connectHeaders.length > 0).toBe(true)
      })
      let closed = false
      const closing = dispatcher.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      const reason = new Error('cancel-upgrade')
      if (cancellation === 'callback') request.abort(reason)
      else if (cancellation === 'signal') controller.abort(reason)
      else dispatcher.destroy()
      const error = await request.result
      expect(error).toBeInstanceOf(Error)
      if (cancellation !== 'destroy') expect(error).toBe(reason)
      await closing
      expect(closed).toBe(true)
      await vi.waitFor(() => { expect(tunneled.size + upgraded.size).toBe(0) })
      expect(request.errors).toEqual([error])
    } finally {
      dispatcher.destroy()
      await dispatcher.close()
    }
  })

  it('honors an already-aborted signal without contacting the proxy', async () => {
    const dispatcher = nativeDispatcher()
    const reason = new Error('already-aborted')
    const request = dispatchUpgrade(dispatcher, upgradeRequest('http://origin.test', { signal: AbortSignal.abort(reason) }))
    expect(await request.result).toBe(reason)
    await dispatcher.close()
    expect(request.errors).toEqual([reason])
    expect(proxied).toEqual([])
  })

  it('supports flat headers on the native direct upgrade path', async () => {
    const dispatcher = nativeDispatcher()
    const request = dispatchUpgrade(dispatcher, upgradeRequest(originUrl, {
      headers: ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version', '13'],
    }))
    const socket = await request.result
    try {
      expect(socket).not.toBeInstanceOf(Error)
      expect(upgradeHeaders[0]?.['sec-websocket-version']).toBe('13')
      await dispatcher.close()
    } finally {
      if (!(socket instanceof Error)) socket.destroy()
      dispatcher.destroy()
    }
  })

  it.each(['connect', 'upgrade', 'missing-upgrade'] as const)('contains a %s callback failure and releases the handshake', async (failure) => {
    const dispatcher = nativeDispatcher()
    const reason = new Error('callback-failure')
    const errors: Error[] = []
    const result = new Promise<Error>((resolve) => {
      dispatcher.dispatch(upgradeRequest(originUrl), {
        onConnect: () => { if (failure === 'connect') throw reason },
        onHeaders: () => { throw new Error('unexpected response') },
        onData: () => false,
        onComplete: () => { throw new Error('unexpected completion') },
        ...(failure === 'missing-upgrade' ? {} : { onUpgrade: () => { throw reason } }),
        onError: (error) => { errors.push(error); resolve(error) },
      })
    })
    try {
      const error = await result
      if (failure === 'missing-upgrade') expect(error.message).toContain('onUpgrade')
      else expect(error).toBe(reason)
      await dispatcher.close()
      await vi.waitFor(() => { expect(upgraded.size).toBe(0) })
      expect(errors).toEqual([error])
    } finally {
      dispatcher.destroy()
      await dispatcher.close()
    }
  })
})

describe('proxyRouteFor', () => {
  it('answers from one read of the active policy, so a branch and its request agree', async () => {
    const { dispose } = await install(proxyAll())
    const route = proxyRouteFor(new URL(proxyTarget))
    expect(route).toEqual({ proxied: true, proxy: proxyUrl })
    // Disposing the install while a request is in flight: the hop that already left finishes.
    const inFlight = fetch(proxyTarget)
    await dispose()
    await expect((await inFlight).text()).resolves.toBe('VIA-PROXY')
    expect(proxied).toEqual([`GET ${proxyTarget}`])
  })

  it('is direct for a bypassed URL, and direct with nothing installed', async () => {
    const { dispose } = await install(proxyAll('origin.test'))
    try {
      expect(proxyRouteFor(new URL(proxyTarget))).toEqual({ proxied: false })
    } finally {
      await dispose()
    }
    expect(proxyRouteFor(new URL(proxyTarget))).toEqual({ proxied: false })
  })

  it('is direct for a loopback URL under a policy that proxies everything', async () => {
    const { dispose } = await install(proxyAll())
    try {
      expect(proxyRouteFor(new URL(originUrl))).toEqual({ proxied: false })
    } finally {
      await dispose()
    }
  })
})

describe('installing over an existing installation', () => {
  it('clears the dispatcher symbol when the displaced one was Node\'s own default', async () => {
    const previous = currentDispatcher()
    setDispatcher(undefined)
    const outer = await install(proxyAll())
    try {
      const agent = currentDispatcher()
      expect(agent).toBeInstanceOf(ProxyDispatcher)
      const off = await install(env({}))
      try {
        // The proxied install displaced no dispatcher, so the direct window clears the symbol
        // rather than restoring a stale one; Node re-materializes its own default Agent on the
        // next read, which is exactly the fresh-process behavior this window restores.
        expect(currentDispatcher()).not.toBeInstanceOf(ProxyDispatcher)
      } finally {
        await off.dispose()
      }
      expect(currentDispatcher()).toBe(agent)
    } finally {
      await outer.dispose()
      setDispatcher(previous)
    }
  })

  it('stops proxying when the mounted policy proxies nothing', async () => {
    const outer = await install(proxyAll())
    try {
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      const off = await install(env({}))
      try {
        // A direct policy layered over a proxied one must actually stop proxying, not merely report
        // a direct route while the launcher's transport keeps tunnelling. A direct hop needs a host
        // that answers, so this one reaches the real origin rather than the name only the proxy can
        // resolve.
        await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT')
        expect(proxyRouteFor(new URL(proxyTarget))).toEqual({ proxied: false })
      } finally {
        await off.dispose()
      }
      // Disposing the direct policy restores the proxy the launcher installed.
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      expect(proxyRouteFor(new URL(proxyTarget)).proxied).toBe(true)
    } finally {
      await outer.dispose()
    }
  })
})

describe('the user\'s environment across installs', () => {
  it('preserves both casings exactly as the user wrote them through install and disposal', async () => {
    await withCleanProxyEnv(async () => {
      process.env.http_proxy = 'http://before.example'
      process.env.HTTP_PROXY = 'http://before.example'
      const { dispose } = await install(proxyAll())
      try {
        // The policy routes fetch through the proxy while the environment stays the user's own;
        // a child that copies `process.env` never sees a derived value in either casing.
        expect(process.env.http_proxy).toBe('http://before.example')
        expect(process.env.HTTP_PROXY).toBe('http://before.example')
      } finally {
        await dispose()
      }
      expect(process.env.http_proxy).toBe('http://before.example')
      expect(process.env.HTTP_PROXY).toBe('http://before.example')
    })
  })
})

describe('clearedProxyEnv', () => {
  it('names every proxy variable for removal, so a replay reaches its own fixture server', () => {
    const cleared = clearedProxyEnv()
    expect(Object.keys(cleared).sort()).toEqual([...PROXY_ENV_NAMES].sort())
    expect(Object.values(cleared).every(value => value === undefined)).toBe(true)
  })
})
