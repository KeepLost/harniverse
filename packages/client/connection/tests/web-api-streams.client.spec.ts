/**
 * WebApiClient entity-stream openers over the page-scoped channel: with a
 * page token, all four per-entity families route onto one lazily-opened
 * entity-stream downlink WebSocket, the open/close control POSTs ride the
 * ordinary unary carrier (a refusal rejects the stream), and generation
 * retirement ends the channel. The pageless client keeps the SSE fallback
 * (the target-streams spec owns that half).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebApiClient } from '../src/client/web-api-client.ts'
import { TargetGeneration } from '../src/client/target.ts'
import { RpcId } from '../src/client/api.ts'
import type { ClientAuthentication } from '@deepseek-ai/dsh-client-authentication'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

type WebSocketGlobal = { WebSocket?: typeof WebSocket }

const originalWebSocket = globalThis.WebSocket

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly sockets: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    FakeWebSocket.sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  receive(method: string, payload: unknown, rpcId = 'r-1'): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'server-request', rpcId: RpcId(rpcId), method, payload,
    }) }))
  }
}

type ControlResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: {} } }

interface Fixture {
  api: WebApiClient
  generation: TargetGeneration
  posted: Array<{ method: string; payload: unknown; settle: (result: ControlResult) => void }>
  closes: string[]
  fetch: ReturnType<typeof vi.spyOn>
}

function mountApi(page: string): Fixture {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  FakeWebSocket.sockets.length = 0
  const generation = new TargetGeneration({ kind: 'host' })
  const posted: Fixture['posted'] = []
  const closes: string[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    if (typeof init?.body !== 'string') throw new TypeError('expected JSON body')
    const { rpcId, method, payload } = JSON.parse(init.body) as {
      rpcId: string
      method: string
      payload: unknown
    }
    if (method === 'events.streams.close') {
      closes.push((payload as { sub: string }).sub)
      return Promise.resolve(Response.json({
        type: 'server-response', rpcId, authentication: { kind: 'bypass' }, result: { ok: true, value: {} },
      }))
    }
    return new Promise<Response>((resolve) => {
      posted.push({
        method,
        payload,
        settle: (result) => { resolve(Response.json({ type: 'server-response', rpcId, authentication: { kind: 'bypass' }, result })) },
      })
    })
  })
  const api = new WebApiClient(
    undefined, undefined, undefined, undefined, generation.resolvePath, () => generation, undefined, page,
  )
  return { api, generation, posted, closes, fetch }
}

afterEach(() => {
  FakeWebSocket.sockets.length = 0
  if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
  else globalThis.WebSocket = originalWebSocket
  vi.restoreAllMocks()
})

describe('web api client entity-stream openers', () => {
  it('rides all four families over one downlink socket with control POSTs', async () => {
    const { api, posted, closes } = mountApi('page-a')
    const terminal = api.events.terminal({ sessionId: 's' as never, id: 't' as never, attachmentId: 'a' as never },
      new AbortController().signal)
    const hold = api.events.hold({ sessionId: 's' as never, id: 't' as never }, new AbortController().signal)
    const browser = api.events.browser({ sessionId: 's' as never, id: 'b' as never, attachmentId: 'a' as never },
      new AbortController().signal)
    const watch = api.workspaceFiles.watchFiles({ workspaceId: 'ws' as never }, new AbortController().signal)
    const terminalStarted = terminal[Symbol.asyncIterator]().next()
    const holdStarted = hold[Symbol.asyncIterator]().next()
    const browserStarted = browser[Symbol.asyncIterator]().next()
    const watchStarted = watch[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(posted).toHaveLength(4) })
    expect(new Set(posted.map(call => (call.payload as { family: string }).family)))
      .toEqual(new Set(['terminal', 'hold', 'browser', 'files-watch']))
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    const socket = FakeWebSocket.sockets[0]!
    const families = ['terminal', 'hold', 'browser', 'files-watch'] as const
    for (let index = 0; index < posted.length; index += 1) {
      posted[index]!.settle({ ok: true, value: { sub: `sub-${String(index)}` } })
    }
    socket.receive('connection.authenticated', { kind: 'bypass' }, 'identity')
    const frameFor = (family: (typeof families)[number], index: number): unknown => {
      const sub = `sub-${String(index)}`
      if (family === 'files-watch') return { type: 'sub/frame', sub, frame: { kind: 'ready' } }
      if (family === 'hold') return { type: 'sub/frame', sub, frame: { type: 'retained' } }
      if (family === 'terminal') {
        const info = {
          id: 't', title: 't', shell: { path: '/b', args: [], name: 'b' }, cwd: '/c',
          cols: 8, rows: 2, state: 'running', exitCode: null,
        }
        return { type: 'sub/frame', sub, frame: { type: 'state', info } }
      }
      const info = {
        id: 'b', url: 'u', title: 't', width: 8, height: 8,
        loading: false, state: 'ready', canGoBack: false, canGoForward: false,
      }
      return { type: 'sub/frame', sub, frame: { type: 'state', info } }
    }
    for (let index = 0; index < posted.length; index += 1) {
      socket.receive('sub/ready', { type: 'sub/ready', sub: `sub-${String(index)}` }, `ready-${String(index)}`)
      socket.receive('sub/frame', frameFor(families[index]!, index), `frame-${String(index)}`)
    }
    await expect(terminalStarted).resolves.toMatchObject({ value: { payload: { type: 'state' } } })
    await expect(holdStarted).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    await expect(browserStarted).resolves.toMatchObject({ value: { payload: { type: 'state' } } })
    await expect(watchStarted).resolves.toMatchObject({ value: { payload: { kind: 'ready' } } })
    for (const stream of [terminal, hold, browser, watch] as unknown as Array<AsyncGenerator<RpcRequest<never>>>) {
      void stream.return(undefined)
    }
    await vi.waitFor(() => { expect(closes).toHaveLength(4) })
  })

  it('rides the channel without a machine generation, using the caller signal as-is', async () => {
    const fixture = mountApi('page-bare')
    // A page-scoped client can live outside any target generation; its openers
    // then fall back to the raw caller signal instead of a fenced one.
    fixture.api = new WebApiClient(
      undefined, undefined, undefined, undefined, path => path, undefined, undefined, 'page-bare',
    )
    const stream = fixture.api.events.hold({ sessionId: 's' as never, id: 't' as never }, new AbortController().signal)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(fixture.posted).toHaveLength(1) })
    fixture.posted[0]!.settle({ ok: true, value: { sub: 'sub-bare' } })
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive('sub/ready', { type: 'sub/ready', sub: 'sub-bare' }, 'rb')
    socket.receive('sub/frame', { type: 'sub/frame', sub: 'sub-bare', frame: { type: 'retained' } }, 'fb')
    await expect(started).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    // Every family rides the same generation-less path; their open POSTs each
    // carry the raw caller signal arm.
    type Open = AsyncGenerator<RpcRequest<never>>
    const terminalOpen = fixture.api.events.terminal(
      { sessionId: 's' as never, id: 't' as never, attachmentId: 'a' as never },
      new AbortController().signal,
    ) as unknown as Open
    const browserOpen = fixture.api.events.browser(
      { sessionId: 's' as never, id: 'b' as never, attachmentId: 'a' as never },
      new AbortController().signal,
    ) as unknown as Open
    const watchOpen = fixture.api.workspaceFiles.watchFiles(
      { workspaceId: 'w' as never }, new AbortController().signal,
    ) as unknown as Open
    const rest: Open[] = [terminalOpen, browserOpen, watchOpen]
    const pendings = rest.map(open => open.next())
    await vi.waitFor(() => { expect(fixture.posted).toHaveLength(4) })
    expect(new Set(fixture.posted.map(call => (call.payload as { family: string }).family)))
      .toEqual(new Set(['hold', 'terminal', 'browser', 'files-watch']))
    for (let index = 1; index < 4; index += 1) {
      fixture.posted[index]!.settle({ ok: true, value: { sub: `sub-${String(index)}` } })
    }
    void pendings
    void (stream as unknown as AsyncGenerator<RpcRequest<never>>).return(undefined)
    for (const open of rest) void open.return(undefined)
  })

  it('hands its authentication capability to the channel it opens', async () => {
    const fixture = mountApi('page-auth')
    const ready: AbortSignal[] = []
    const authentication = {
      getSnapshot: () => ({ mode: 'bypass', phase: 'ready', expiresAt: null, reason: null }),
      subscribe: () => () => {},
      ready: (signal?: AbortSignal) => { ready.push(signal ?? new AbortController().signal); return Promise.resolve() },
      check: () => Promise.resolve(),
      requireRefresh: () => {},
      fetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init),
      stop: () => Promise.resolve(),
    } as unknown as ClientAuthentication
    fixture.api = new WebApiClient(
      undefined, undefined, undefined, authentication, path => path, undefined, undefined, 'page-auth',
    )
    const stream = fixture.api.events.hold({ sessionId: 's' as never, id: 't' as never }, new AbortController().signal)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    expect(ready).toHaveLength(1)
    await vi.waitFor(() => { expect(fixture.posted).toHaveLength(1) })
    fixture.posted[0]!.settle({ ok: true, value: { sub: 'sub-auth' } })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive('sub/ready', { type: 'sub/ready', sub: 'sub-auth' }, 'ra')
    socket.receive('sub/frame', { type: 'sub/frame', sub: 'sub-auth', frame: { type: 'retained' } }, 'fa')
    await expect(started).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    void (stream as unknown as AsyncGenerator<RpcRequest<never>>).return(undefined)
  })

  it('rejects the stream when the open control POST refuses', async () => {
    const { api, posted } = mountApi('page-b')
    const stream = api.events.hold({ sessionId: 's' as never, id: 't' as never }, new AbortController().signal)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(posted).toHaveLength(1) })
    // Refuse through the settled envelope: the unary refusal becomes a stream failure.
    posted[0]!.settle({ ok: false, error: { code: 'stream-channel-absent', message: 'page-b holds no live downlink', details: { page: 'page-b' } } })
    await expect(started).rejects.toThrow('events.streams.open refused')
  })

  it('ends the channel with its subs when the machine generation retires', async () => {
    const { api, generation, posted } = mountApi('page-c')
    const readied: string[] = []
    const stream = api.events.hold({ sessionId: 's' as never, id: 't' as never }, new AbortController().signal,
      () => { readied.push('retire-case') })
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(posted).toHaveLength(1) })
    posted[0]!.settle({ ok: true, value: { sub: 'sub-retire' } })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive('sub/ready', { type: 'sub/ready', sub: 'sub-retire' }, 'rr')
    // Retire only after the substream is live: the open POST's unary fence
    // legitimately rejects a retire that lands mid-flight.
    await vi.waitFor(() => { expect(readied).toEqual(['retire-case']) })
    generation.retire()
    await expect(started).resolves.toMatchObject({ done: true })
    await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSED) })
  })
})
