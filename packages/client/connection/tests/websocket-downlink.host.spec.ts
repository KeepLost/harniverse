import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  authenticationGrantId,
  type AuthenticationDecision,
  type AuthenticationPrincipal,
} from '@deepseek-ai/dsh-authentication'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../src/api-path.ts'
import { rejectUnauthorizedWebSocket, rejectWebSocketUpgrade, WebSocketDownlinks } from '../src/websocket-downlink.ts'
import type { RemoteWebSocket } from '../src/websocket-downlink.ts'

type MuxSource = (signal: AbortSignal, request: RpcRequest<unknown>) => AsyncIterable<RpcRequest<MuxFrame>>
type HostSource = (signal: AbortSignal, request: RpcRequest<unknown>) => AsyncIterable<RpcRequest<HostFrame>>

const running: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(close => close()))
})

function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function * idle<F>(signal: AbortSignal): AsyncGenerator<RpcRequest<F>> {
  await untilAbort(signal)
}

function api(mux: MuxSource, host: HostSource): ApiProxy {
  return {
    events: {
      mux: (request, signal) => mux(signal, request),
      host: (request, signal) => host(signal, request),
    },
  } as ApiProxy
}

async function serve(
  downlinks: WebSocketDownlinks,
  principals: { mux?: AuthenticationPrincipal; host?: AuthenticationPrincipal } = {},
): Promise<{
  origin: string
  close: () => Promise<void>
}> {
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    const principal = pathname === MUX_EVENTS_PATH ? principals.mux : principals.host
    const admission: Extract<AuthenticationDecision, { kind: 'accepted' }> = {
      kind: 'accepted',
      principal: principal ?? { kind: 'bypass', capabilities: ALL_AUTHENTICATION_CAPABILITIES },
    }
    if (pathname === MUX_EVENTS_PATH) downlinks.handleMux(request, socket, head, admission)
    else if (pathname === HOST_EVENTS_PATH) downlinks.handleHost(request, socket, head, admission)
    else socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `ws://127.0.0.1:${String(port)}`,
    close: async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

function grant(
  id: string,
  revision = 1,
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
): Extract<AuthenticationPrincipal, { kind: 'grant' }> {
  return {
    kind: 'grant',
    grantId: authenticationGrantId(id),
    grantRevision: revision,
    capabilities: ALL_AUTHENTICATION_CAPABILITIES,
    expiresAt,
  }
}

function readRaw(socket: WebSocket): Promise<ServerRequest> {
  return once(socket, 'message').then(([data]) => JSON.parse(rawText(data)) as ServerRequest)
}

function rawText(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) {
    const chunks: Buffer[] = []
    for (const chunk of data as unknown[]) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('expected WebSocket raw data')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  throw new TypeError('expected WebSocket raw data')
}

function read(socket: WebSocket): Promise<ServerRequest> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(rawText(data)) as ServerRequest
      if (message.method === 'connection.authenticated') return
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
  })
}

async function acceptedSocket(downlinks: WebSocketDownlinks): Promise<WebSocket> {
  const server = (downlinks as unknown as { server: { clients: Set<WebSocket> } }).server
  let accepted: WebSocket | undefined
  await vi.waitFor(() => {
    accepted = server.clients.values().next().value
    expect(accepted).toBeDefined()
  })
  return accepted as WebSocket
}

function remoteSocket(): RemoteWebSocket & EventEmitter {
  return Object.assign(new EventEmitter(), { close: vi.fn() })
}

