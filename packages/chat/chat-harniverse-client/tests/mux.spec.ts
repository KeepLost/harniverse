/** Resumable mux: ordered delivery, cursors, duplicate suppression, reconnect, and renewal. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarniverseMux, TOKEN_EXPIRED_CLOSE_CODE, type MuxDelivery, type MuxOptions, type MuxState } from '../src/index.ts'
import { internals } from '../src/internals.ts'
import { FakeHost, sessionEvent, type FakeSocket } from './fixtures/socket.ts'
import { REMOTE_HOST, restoreInternals } from './helpers.ts'

interface Harness {
  host: FakeHost
  mux: HarniverseMux
  delivered: MuxDelivery[]
  states: MuxState[]
  cursors: Array<[string, number]>
  restarts: Array<[string, string]>
}

function harness(options: Partial<MuxOptions> = {}, host = new FakeHost()): Harness {
  internals.createSocket = host.createSocket
  const delivered: MuxDelivery[] = []
  const states: MuxState[] = []
  const cursors: Array<[string, number]> = []
  const restarts: Array<[string, string]> = []
  const mux = new HarniverseMux(host, {
    onFrame: (delivery) => { delivered.push(delivery) },
    onState: (state) => { states.push(state) },
    onCursor: (sessionId, seq) => { cursors.push([sessionId, seq]) },
    onHostRestart: (previous, current) => { restarts.push([previous, current]) },
    ...options,
  })
  return { host, mux, delivered, states, cursors, restarts }
}

/** Start the mux and open its first socket. */
async function open(h: Harness): Promise<FakeSocket> {
  h.mux.start()
  await vi.advanceTimersByTimeAsync(0)
  const socket = h.host.sockets.at(-1)!
  socket.open()
  await vi.advanceTimersByTimeAsync(0)
  return socket
}

const approval = (approvalId: string): unknown => ({ type: 'approval/requested', sessionId: 's1', approvalId, toolName: 'bash' })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  restoreInternals()
})

