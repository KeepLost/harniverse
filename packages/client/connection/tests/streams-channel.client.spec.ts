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

async function mount(page = 'page-1'): Promise<ChannelFixture> {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  const opens: ChannelFixture['opens'] = []
  const closes: ChannelFixture['closes'] = []
  const envelopes: ServerRequest[] = []
  const generation = new AbortController()
  const channel = new EntityStreamChannel({
    page,
    channelSignal: generation.signal,
    resolvePath: path => path,
    resolveBase: () => 'http://dsh.internal',
    openControl: payload => new Promise((resolve) => {
      opens.push({ payload, resolve })
    }),
    closeControl: (payload) => { closes.push({ page: payload.page, sub: payload.sub }); return Promise.resolve({}) },
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
    // 256 + 1 frames for a sub whose open never resolves: the pool evicts the oldest parked sub wholesale.
    for (let index = 0; index <= 256; index += 1) {
      socket.receive(downlinkMessage('sub/frame', { type: 'sub/frame', sub: 'sub-parked', frame: { type: 'retained' } }, `p${String(index)}`))
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