describe('WebSocket downlinks', () => {
  it('sends stable non-secret authentication identity before business frames', async () => {
    const principal: AuthenticationPrincipal = {
      ...grant('browser-a', 7),
      name: 'Personal laptop',
    }
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const server = await serve(downlinks, { mux: principal })
    running.push(server.close)
    const socket = new WebSocket(`${server.origin}${MUX_EVENTS_PATH}`)

    const first = await readRaw(socket)

    expect(first).toMatchObject({
      type: 'server-request',
      method: 'connection.authenticated',
      payload: { kind: 'grant', grantId: 'browser-a', grantRevision: 7 },
    })
    expect(typeof first.rpcId).toBe('string')
    expect(JSON.stringify(first)).not.toContain('Personal laptop')
    expect(JSON.stringify(first)).not.toContain('harniverse.administer')
    expect(JSON.stringify(first)).not.toContain('expiresAt')
    socket.close()
    await once(socket, 'close')
  })

  it('attaches the authenticated principal to the opened stream request', async () => {
    let opened: RpcRequest<unknown> | undefined
    const downlinks = new WebSocketDownlinks(api(
      (signal, request) => {
        opened = request
        return idle(signal)
      },
      signal => idle(signal),
    ))
    const server = await serve(downlinks)
    running.push(server.close)
    const socket = new WebSocket(`${server.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')

    expect(opened?.principal).toEqual({
      kind: 'bypass',
      capabilities: ALL_AUTHENTICATION_CAPABILITIES,
    })
    socket.close()
    await once(socket, 'close')
  })

  it('closes only sockets authenticated by a revoked Grant revision', async () => {
    const laptop = grant('laptop-id')
    const ci = grant('ci-id')
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const host = await serve(downlinks, { mux: laptop, host: ci })
    running.push(host.close)
    const mux = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const hostSocket = new WebSocket(`${host.origin}${HOST_EVENTS_PATH}`)
    await Promise.all([once(mux, 'open'), once(hostSocket, 'open')])

    const muxClosed = once(mux, 'close')
    downlinks.revoke([{ grantId: authenticationGrantId('laptop-id'), grantRevision: 1 }])
    const [code] = await muxClosed as [number, Buffer]
    expect(code).toBe(4001)
    expect(hostSocket.readyState).toBe(WebSocket.OPEN)
    hostSocket.close()
    await once(hostSocket, 'close')
  })

  it('closes a socket whose Grant was revoked before upgrade registration', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    downlinks.revoke([{ grantId: authenticationGrantId('laptop-id'), grantRevision: 2 }])
    const principals = { mux: grant('laptop-id', 1) }
    const host = await serve(downlinks, principals)
    running.push(host.close)

    const stale = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const [code] = await once(stale, 'close') as [number, Buffer]
    expect(code).toBe(4001)

    principals.mux = grant('laptop-id', 3)
    const current = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(current, 'open')
    current.close()
    await once(current, 'close')
  })

  it('closes an admitted socket when its short-lived principal expires', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const host = await serve(downlinks, { mux: grant('short-lived', 1, new Date(Date.now() + 100).toISOString()) })
    running.push(host.close)

    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const [code, reason] = await once(socket, 'close') as [number, Buffer]
    expect(code).toBe(4001)
    expect(String(reason)).toBe('access expired')
  })

  it('rejects sockets while authentication is unavailable and admits them after recovery', async () => {
    const laptop = grant('laptop-id')
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    downlinks.authenticationUnavailable()
    const host = await serve(downlinks, { mux: laptop })
    running.push(host.close)

    const unavailable = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const [code] = await once(unavailable, 'close') as [number, Buffer]
    expect(code).toBe(1012)

    downlinks.authenticationRecovered()
    const recovered = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(recovered, 'open')
    recovered.close()
    await once(recovered, 'close')
  })

  it('passes validated mux resume cursors into the stream request', async () => {
    let payload: unknown
    const proxy = api(idle, idle)
    proxy.events.mux = (request, signal) => {
      payload = request.payload
      return idle(signal)
    }
    const downlinks = new WebSocketDownlinks(proxy)
    const host = await serve(downlinks)
    running.push(host.close)
    const since = encodeURIComponent(JSON.stringify({ 'session-one': 9 }))
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}?since=${since}`)
    await once(socket, 'open')
    expect(payload).toEqual({ since: { 'session-one': 9 } })
    socket.close()
    await once(socket, 'close')
  })

  it('rejects malformed mux resume cursors before WebSocket negotiation', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}?since=%7B%22session-one%22%3A-2%7D`)
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      socket.once('open', () => { reject(new Error('malformed cursor was upgraded')) })
      socket.once('error', () => undefined)
    })
    expect(status).toBe(400)
  })

  it('carries mux and host over independent downstream sockets and cancels each source on close', async () => {
    let muxAborted = false
    let hostAborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          yield {
            rpcId: RpcId('mux-1'),
            payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 4 },
          }
          await untilAbort(signal)
        } finally {
          muxAborted = true
        }
      },
      async function * (signal) {
        try {
          yield { rpcId: RpcId('host-1'), payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }
          await untilAbort(signal)
        } finally {
          hostAborted = true
        }
      },
    ))
    const host = await serve(downlinks)
    running.push(host.close)

    const mux = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const hostSocket = new WebSocket(`${host.origin}${HOST_EVENTS_PATH}`)
    const muxFrame = read(mux)
    const hostFrame = read(hostSocket)
    expect(await muxFrame).toEqual({
      type: 'server-request',
      rpcId: 'mux-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    })
    expect(await hostFrame).toEqual({
      type: 'server-request',
      rpcId: 'host-1',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })

    const muxClosed = once(mux, 'close')
    const hostClosed = once(hostSocket, 'close')
    mux.close()
    hostSocket.close()
    await Promise.all([muxClosed, hostClosed])
    await vi.waitFor(() => {
      expect(muxAborted).toBe(true)
      expect(hostAborted).toBe(true)
    })
  })

  it('rejects client messages because upstream remains HTTP', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send('upstream payload')
    const [code, reason] = await closed as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('downlink only')
    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })

  it('sends stream/error before closing when a source fails', async () => {
    const reportError = vi.fn()
    const sourceError = new Error('mux source failed')
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        throw sourceError
      },
      idle,
    ), reportError)
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const failure = read(socket)
    const closed = once(socket, 'close')
    expect((await failure).payload).toEqual({
      type: 'stream/error',
      error: { code: 'internal', message: 'event stream failed', details: {} },
    })
    expect(reportError).toHaveBeenCalledWith(sourceError)
    await closed
  })

  it('contains a throwing diagnostic sink and still sends stream/error', async () => {
    const downlinks = new WebSocketDownlinks(api(
      async function * () { throw new Error('source failed') },
      idle,
    ), () => { throw new Error('logger failed') })
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)

    await expect(read(socket)).resolves.toMatchObject({
      payload: { type: 'stream/error', error: { message: 'event stream failed' } },
    })
    await once(socket, 'close')
  })

  it('uses the default diagnostic sink when a host event source fails', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const downlinks = new WebSocketDownlinks(api(
      async function * () { throw new Error('default logger source failure') },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const failure = read(socket)
    await once(socket, 'open')
    await expect(failure).resolves.toMatchObject({ payload: { type: 'stream/error' } })
    await once(socket, 'close')
    expect(diagnostic).toHaveBeenCalled()
    diagnostic.mockRestore()
  })

  it('aborts the source when an accepted socket reports a transport error', async () => {
    let aborted = false
    const laptop = grant('laptop-id')
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks, { mux: laptop })
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    expect((downlinks as unknown as { admissions: Map<WebSocket, AuthenticationDecision> }).admissions.size).toBe(1)
    const closed = once(socket, 'close')
    accepted.emit('error', new Error('transport failed'))
    expect((downlinks as unknown as { admissions: Map<WebSocket, AuthenticationDecision> }).admissions.size).toBe(0)
    await closed
    expect(aborted).toBe(true)
  })

  it('drops a source frame that races after the client has closed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    let sourceSignal: AbortSignal | undefined
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        sourceSignal = signal
        try {
          await gate
          yield {
            rpcId: RpcId('late'),
            payload: { type: 'session/subscribed', sessionId: 'session-late' as never, lastSeq: 0 },
          }
        } finally {
          finish()
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await vi.waitFor(() => { expect(sourceSignal?.aborted).toBe(true) })
    release()
    await finished
  })

  it('contains socket send callback failures and closes the downlink', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        await gate
        yield {
          rpcId: RpcId('send-failure'),
          payload: { type: 'session/subscribed', sessionId: 'session-send' as never, lastSeq: 0 },
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const send = vi.spyOn(accepted, 'send').mockImplementation(((
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void,
    ) => {
      const done = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error?: Error) => void
        : callback
      done?.(new Error('socket send failed'))
    }) as WebSocket['send'])
    const closed = once(socket, 'close')
    release()
    await closed
    expect(send).toHaveBeenCalledTimes(2)
    send.mockRestore()
  })

  it('rejects when its acceptor has already closed', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    await downlinks.close()
    await expect(downlinks.close()).rejects.toThrow('The server is not running')
  })

  it('closes already-open sockets when authentication becomes unavailable', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const host = await serve(downlinks, { mux: grant('laptop-id') })
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')

    // A provider that loses credential freshness must not leave a live
    // downlink carrying frames under a principal it can no longer verify.
    downlinks.authenticationUnavailable()
    const [code, reason] = await once(socket, 'close') as [number, Buffer]
    expect(code).toBe(1012)
    expect(reason.toString('utf8')).toBe('authentication unavailable')
  })

  it('closes a socket whose Grant already expired at upgrade', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    // Already past its expiry when the upgrade arrives: admission must not
    // wait for a timer to notice.
    const host = await serve(downlinks, { mux: grant('stale', 1, new Date(Date.now() - 1_000).toISOString()) })
    running.push(host.close)

    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const [code, reason] = await once(socket, 'close') as [number, Buffer]
    expect(code).toBe(4001)
    expect(reason.toString('utf8')).toBe('access expired')
  })

  it('treats an upgrade with no request target as the channel root', async () => {
    let payload: unknown
    const proxy = api(idle, idle)
    proxy.events.mux = (request, signal) => {
      payload = request.payload
      return idle(signal)
    }
    const downlinks = new WebSocketDownlinks(proxy)
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      // A proxy may forward an upgrade without a request target.
      Object.assign(request, { url: undefined })
      downlinks.handleMux(request, socket, head, {
        kind: 'accepted',
        principal: { kind: 'bypass', capabilities: ALL_AUTHENTICATION_CAPABILITIES },
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })

    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    expect(payload).toEqual({})
    socket.close()
    await once(socket, 'close')
  })

  it('rejects a duplicate mux resume cursor', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}?since=%7B%7D&since=%7B%7D`)
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      socket.once('open', () => { reject(new Error('duplicate cursor was upgraded')) })
      socket.once('error', () => undefined)
    })
    expect(status).toBe(400)
  })

  it('admits a bypass principal without scheduling an expiry', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')

    // A bypass admission carries no expiry, so the socket simply stays open.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
    await once(socket, 'close')
  })

  it('clamps a far-future expiry to the maximum timer delay', async () => {
    // Date.parse of a year-9999 expiry exceeds the platform timer range; the
    // schedule must clamp rather than fire immediately.
    const distant = new Date(8_640_000_000_000_000 - 1).toISOString()
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const host = await serve(downlinks, { mux: grant('long-lived', 1, distant) })
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
    await once(socket, 'close')
  })
})