describe('delivery', () => {
  it('connects with the Bearer header, reports states, and resolves whenOpen', async () => {
    const h = harness()
    const opened = h.mux.whenOpen()
    const socket = await open(h)
    await expect(opened).resolves.toBeUndefined()
    expect(socket.headers).toEqual({ authorization: 'Bearer t1' })
    expect(socket.url.searchParams.has('since')).toBe(false)
    expect(h.states).toEqual(['connecting', 'open'])
    h.mux.close()
  })

  it('delivers consumed frames in order with their rpcId and drops other kinds and malformed messages', async () => {
    const h = harness()
    const socket = await open(h)
    socket.identity({ kind: 'grant', grantId: 'g', grantRevision: 1 })
    socket.frame('r1', sessionEvent('s1', 0))
    socket.frame('r2', { type: 'session/jobs', sessionId: 's1', jobs: [] })
    socket.frame('r3', { type: 'approval/resolved', sessionId: 's1', approvalId: 'a1', outcome: 'rejected' })
    socket.frame('r4', { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: 'Which?' }] })
    socket.frame('r5', { type: 'question/resolved', sessionId: 's1', questionRpcId: 'r4', outcome: 'answered' })
    socket.emit('message', 'not json')
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'server-request', rpcId: 'r6', method: 'events.mux', payload: { type: 'approval/requested', sessionId: 's1' } })))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.delivered.map(delivery => [delivery.rpcId, delivery.frame.type])).toEqual([
      ['r1', 'session/event'], ['r3', 'approval/resolved'], ['r4', 'question/requested'], ['r5', 'question/resolved'],
    ])
    expect(h.host.identities).toEqual([{ kind: 'grant', grantId: 'g', grantRevision: 1 }])
    expect(h.host.warnings).toHaveLength(2)
    h.mux.close()
  })

  it('decodes string, ArrayBuffer, and chunked payloads', async () => {
    const h = harness()
    const socket = await open(h)
    const text = JSON.stringify({ type: 'server-request', rpcId: 'r1', method: 'events.mux', payload: sessionEvent('s1', 0) })
    socket.emit('message', text)
    socket.emit('message', new TextEncoder().encode(JSON.stringify({ type: 'server-request', rpcId: 'r2', method: 'events.mux', payload: sessionEvent('s1', 1) })).buffer)
    const bytes = Buffer.from(JSON.stringify({ type: 'server-request', rpcId: 'r3', method: 'events.mux', payload: sessionEvent('s1', 2) }))
    socket.emit('message', [bytes.subarray(0, 10), bytes.subarray(10)])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.delivered.map(delivery => delivery.rpcId)).toEqual(['r1', 'r2', 'r3'])
    h.mux.close()
  })

  it('tracks per-session cursors, seeds from options, and suppresses replayed sequence numbers', async () => {
    const h = harness({ cursors: { s1: 4 } })
    const socket = await open(h)
    expect(JSON.parse(socket.url.searchParams.get('since')!)).toEqual({ s1: 4 })
    socket.frame('r1', sessionEvent('s1', 4))
    socket.frame('r2', sessionEvent('s1', 5))
    socket.frame('r3', sessionEvent('s2', 0))
    socket.frame('r4', sessionEvent('s1', 5))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.delivered.map(delivery => delivery.rpcId)).toEqual(['r2', 'r3'])
    expect(h.cursors).toEqual([['s1', 5], ['s2', 0]])
    expect(h.mux.resumeCursors).toEqual({ s1: 5, s2: 0 })
    h.mux.close()
  })

  it('delivers a pending approval or question once per rpcId and forgets the oldest ids past the bound', async () => {
    const h = harness()
    const socket = await open(h)
    socket.frame('p1', approval('a1'))
    socket.frame('p1', approval('a1'))
    socket.frame('p2', { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: '?' }] })
    socket.frame('p2', { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: '?' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.delivered.map(delivery => delivery.rpcId)).toEqual(['p1', 'p2'])
    for (let index = 0; index < 2_048; index += 1) socket.frame(`bulk-${String(index)}`, approval(`b${String(index)}`))
    socket.frame('p1', approval('a1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.delivered.filter(delivery => delivery.rpcId === 'p1')).toHaveLength(2)
    h.mux.close()
  })

  it('serializes handlers and survives a rejecting handler', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness({
      onFrame: async ({ rpcId }) => {
        order.push(`start:${rpcId}`)
        if (rpcId === 'r1') await gate
        if (rpcId === 'r2') throw new Error('handler broke')
        order.push(`end:${rpcId}`)
      },
    })
    const socket = await open(h)
    socket.frame('r1', sessionEvent('s1', 0))
    socket.frame('r2', sessionEvent('s1', 1))
    socket.frame('r3', sessionEvent('s1', 2))
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['start:r1'])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['start:r1', 'end:r1', 'start:r2', 'start:r3', 'end:r3'])
    expect(h.host.warnings).toEqual(['frame handler failed for session/event: handler broke'])
    h.mux.close()
  })

  it('binds a remote-host stream to its runtime and ignores the remote identity frame', async () => {
    const h = harness({ remoteHost: REMOTE_HOST })
    const socket = await open(h)
    expect(socket.url.searchParams.get('dshRemoteHost')).toBe(REMOTE_HOST)
    socket.identity({ kind: 'grant', grantId: 'remote', grantRevision: 3 })
    socket.frame('r1', sessionEvent('s1', 0))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.host.identities).toEqual([])
    expect(h.delivered[0]).toMatchObject({ rpcId: 'r1', remoteHost: REMOTE_HOST })
    expect(h.host.described).toEqual([{ remoteHost: REMOTE_HOST }])
    h.mux.close()
  })

  it('warns about a socket error', async () => {
    const h = harness()
    const socket = await open(h)
    socket.emit('error', new Error('ECONNRESET'))
    expect(h.host.warnings).toEqual(['mux socket error: ECONNRESET'])
    h.mux.close()
  })
})

