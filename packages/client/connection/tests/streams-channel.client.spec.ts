/**
 * EntityStreamChannel: one lazily-opened page-scoped WebSocket carries every
 * per-entity family as substreams — open POSTs subscribe, frames route by sub
 * id, identity publishes once per sub, unclaimed frames buffer until their
 * open resolves, a dropped socket fails live subs (each consumer's own ladder
 * then reopens), and caller abort fires the idempotent close call.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { holdStreamFrameSchema, terminalStreamFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { EntityStreamChannel } from '../src/client/streams-channel.ts'
import { connectionBudgetSnapshot } from '../src/client/connection-budget.ts'

type WebSocketGlobal = { WebSocket?: typeof WebSocket }

const originalWebSocket = globalThis.WebSocket

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    FakeWebSocket.sockets.push(this)
    if (!FakeWebSocket.opensAutomatically()) return
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

  send(): void { /* downlink-only: the channel never sends */ }

  receive(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }
}

namespace FakeWebSocket {
  export const sockets: FakeWebSocket[] = []
  const flags = { autoOpen: true }
  /** Set false to keep a constructed socket CONNECTING (open-failure scenarios). */
  export function setAutoOpen(value: boolean): void { flags.autoOpen = value }
  export function opensAutomatically(): boolean { return flags.autoOpen }
}

function downlinkMessage(method: string, payload: unknown, rpcId = 'rpc-1'): ServerRequest {
  return { type: 'server-request', rpcId: RpcId(rpcId), method, payload }
}

afterEach(() => {
  FakeWebSocket.sockets.length = 0
  FakeWebSocket.setAutoOpen(true)
  if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
  else globalThis.WebSocket = originalWebSocket
  vi.restoreAllMocks()
})

interface ChannelFixture {
  channel: EntityStreamChannel
  opens: Array<{ payload: unknown; resolve: (value: { sub: string }) => void }>
  closes: Array<{ page: string; sub: string }>
  envelopes: ServerRequest[]
  retire: () => void
}

interface MountOverrides {
  closeControl?: (payload: { page: string; sub: string }) => Promise<unknown>
}

async function mount(page = 'page-1', base = 'http://dsh.internal', over: MountOverrides = {}): Promise<ChannelFixture> {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  const opens: ChannelFixture['opens'] = []
  const closes: ChannelFixture['closes'] = []
  const envelopes: ServerRequest[] = []
  const generation = new AbortController()
  const channel = new EntityStreamChannel({
    page,
    channelSignal: generation.signal,
    resolvePath: path => path,
    resolveBase: () => base,
    openControl: payload => new Promise((resolve) => {
      opens.push({ payload, resolve })
    }),
    closeControl: over.closeControl ?? ((payload) => {
      closes.push({ page: payload.page, sub: payload.sub })
      return Promise.resolve({})
    }),
    onEnvelope: (message) => { envelopes.push(message) },
  })
  return { channel, opens, closes, envelopes, retire: () => { generation.abort() } }
}