describe('control frame delivery', () => {
  it('fails the downlink when the socket closes before the identity frame', async () => {
    const failures: unknown[] = []
    const downlinks = new WebSocketDownlinks(api(idle, idle), (error) => { failures.push(error) })
    const host = await serve(downlinks)
    running.push(host.close)
    // A socket the peer dropped between admission and the first control write
    // reports a non-OPEN state, and no frame may be attributed to it.
    const readyState = vi.spyOn(WebSocket.prototype, 'readyState', 'get')
      .mockReturnValue(WebSocket.CLOSING)
    try {
      const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
      await vi.waitFor(() => {
        expect(failures.map(String).join('\n')).toContain('websocket downlink closed before control delivery')
      })
      readyState.mockRestore()
      // The mock also shadowed the client's own handshake state, so end this
      // socket without waiting for a negotiated close.
      socket.on('error', () => {})
      try {
        socket.terminate()
      } catch {
        // The mocked CLOSING state can reject termination before opening.
      }
    } finally {
      readyState.mockRestore()
    }
  })

  it('fails the downlink when the identity frame send reports an error', async () => {
    const failures: unknown[] = []
    const downlinks = new WebSocketDownlinks(api(idle, idle), (error) => { failures.push(error) })
    const host = await serve(downlinks)
    running.push(host.close)
    const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(((
      _data: unknown,
      callback?: (error?: Error) => void,
    ) => { callback?.(new Error('simulated send failure')) }) as typeof WebSocket.prototype.send)
    try {
      const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
      await once(socket, 'open')
      await vi.waitFor(() => {
        expect(failures.map(String).join('\n')).toContain('simulated send failure')
      })
      socket.close()
      await once(socket, 'close')
    } finally {
      sendSpy.mockRestore()
    }
  })
})