describe('reconnect', () => {
  it('reconnects at once after a token-expiry close and replays from the cursors', async () => {
    const h = harness()
    const first = await open(h)
    first.frame('r1', sessionEvent('s1', 7))
    await vi.advanceTimersByTimeAsync(0)
    first.drop(TOKEN_EXPIRED_CLOSE_CODE)
    expect(h.states.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(0)
    const second = h.host.sockets[1]!
    expect(JSON.parse(second.url.searchParams.get('since')!)).toEqual({ s1: 7 })
    expect(second.headers.authorization).toBe('Bearer t2')
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.states.at(-1)).toBe('open')
    h.mux.close()
  })

  it('backs off exponentially up to the ceiling and resets after an open', async () => {
    const h = harness()
    const first = await open(h)
    first.drop(1006)
    const seen = (): number => h.host.sockets.length
    expect(seen()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(seen()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen()).toBe(2)
    h.host.sockets[1]!.drop(1006)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(seen()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen()).toBe(3)
    h.host.sockets[2]!.drop(1006)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(seen()).toBe(4)
    h.host.sockets[3]!.drop(1006)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(seen()).toBe(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen()).toBe(5)
    h.host.sockets[4]!.open()
    await vi.advanceTimersByTimeAsync(0)
    h.host.sockets[4]!.drop(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen()).toBe(6)
    h.mux.close()
  })

  it('keeps retrying while the Grant cannot authenticate', async () => {
    const host = new FakeHost()
    host.authorizationFailures = 2
    const h = harness({}, host)
    h.mux.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sockets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.sockets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(host.sockets).toHaveLength(1)
    expect(host.warnings).toEqual(['mux connection failed: no token', 'mux connection failed: no token'])
    expect(h.states).toEqual(['connecting'])
    h.mux.close()
  })

  it('retries when the socket cannot even be created', async () => {
    const host = new FakeHost()
    const h = harness({}, host)
    let attempts = 0
    internals.createSocket = (url, headers) => {
      attempts += 1
      if (attempts === 1) throw new Error('bad url')
      return host.createSocket(url, headers)
    }
    h.mux.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.warnings).toEqual(['mux connection failed: bad url'])
    expect(host.sockets).toHaveLength(1)
    h.mux.close()
  })

  it('schedules a retry after a connect that never opens', async () => {
    const h = harness()
    h.mux.start()
    await vi.advanceTimersByTimeAsync(0)
    h.host.sockets[0]!.drop(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.host.sockets).toHaveLength(2)
    expect(h.states).toEqual(['connecting'])
    h.mux.close()
  })

  it('detects a host restart from a changed bootId and tolerates a failed check', async () => {
    const host = new FakeHost()
    host.bootIds = ['boot-1', 'boot-2', new Error('describe down'), 'boot-2']
    const h = harness({}, host)
    const first = await open(h)
    expect(h.restarts).toEqual([])
    first.drop(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    host.sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.restarts).toEqual([['boot-1', 'boot-2']])
    host.sockets[1]!.drop(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    host.sockets[2]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.warnings).toContain('mux host check failed: describe down')
    host.sockets[2]!.drop(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    host.sockets[3]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.restarts).toEqual([['boot-1', 'boot-2']])
    h.mux.close()
  })

  it('works without optional callbacks', async () => {
    const host = new FakeHost()
    host.bootIds = ['a', 'b']
    internals.createSocket = host.createSocket
    const mux = new HarniverseMux(host, { onFrame: () => undefined })
    mux.start()
    await vi.advanceTimersByTimeAsync(0)
    host.sockets[0]!.open().frame('r1', sessionEvent('s1', 0))
    host.sockets[0]!.drop(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    host.sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)
    mux.close()
    expect(host.warnings).toEqual([])
  })
})

