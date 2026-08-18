import { once } from 'node:events'
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
import { WebSocketDownlinks } from '../src/websocket-downlink.ts'

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

function grant(id: string, revision = 1, expiresAt = new Date(Date.now() + 60_000).toISOString()): AuthenticationPrincipal {
  return {
    kind: 'grant',
    grantId: authenticationGrantId(id),
    grantRevision: revision,
    capabilities: ALL_AUTHENTICATION_CAPABILITIES,
    expiresAt,
  }
}

function read(socket: WebSocket): Promise<ServerRequest> {
  return once(socket, 'message').then(([data]) => JSON.parse(String(data)) as ServerRequest)
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

describe('WebSocket downlinks', () => {
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
})