describe('entity-stream channel', () => {
  it('multiplexes two families over one socket and routes frames by sub id', async () => {
    const { channel, opens, envelopes } = await mount()
    const terminal = channel.open('terminal', { sessionId: 's', id: 't', attachmentId: 'a' },
      new AbortController().signal, terminalStreamFrameSchema)
    const hold = channel.open('hold', { sessionId: 's', id: 't' },
      new AbortController().signal, holdStreamFrameSchema)
    const terminalStarted = terminal[Symbol.asyncIterator]().next()
    const holdStarted = hold[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(2) })
    expect(opens[0]!.payload).toMatchObject({ page: 'page-1', family: 'terminal' })
    expect(opens[1]!.payload).toMatchObject({ page: 'page-1', family: 'hold' })
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    expect(FakeWebSocket.sockets[0]!.url).toBe('ws://dsh.internal/api/events.streams?page=page-1')
    opens[0]!.resolve({ sub: 'sub-t' })
    opens[1]!.resolve({ sub: 'sub-h' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('connection.authenticated', { kind: 'bypass' }, 'identity'))
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-t' }, 'ready-t'))
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-t', frame: { type: 'output', sequence: 3, data: 'hi' } }, 'out-t'))
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-h', frame: { type: 'retained' } }, 'ret-h'))
    await expect(terminalStarted).resolves.toMatchObject({ value: { payload: { type: 'output', data: 'hi' } } })
    await expect(holdStarted).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    expect(envelopes.length).toBeGreaterThan(0)
    void terminal.return(undefined)
    void hold.return(undefined)
  })

  it('buffers unclaimed frames until the open POST resolves and publishes identity once per sub', async () => {
    const { channel, opens } = await mount()
    const seenOpens: number[] = []
    const identities: unknown[] = []
    const watch = channel.open('files-watch', { workspaceId: 'ws', path: 'src' }, new AbortController().signal,
      holdStreamFrameSchema, () => { seenOpens.push(1) }, (identity) => { identities.push(identity) })
    const started = watch[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    const socket = FakeWebSocket.sockets[0]!
    // Frames land before the open POST resolves: they must wait, in order.
    socket.receive(downlinkMessage('connection.authenticated', { kind: 'bypass' }, 'identity'))
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-w' }, 'ready-w'))
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-w', frame: { type: 'retained' } }, 'ret-w'))
    opens[0]!.resolve({ sub: 'sub-w' })
    await expect(started).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    expect(seenOpens).toEqual([1])
    expect(identities).toEqual([{ kind: 'bypass' }])
    void watch.return(undefined)
  })

  it('fails live subs when the socket drops and ends aborted ones silently', async () => {
    const { channel, opens } = await mount()
    const live = new AbortController()
    const dead = new AbortController()
    const readied: string[] = []
    const liveStream = channel.open('hold', { sessionId: 's', id: 'a' }, live.signal, holdStreamFrameSchema,
      () => { readied.push('live') })
    const deadStream = channel.open('hold', { sessionId: 's', id: 'b' }, dead.signal, holdStreamFrameSchema,
      () => { readied.push('dead') })
    const liveStarted = liveStream[Symbol.asyncIterator]().next()
    const deadStarted = deadStream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(2) })
    opens[0]!.resolve({ sub: 'sub-live' })
    opens[1]!.resolve({ sub: 'sub-dead' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-live' }, 'r1'))
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-dead' }, 'r2'))
    await vi.waitFor(() => { expect(readied).toEqual(['live', 'dead']) })
    dead.abort()
    socket.close()
    await expect(liveStarted).rejects.toThrow('entity-stream downlink closed')
    await expect(deadStarted).resolves.toMatchObject({ done: true })
  })

  it('fires the idempotent close on caller abort, but not after a channel retire', async () => {
    const { channel, opens, closes, retire } = await mount()
    const caller = new AbortController()
    const readied: string[] = []
    const stream = channel.open('terminal', { sessionId: 's', id: 't', attachmentId: 'a' }, caller.signal,
      terminalStreamFrameSchema, () => { readied.push('x') })
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-x' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-x' }, 'rx'))
    await vi.waitFor(() => { expect(readied).toEqual(['x']) })
    caller.abort()
    await expect(started).resolves.toMatchObject({ done: true })
    await vi.waitFor(() => { expect(closes).toEqual([{ page: 'page-1', sub: 'sub-x' }]) })
    retire()
    await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSED) })
    expect(closes).toHaveLength(1)
  })

  it('drops a frame that fails its family schema and keeps the substream', async () => {
    const { channel, opens } = await mount()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const first = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-bad' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-bad', frame: { type: 'not-a-hold-frame' } }, 'bad'))
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-bad', frame: { type: 'retained' } }, 'good'))
    await expect(first).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    expect(consoleError).toHaveBeenCalled()
    void stream.return(undefined)
  })

  it('rejects the open when the socket cannot open, for retry on the next consumer', async () => {
    const { channel, opens } = await mount()
    FakeWebSocket.setAutoOpen(false)
    const before = connectionBudgetSnapshot()
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    // The socket stays CONNECTING and errors before any open event: the
    // attempt must reject and release its budget slot.
    const socket = FakeWebSocket.sockets[0]!
    socket.dispatchEvent(new Event('error'))
    await expect(started).rejects.toThrow('failed to open')
    expect(connectionBudgetSnapshot().websockets).toBe(before.websockets)
    // The failed attempt leaves no half-open state and never reached its open
    // call: the next open retries cleanly as the first recorded control call.
    expect(opens).toHaveLength(0)
    FakeWebSocket.setAutoOpen(true)
    const retry = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const retried = retry[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-retry' })
    const fresh = FakeWebSocket.sockets[1]!
    fresh.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-retry' }, 'rr'))
    fresh.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-retry', frame: { type: 'retained' } }, 'fr'))
    await expect(retried).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    void retry.return(undefined)
  })

  it('drops the oldest parked sub when the unclaimed pool hits its bound', async () => {
    const { channel, opens } = await mount()
    const first = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const firstStarted = first[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    const socket = FakeWebSocket.sockets[0]!
    // Two subs whose opens never resolve: filling the pool evicts the oldest
    // parked sub wholesale while the newer one keeps its buffered frames.
    for (let index = 0; index < 200; index += 1) {
      socket.receive(downlinkMessage('sub/frame', {
        type: 'sub/frame', sub: 'sub-old', frame: { type: 'retained' },
      }, `o${String(index)}`))
    }
    for (let index = 0; index <= 56; index += 1) {
      socket.receive(downlinkMessage('sub/frame', {
        type: 'sub/frame', sub: 'sub-new', frame: { type: 'retained' },
      }, `n${String(index)}`))
    }
    opens[0]!.resolve({ sub: 'sub-claimed' })
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-claimed' }, 'rc'))
    socket.receive(downlinkMessage('sub/end', { type: 'sub/end', sub: 'sub-claimed' }, 'ec'))
    await expect(firstStarted).resolves.toMatchObject({ done: true })
  })

  it('contains an identity observer that throws', async () => {
    const { channel, opens } = await mount()
    const exploding = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema,
      undefined, () => { throw new Error('observer exploded') })
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-id' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('connection.authenticated', { kind: 'bypass' }, 'identity'))
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-id' }, 'ri'))
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-id', frame: { type: 'retained' } }, 'fi'))
    await expect(started).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    expect(exploding).toHaveBeenCalled()
    void stream.return(undefined)
  })

  it('ends a stream immediately when the caller signal is already aborted', async () => {
    const { channel, opens } = await mount()
    const caller = new AbortController()
    caller.abort()
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, caller.signal, holdStreamFrameSchema)
    await expect(stream.next()).resolves.toMatchObject({ done: true })
    expect(opens).toHaveLength(0)
  })

  it('ends a stream immediately when the channel is already retired', async () => {
    const { channel, retire, opens } = await mount()
    retire()
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    await expect(stream.next()).resolves.toMatchObject({ done: true })
    expect(opens).toHaveLength(0)
  })

  it('closes a substream aborted between the open POST and its claim', async () => {
    const { channel, opens, closes } = await mount()
    const caller = new AbortController()
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, caller.signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-mid' })
    caller.abort()
    await expect(started).resolves.toMatchObject({ done: true })
    await vi.waitFor(() => { expect(closes).toEqual([{ page: 'page-1', sub: 'sub-mid' }]) })
  })

  it('drops binary and malformed frames while live, then ignores everything after a retire', async () => {
    const { channel, opens, envelopes, retire } = await mount()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-x' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-x' }, 'rx'))
    await vi.waitFor(() => { expect(envelopes.length).toBeGreaterThanOrEqual(1) })
    // Live binary and malformed frames drop through the diagnostics path...
    socket.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(4) }))
    socket.dispatchEvent(new MessageEvent('message', { data: 'not-json' }))
    socket.receive(downlinkMessage('sub/frame', {
      type: 'sub/frame', sub: 'unknown-sub', frame: { type: 'retained' },
    }, 'orphan'))
    // Binary and unparseable frames each log one drop; the orphan parks silently.
    await vi.waitFor(() => { expect(consoleError).toHaveBeenCalledTimes(2) })
    // The tap sees the ready frame and the orphan frame alike.
    expect(envelopes.length).toBe(2)
    retire()
    // ...and post-retire frames must not reach consumers or the tap at all.
    const seen = envelopes.length
    socket.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(4) }))
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-x', frame: { type: 'retained' } }, 'late'))
    await expect(started).resolves.toMatchObject({ done: true })
    expect(envelopes.length).toBe(seen)
  })

  it('routes frames to a claimed substream through the dispatch wake path', async () => {
    const { channel, opens } = await mount()
    const readied: string[] = []
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema,
      () => { readied.push('wake') })
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-wake' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-wake' }, 'rw'))
    await vi.waitFor(() => { expect(readied).toEqual(['wake']) })
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-wake', frame: { type: 'retained' } }, 'fw'))
    await expect(started).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
  })

  it('reuses the open socket for a later family and contains throwing identity observers', async () => {
    const { channel, opens } = await mount()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const firstStarted = first[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-1st' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-1st' }, 'r1'))
    // A second open after the socket is established returns through the open-state fast path.
    const second = channel.open('terminal', { sessionId: 's', id: 't', attachmentId: 'a' },
      new AbortController().signal, terminalStreamFrameSchema, undefined, () => { throw new Error('observer exploded') })
    const secondStarted = second[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(2) })
    opens[1]!.resolve({ sub: 'sub-2nd' })
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-2nd' }, 'r2'))
    socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-1st', frame: { type: 'retained' } }, 'f1'))
    await expect(firstStarted).resolves.toMatchObject({ value: { payload: { type: 'retained' } } })
    // The identity frame arrives with both substreams registered: the first
    // observes it, the second's throwing observer is contained.
    socket.receive(downlinkMessage('connection.authenticated', { kind: 'bypass' }, 'identity'))
    // A second identity broadcast hits the already-delivered guard per substream.
    socket.receive(downlinkMessage('connection.authenticated', { kind: 'bypass' }, 'identity-2'))
    socket.receive(downlinkMessage('sub/frame', {
      type: 'sub/frame', sub: 'sub-2nd', frame: { type: 'output', sequence: 0, data: 'x' },
    }, 'f2'))
    await expect(secondStarted).resolves.toMatchObject({ value: { payload: { type: 'output' } } })
    expect(consoleError).toHaveBeenCalled()
    void first.return(undefined)
    void second.return(undefined)
  })

  it('fails the open when the channel retires while the socket is still connecting', async () => {
    const { channel, retire } = await mount()
    FakeWebSocket.setAutoOpen(false)
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    retire()
    await expect(started).rejects.toThrow('failed to open')
  })

  it('fails the open when the channel retires right after the socket opened', async () => {
    const { channel, retire } = await mount()
    FakeWebSocket.setAutoOpen(false)
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    const socket = FakeWebSocket.sockets[0]!
    socket.readyState = FakeWebSocket.OPEN
    socket.dispatchEvent(new Event('open'))
    retire()
    await expect(started).rejects.toThrow('retired before opening')
  })

  it('ends a stream without any control POST when the caller aborts while the socket connects', async () => {
    const { channel, opens } = await mount()
    FakeWebSocket.setAutoOpen(false)
    const caller = new AbortController()
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, caller.signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    caller.abort()
    const socket = FakeWebSocket.sockets[0]!
    socket.readyState = FakeWebSocket.OPEN
    socket.dispatchEvent(new Event('open'))
    await expect(started).resolves.toMatchObject({ done: true })
    expect(opens).toHaveLength(0)
  })

  it('maps an https base to a secure WebSocket URL', async () => {
    const { channel, opens } = await mount('page-tls', 'https://dsh.internal')
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-tls' })
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    expect(FakeWebSocket.sockets[0]!.url).toBe('wss://dsh.internal/api/events.streams?page=page-tls')
    void started
    void stream.return(undefined)
  })

  it('fails the consumer when the server ends the substream with an error', async () => {
    const { channel, opens } = await mount()
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-err' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-err' }, 're'))
    socket.receive(downlinkMessage('sub/end', {
      type: 'sub/end', sub: 'sub-err', error: { code: 'internal', message: 'producer died', details: {} },
    }, 'ee'))
    await expect(started).rejects.toThrow('producer died')
  })

  it('tolerates the close event landing after a failed open already settled the socket', async () => {
    const { channel } = await mount()
    const before = connectionBudgetSnapshot().websockets
    FakeWebSocket.setAutoOpen(false)
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(1) })
    const socket = FakeWebSocket.sockets[0]!
    // The error settles the open failure first; the trailing close event then
    // meets an already-closed channel without double-noting the budget.
    socket.dispatchEvent(new Event('error'))
    await expect(started).rejects.toThrow('failed to open')
    socket.dispatchEvent(new Event('close'))
    expect(connectionBudgetSnapshot().websockets).toBe(before)
  })

  it('swallows a failing unsubscribe when the channel already reaped the substream', async () => {
    const { channel, opens, retire } = await mount('page-close-fail', 'http://dsh.internal', {
      closeControl: () => Promise.reject(new Error('channel already gone')),
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema)
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    opens[0]!.resolve({ sub: 'sub-swallow' })
    retire()
    // The retire races the unsubscribe: its rejection must stay contained.
    await expect(started).resolves.toMatchObject({ done: true })
    await vi.waitFor(() => { expect(FakeWebSocket.sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED) })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('counts its socket in the connection budget', async () => {
    const { channel, opens } = await mount()
    const before = connectionBudgetSnapshot()
    const readied: string[] = []
    const stream = channel.open('hold', { sessionId: 's', id: 't' }, new AbortController().signal, holdStreamFrameSchema,
      () => { readied.push('budget') })
    const started = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opens).toHaveLength(1) })
    expect(connectionBudgetSnapshot().websockets).toBe(before.websockets + 1)
    opens[0]!.resolve({ sub: 'sub-budget' })
    const socket = FakeWebSocket.sockets[0]!
    socket.receive(downlinkMessage('sub/ready', { type: 'sub/ready', sub: 'sub-budget' }, 'rb'))
    await vi.waitFor(() => { expect(readied).toEqual(['budget']) })
    socket.close()
    await expect(started).rejects.toThrow('entity-stream downlink closed')
    expect(connectionBudgetSnapshot().websockets).toBe(before.websockets)
  })
})