describe('renewal', () => {
  it('opens a replacement socket before the token lifetime ends, then closes the old one without reconnecting', async () => {
    const h = harness()
    const first = await open(h)
    first.frame('r1', sessionEvent('s1', 0))
    await vi.advanceTimersByTimeAsync(540_000)
    expect(h.host.sockets).toHaveLength(2)
    const second = h.host.sockets[1]!
    expect(JSON.parse(second.url.searchParams.get('since')!)).toEqual({ s1: 0 })
    expect(first.closeCodes).toEqual([])
    first.frame('r2', sessionEvent('s1', 1))
    await vi.advanceTimersByTimeAsync(0)
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(first.closeCodes).toEqual([1000])
    second.frame('r3', sessionEvent('s1', 1))
    second.frame('r4', sessionEvent('s1', 2))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.delivered.map(delivery => delivery.rpcId)).toEqual(['r1', 'r2', 'r4'])
    expect(h.host.sockets).toHaveLength(2)
    expect(h.states).toEqual(['connecting', 'open', 'open'])
    await vi.advanceTimersByTimeAsync(540_000)
    expect(h.host.sockets).toHaveLength(3)
    h.mux.close()
  })

  it('keeps the old socket when the replacement cannot authenticate and retries later', async () => {
    const h = harness()
    const first = await open(h)
    h.host.authorizationFailures = 1
    await vi.advanceTimersByTimeAsync(540_000)
    expect(h.host.sockets).toHaveLength(1)
    expect(first.closeCodes).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.host.sockets).toHaveLength(2)
    h.host.sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(first.closeCodes).toEqual([1000])
    h.mux.close()
  })

  it('reconnects when the live socket drops while a replacement is still pending', async () => {
    const h = harness()
    const first = await open(h)
    await vi.advanceTimersByTimeAsync(540_000)
    first.drop(1006)
    await vi.advanceTimersByTimeAsync(0)
    h.host.sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.states.at(-1)).toBe('open')
    h.mux.close()
  })
})

describe('lifecycle', () => {
  it('ignores a repeated start and never starts after close', async () => {
    const h = harness()
    h.mux.start()
    h.mux.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.host.sockets).toHaveLength(1)
    h.mux.close()
    h.mux.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.host.sockets).toHaveLength(1)
  })

  it('does not start while a live socket or pending retry exists', async () => {
    const h = harness()
    const first = await open(h)
    h.mux.start()
    expect(h.host.sockets).toHaveLength(1)
    first.drop(1006)
    h.mux.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.host.sockets).toHaveLength(1)
    h.mux.close()
  })

  it('closes the live socket, stops reconnecting, and is idempotent', async () => {
    const h = harness()
    const socket = await open(h)
    h.mux.close()
    h.mux.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.closeCodes).toEqual([1000])
    expect(h.host.sockets).toHaveLength(1)
    expect(h.states.at(-1)).toBe('closed')
  })

  it('cancels a pending retry on close', async () => {
    const h = harness()
    const first = await open(h)
    first.drop(1006)
    h.mux.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.host.sockets).toHaveLength(1)
  })

  it('rejects whenOpen when closed before the first open', async () => {
    const h = harness()
    const opened = h.mux.whenOpen()
    h.mux.start()
    h.mux.close()
    await expect(opened).rejects.toThrow('mux closed before it opened')
  })

  it('closes a socket that finishes connecting after close', async () => {
    const host = new FakeHost()
    const h = harness({}, host)
    h.mux.start()
    await vi.advanceTimersByTimeAsync(0)
    h.mux.close()
    host.sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sockets[0]!.closeCodes).toEqual([1000])
    expect(h.states.at(-1)).toBe('closed')
  })

  it('does not reconnect after close even if an authorization finishes late', async () => {
    const host = new FakeHost()
    let resolveAuthorization!: (value: string) => void
    host.authorization = () => new Promise<string>((resolve) => { resolveAuthorization = resolve })
    const h = harness({}, host)
    h.mux.start()
    await vi.advanceTimersByTimeAsync(0)
    h.mux.close()
    resolveAuthorization('Bearer late')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sockets).toHaveLength(1)
    host.sockets[0]!.drop(1006)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.sockets).toHaveLength(1)
  })

  it('does not schedule a retry when authorization fails after close', async () => {
    const host = new FakeHost()
    let rejectAuthorization!: (error: Error) => void
    host.authorization = () => new Promise<string>((_resolve, reject) => { rejectAuthorization = reject })
    const h = harness({}, host)
    h.mux.start()
    await vi.advanceTimersByTimeAsync(0)
    h.mux.close()
    rejectAuthorization(new Error('revoked'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.sockets).toHaveLength(0)
  })
})