describe('rejectWebSocketUpgrade', () => {
  it('answers an untrusted upgrade with a stable refusal', async () => {
    const server = createServer()
    server.on('upgrade', (_request, socket) => { rejectWebSocketUpgrade(socket) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
      const answer = await new Promise<string>((resolve, reject) => {
        socket.once('unexpected-response', (_request, response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
          response.on('end', () => {
            resolve(`${String(response.statusCode)}|${Buffer.concat(chunks).toString('utf8')}`)
          })
        })
        socket.once('open', () => { reject(new Error('an untrusted upgrade was accepted')) })
        socket.once('error', () => undefined)
      })
      expect(answer).toBe('403|forbidden')
    } finally {
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
  })
})

describe('rejectUnauthorizedWebSocket', () => {
  /** Capture the raw HTTP response an upgrade rejection writes. */
  async function rejection(decision: Extract<AuthenticationDecision, { kind: 'rejected' }>): Promise<string> {
    const server = createServer()
    server.on('upgrade', (_request, socket) => { rejectUnauthorizedWebSocket(socket, decision) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
      return await new Promise<string>((resolve, reject) => {
        socket.once('unexpected-response', (_request, response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
          response.on('end', () => {
            resolve([
              String(response.statusCode),
              response.headers['retry-after'] ?? '-',
              response.headers['www-authenticate'] ?? '-',
              Buffer.concat(chunks).toString('utf8'),
            ].join('|'))
          })
        })
        socket.once('open', () => { reject(new Error('a rejection was upgraded')) })
        socket.once('error', () => undefined)
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
  }

  it('answers a rate-limited upgrade with a retry interval in whole seconds', async () => {
    expect(await rejection({ kind: 'rejected', reason: 'rate-limited', retryAfterMs: 1_500 }))
      .toBe('429|2|-|rate limited')
  })

  it.each([
    'invalid-credential',
    'missing-credential',
    'authentication-unavailable',
  ] as const)('answers a %s upgrade with a stable challenge', async (reason) => {
    expect(await rejection({ kind: 'rejected', reason }))
      .toBe('401|-|Bearer realm="dsh"|unauthorized')
  })

  it('waits for source cleanup before teardown resolves', async () => {
    let cleanupStarted!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    let cleaned = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          cleanupStarted()
          await cleanupGate
          cleaned = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    let closed = false
    const closing = host.close().then(() => { closed = true })
    try {
      await started
      expect(closed).toBe(false)
      releaseCleanup()
      await closing
      expect(cleaned).toBe(true)
    } finally {
      releaseCleanup()
      await closing
    }
  })

  it('bridges authenticated remote frames, rewrites remote identity, and rejects client uplink', async () => {
    const principal = grant('local-owner', 4, new Date(8_640_000_000_000_000 - 1).toISOString())
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const upstream = remoteSocket()
    let upstreamClosed = false
    const closeUpstream = vi.fn(() => {
      if (upstreamClosed) return
      upstreamClosed = true
      queueMicrotask(() => { upstream.emit('close') })
    })
    upstream.close = closeUpstream
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal }, async () => upstream)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })

    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const bounded = async <T>(stage: string, promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new Error(`remote bridge test timed out at ${stage}`)) }, 1_000)
        })])
      } finally { if (timer !== undefined) clearTimeout(timer) }
    }
    const authFrame = readRaw(socket)
    await bounded('client-open', once(socket, 'open').then(() => undefined))
    const authenticated = await bounded('local-auth-frame', authFrame)
    expect(authenticated.method).toBe('connection.authenticated')
    await bounded('upstream-listener', vi.waitFor(() => { expect(upstream.listenerCount('message')).toBe(1) }))
    upstream.emit('message', JSON.stringify({ method: 'connection.authenticated', payload: { kind: 'grant', grantId: 'remote-id' } }))
    expect(await bounded('rewritten-auth-frame', readRaw(socket))).toMatchObject({
      method: 'connection.authenticated',
      payload: { kind: 'grant', grantId: 'local-owner', grantRevision: 4 },
    })
    upstream.emit('message', Buffer.from(JSON.stringify({ method: 'host/remote-event', payload: { event: 'commands/change' } })))
    expect(await bounded('remote-business-frame', readRaw(socket))).toMatchObject({ method: 'host/remote-event', payload: { event: 'commands/change' } })
    const closed = once(socket, 'close')
    socket.send('forbidden uplink')
    const [code, reason] = await bounded('client-uplink-close', closed) as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('downlink only')
    expect(closeUpstream).toHaveBeenCalled()
  })

  it.each([
    ['binary', new ArrayBuffer(2)],
    ['malformed', '{broken'],
  ] as const)('rejects %s frames from a remote upstream', async (_label, frame) => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const upstream = remoteSocket()
    upstream.close = vi.fn(() => { queueMicrotask(() => { upstream.emit('close') }) })
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal: grant('local-owner') }, async () => upstream)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const auth = readRaw(socket)
    await once(socket, 'open')
    await auth
    await vi.waitFor(() => { expect(upstream.listenerCount('message')).toBe(1) })
    const closed = once(socket, 'close')
    upstream.emit('message', frame)
    const [code] = await closed as [number, Buffer]
    expect(code).toBe(1003)
  })

  it('closes a remote downlink when its upstream cannot be opened', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal: grant('local-owner') }, async () => {
        throw new Error('upstream unavailable')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const identity = readRaw(socket)
    await once(socket, 'open')
    await identity
    const [code] = await once(socket, 'close') as [number, Buffer]
    expect(code).toBe(1011)
  })

  it('does not report an upstream failure after the downstream has already aborted', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const opening = Promise.withResolvers<RemoteWebSocket>()
    let openingSignal: AbortSignal | undefined
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal: grant('local-owner') }, (signal) => {
        openingSignal = signal
        return opening.promise
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const identity = readRaw(socket)
    await once(socket, 'open')
    await identity
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await vi.waitFor(() => { expect(openingSignal?.aborted).toBe(true) })
    opening.reject(new Error('upstream failed after abort'))
    await Promise.resolve()
  })

  it('removes a rejected remote pump after upstream cleanup throws', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const upstream = remoteSocket()
    upstream.close = vi.fn(() => { throw new Error('upstream close failed') })
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal: grant('local-owner') }, async () => upstream)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })

    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const identity = readRaw(socket)
    await once(socket, 'open')
    await identity
    await vi.waitFor(() => { expect(upstream.listenerCount('close')).toBeGreaterThan(0) })
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await vi.waitFor(() => { expect((downlinks as unknown as { pumps: Set<Promise<void>> }).pumps.size).toBe(0) })
    const closeUpstream = Reflect.get(upstream, 'close') as ReturnType<typeof vi.fn>
    expect(closeUpstream).toHaveBeenCalledOnce()
  })

  it.each(['unavailable', 'revoked', 'expired'] as const)('rejects a remote upgrade that is %s at admission', async (state) => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const principal = state === 'expired'
      ? grant('local-owner', 1, new Date(Date.now() - 1_000).toISOString())
      : grant('local-owner')
    if (state === 'unavailable') downlinks.authenticationUnavailable()
    if (state === 'revoked') downlinks.revoke([{ grantId: authenticationGrantId('local-owner'), grantRevision: 1 }])
    const open = vi.fn(async () => remoteSocket())
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal }, open)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const [code] = await once(socket, 'close') as [number, Buffer]
    expect(code).toBe(4001)
    expect(open).not.toHaveBeenCalled()
  })

  it('expires an admitted remote grant and closes its upstream', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const principal = grant('short-remote', 1, new Date(Date.now() + 500).toISOString())
    const upstream = remoteSocket()
    const closeUpstream = vi.fn(() => { queueMicrotask(() => { upstream.emit('close') }) })
    upstream.close = closeUpstream
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal }, async () => upstream)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const identity = readRaw(socket)
    await once(socket, 'open')
    await identity
    const [code, reason] = await once(socket, 'close') as [number, Buffer]
    expect(code).toBe(4001)
    expect(String(reason)).toBe('access expired')
    await vi.waitFor(() => { expect(closeUpstream).toHaveBeenCalled() })
  })

  it('closes the remote link when downstream frame delivery fails', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const upstream = remoteSocket()
    upstream.close = vi.fn(() => { queueMicrotask(() => { upstream.emit('close') }) })
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal: grant('local-owner') }, async () => upstream)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const identity = readRaw(socket)
    await once(socket, 'open')
    await identity
    await vi.waitFor(() => { expect(upstream.listenerCount('message')).toBe(1) })
    const accepted = await acceptedSocket(downlinks)
    vi.spyOn(accepted, 'send').mockImplementation(((
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void,
    ) => {
      const done = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error?: Error) => void
        : callback
      done?.(new Error('remote send failed'))
    }) as WebSocket['send'])
    const closed = once(socket, 'close')
    upstream.emit('message', JSON.stringify({ method: 'host/remote-event', payload: {} }))
    const [code] = await closed as [number, Buffer]
    expect(code).toBeGreaterThan(1000)
  })

  it('supports a non-expiring bypass identity on a remote stream', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const upstream = remoteSocket()
    upstream.close = vi.fn(() => { queueMicrotask(() => { upstream.emit('close') }) })
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal: { kind: 'bypass', capabilities: ALL_AUTHENTICATION_CAPABILITIES } }, async () => upstream)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const identity = readRaw(socket)
    await once(socket, 'open')
    expect(await identity).toMatchObject({ method: 'connection.authenticated', payload: { kind: 'bypass' } })
    const closed = once(socket, 'close')
    socket.close()
    await closed
  })

  it('contains a remote frame racing after the downstream socket closes', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const upstream = remoteSocket()
    upstream.close = vi.fn(() => { queueMicrotask(() => { upstream.emit('close') }) })
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      downlinks.handleRemote(request, socket, head, { kind: 'accepted', principal: grant('local-owner') }, async () => upstream)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    running.push(async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
    const identity = readRaw(socket)
    await once(socket, 'open')
    await identity
    await vi.waitFor(() => { expect(upstream.listenerCount('message')).toBe(1) })
    const accepted = await acceptedSocket(downlinks)
    const closed = once(socket, 'close')
    accepted.close()
    upstream.emit('message', JSON.stringify({ method: 'host/remote-event', payload: {} }))
    await closed
    const closeUpstream = Reflect.get(upstream, 'close') as ReturnType<typeof vi.fn>
    await vi.waitFor(() => { expect(closeUpstream).toHaveBeenCalled() })
  })
})
