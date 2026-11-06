import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuestEgressBridge, type EgressHostFrame } from '../src/egress-bridge.ts'
import {
  DEFAULT_EGRESS_CONNECT_TIMEOUT_MS,
  EgressConnectError,
  EgressDeniedError,
  WorldEgress,
  type EgressRequest,
  type EgressSocket,
} from '../src/egress.ts'

/** Deterministic socket whose events tests fire by hand. */
interface FakeEgressSocket extends EgressSocket {
  written: (Uint8Array | string)[]
  destroyed: boolean
  emitData(chunk: Buffer): void
  emitError(error: Error): void
  emitClose(): void
}

function recordingSocket(): FakeEgressSocket {
  const listeners: Record<string, Array<(argument: never) => void>> = {}
  const written: (Uint8Array | string)[] = []
  const destroyed = { flag: false }
  const fire = (event: string, argument: unknown): void => {
    for (const listener of [...listeners[event] ?? []]) listener(argument as never)
  }
  return {
    written,
    get destroyed() { return destroyed.flag },
    write: (data) => {
      written.push(data)
      return true
    },
    destroy: () => {
      destroyed.flag = true
      fire('close', false)
    },
    on: (event: string, listener: (argument: never) => void) => {
      (listeners[event] ??= []).push(listener)
    },
    emitData: (chunk) => { fire('data', chunk) },
    emitError: (error) => { fire('error', error) },
    emitClose: () => { fire('close', false) },
  }
}

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('vm-qemu-local egress relay approval gate', () => {
  it('denies every request when no origin approval source is registered', async () => {
    const egress = new WorldEgress('ask')
    const denial = await egress.open('example.com', 443).catch((error: unknown) => error)
    expect(denial).toBeInstanceOf(EgressDeniedError)
    expect((denial as EgressDeniedError).request).toEqual({ host: 'example.com', port: 443 })
  })

  it('denies when the policy declines, after it sees the request', async () => {
    const seen: EgressRequest[] = []
    const egress = new WorldEgress('ask')
    egress.register('origin-1', async (request) => {
      seen.push(request)
      return false
    })
    await expect(egress.open('denied.example', 80, 'origin-1')).rejects.toBeInstanceOf(EgressDeniedError)
    expect(seen).toEqual([{ host: 'denied.example', port: 80, origin: 'origin-1' }])
  })

  it('dials approved requests and relays bytes in both directions', async () => {
    const socket = recordingSocket()
    const dialed: EgressRequest[] = []
    const egress = new WorldEgress('ask', {
      connect: async (request) => {
        dialed.push(request)
        return socket
      },
    })
    egress.register('origin-2', () => true)
    const handle = await egress.open('approved.example', 8080, 'origin-2')
    expect(dialed).toEqual([{ host: 'approved.example', port: 8080, origin: 'origin-2' }])
    expect(handle.request).toEqual({ host: 'approved.example', port: 8080, origin: 'origin-2' })

    const firstChunk = Buffer.from('pong-1')
    socket.emitData(firstChunk)
    handle.write('ping')
    expect(socket.written).toEqual(['ping'])

    const iterator = handle[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: firstChunk, done: false })
    socket.emitClose()
    await expect(handle.closed).resolves.toBeUndefined()
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('queues chunks that arrive before the iterator asks', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('o', () => true)
    const handle = await egress.open('early.example', 80, 'o')
    socket.emitData(Buffer.from('a'))
    socket.emitData(Buffer.from('b'))
    const iterator = handle[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: Buffer.from('a') })
    await expect(iterator.next()).resolves.toMatchObject({ value: Buffer.from('b') })
  })

  it('rejects writes and surface transport errors after close', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('o', () => true)
    const handle = await egress.open('closed.example', 80, 'o')
    socket.emitError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    socket.emitClose()
    const iterator = handle[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toBeInstanceOf(EgressConnectError)
    expect(() => { handle.write('late') }).toThrow(/closed/)
  })

  it('maps a refused dial to EgressConnectError with the errno code', async () => {
    const egress = new WorldEgress('ask', {
      connect: async () => {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
      },
    })
    egress.register('o', () => true)
    const failure = egress.open('refused.example', 1, 'o').catch((error: unknown) => error)
    await expect(failure).resolves.toBeInstanceOf(EgressConnectError)
    expect((await failure as EgressConnectError).code).toBe('ECONNREFUSED')
  })

  it('times out a dial that never connects', async () => {
    vi.useFakeTimers()
    try {
      const egress = new WorldEgress('ask', { connect: () => new Promise<EgressSocket>(() => {}) })
      egress.register('o', () => true)
      const failure = egress.open('slow.example', 80, 'o').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(DEFAULT_EGRESS_CONNECT_TIMEOUT_MS + 1)
      await expect(failure).resolves.toMatchObject({ name: 'EgressConnectError', code: 'EGRESS_CONNECT_TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('relays through the real dialer against a local mock TCP server', async () => {
    const server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => { socket.write(Buffer.concat([Buffer.from('echo:'), chunk])) })
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as { port: number }).port
    const egress = new WorldEgress('ask')
    egress.register('o', () => true)
    const handle = await egress.open('127.0.0.1', port, 'o')
    const iterator = handle[Symbol.asyncIterator]()
    const reply = iterator.next()
    handle.write('ping')
    await expect(reply).resolves.toMatchObject({ value: Buffer.from('echo:ping') })
    await handle.close()
  })

  it('hands a waiting iterator the chunk that arrives late', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('o', () => true)
    const handle = await egress.open('late.example', 80, 'o')
    const iterator = handle[Symbol.asyncIterator]()
    const pending = iterator.next()
    socket.emitData(Buffer.from('late'))
    await expect(pending).resolves.toMatchObject({ value: Buffer.from('late') })
    await handle.close()
  })

  it('wraps a non-Error dial rejection', async () => {
    // Foreign connect implementations may reject with anything; route one
    // non-Error reason through an untyped helper to prove the wrap.
    const rejectWith = async (value: unknown): Promise<EgressSocket> => {
      throw value
    }
    const egress = new WorldEgress('ask', {
      connect: () => rejectWith('plain string rejection'),
    })
    egress.register('o', () => true)
    await expect(egress.open('odd.example', 80, 'o')).rejects.toMatchObject({ name: 'EgressConnectError' })
  })

  it('maps a refused real dial through the default connect error path', async () => {
    const egress = new WorldEgress('ask')
    egress.register('o', () => true)
    // Port 1 on loopback is never listening; the errno varies by platform but
    // the default dialer's error callback is what this leg pins.
    await expect(egress.open('127.0.0.1', 1, 'o')).rejects.toMatchObject({ name: 'EgressConnectError' })
  })

  it('keeps every dial denied in deny mode even with a registered approver', async () => {
    const egress = new WorldEgress('deny')
    egress.register('origin-3', () => true)
    await expect(egress.open('sealed.example', 80, 'origin-3')).rejects.toBeInstanceOf(EgressDeniedError)
  })

  it('denies an unattributed dial even in ask mode with approvers registered', async () => {
    const egress = new WorldEgress('ask')
    egress.register('origin-4', () => true)
    const denial = await egress.open('no-origin.example', 80).catch((error: unknown) => error)
    expect(denial).toBeInstanceOf(EgressDeniedError)
    expect((denial as EgressDeniedError).request).toEqual({ host: 'no-origin.example', port: 80 })
  })

  it('denies a dial whose origin was never registered', async () => {
    const egress = new WorldEgress('ask')
    await expect(egress.open('unknown.example', 80, 'absent')).rejects.toBeInstanceOf(EgressDeniedError)
  })

  it('denies when the approver itself throws', async () => {
    const egress = new WorldEgress('ask')
    egress.register('origin-5', () => { throw new Error('approval channel unavailable') })
    await expect(egress.open('broken.example', 80, 'origin-5')).rejects.toBeInstanceOf(EgressDeniedError)
  })

  it('forgets the approver once the origin disposer runs', async () => {
    const egress = new WorldEgress('ask')
    const unbind = egress.register('origin-6', () => true)
    unbind()
    await expect(egress.open('gone.example', 80, 'origin-6')).rejects.toBeInstanceOf(EgressDeniedError)
  })

  it('keeps a re-registered origin bound when an earlier disposer runs', async () => {
    const egress = new WorldEgress('ask')
    const first = egress.register('origin-7', () => true)
    egress.register('origin-7', () => true)
    first()
    const socket = recordingSocket()
    const deps = { connect: async () => socket }
    const bound = new WorldEgress('ask', deps)
    bound.register('origin-7', () => true)
    await expect(bound.open('kept.example', 80, 'origin-7')).resolves.toBeDefined()
  })

  it('closeAll ends live handles and denies further opens', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('o', () => true)
    const handle = await egress.open('tracked.example', 80, 'o')
    await egress.closeAll()
    await expect(handle.closed).resolves.toBeUndefined()
    expect(socket.destroyed).toBe(true)
    await expect(handle.close()).resolves.toBeUndefined()
    await expect(egress.open('after.example', 80, 'o')).rejects.toBeInstanceOf(EgressDeniedError)
  })
})

/** Scripted transport capturing host frames; tests emit guest payloads by hand. */
interface FakeTransport {
  sent: EgressHostFrame[]
  emit(payload: string): void
  unsubscribe: () => void
}

function fakeTransport(relay: { open: WorldEgress['open'] }): { bridge: GuestEgressBridge; transport: FakeTransport } {
  const sent: EgressHostFrame[] = []
  const handlers: ((payload: string) => void)[] = []
  const transport: FakeTransport = {
    sent,
    emit: (payload) => { for (const handler of [...handlers]) handler(payload) },
    unsubscribe: () => { handlers.length = 0 },
  }
  const bridge = new GuestEgressBridge(relay, {
    send: (message) => { sent.push(message) },
    onEvent: (match, handler) => {
      const wrapped = (payload: string): void => { if (match(payload)) handler(payload) }
      handlers.push(wrapped)
      return () => { const index = handlers.indexOf(wrapped); if (index >= 0) handlers.splice(index, 1) }
    },
  })
  void transport
  return { bridge, transport }
}

const egressOpenFrame = (id: number, host: string, port: number, origin?: string): string =>
  JSON.stringify({ t: 'egress.open', id, host, port, ...(origin === undefined ? {} : { origin }) })

describe('vm-qemu-local guest egress bridge', () => {
  it('answers an approved open with opened and relays payload chunks both ways', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('origin-b', () => true)
    const { bridge, transport } = fakeTransport(egress)
    transport.emit(egressOpenFrame(7, 'bridged.example', 80, 'origin-b'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(transport.sent[0]).toEqual({ t: 'egress.opened', id: 7 })
    transport.emit(JSON.stringify({ t: 'egress.write', id: 7, d: Buffer.from('ping').toString('base64') }))
    expect(socket.written).toEqual([Buffer.from('ping')])
    socket.emitData(Buffer.from('pong'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(transport.sent[1]).toEqual({ t: 'egress.data', id: 7, d: Buffer.from('pong').toString('base64') })
    socket.emitClose()
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(transport.sent[2]).toEqual({ t: 'egress.end', id: 7 })
    await bridge.dispose()
  })

  it('answers a denied open with denied', async () => {
    const egress = new WorldEgress('ask')
    const { bridge, transport } = fakeTransport(egress)
    transport.emit(egressOpenFrame(9, 'denied.example', 80, 'absent'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(transport.sent).toEqual([{ t: 'egress.denied', id: 9, code: 'denied' }])
    await bridge.dispose()
  })

  it('ignores a duplicate open for a live stream id', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('origin-c', () => true)
    const { bridge, transport } = fakeTransport(egress)
    transport.emit(egressOpenFrame(3, 'dup.example', 80, 'origin-c'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    transport.emit(egressOpenFrame(3, 'dup.example', 80, 'origin-c'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(transport.sent.filter(message => message.t === 'egress.opened')).toEqual([{ t: 'egress.opened', id: 3 }])
    await bridge.dispose()
  })

  it('closes the relayed handle without answering when disposal races the dial', async () => {
    let release: ((socket: FakeEgressSocket) => void) | undefined
    const egress = new WorldEgress('ask', {
      connect: () => new Promise<EgressSocket>((resolve) => { release = (socket) => { resolve(socket) } }),
    })
    egress.register('origin-e', () => true)
    const { bridge, transport } = fakeTransport(egress)
    transport.emit(egressOpenFrame(11, 'raced.example', 80, 'origin-e'))
    await bridge.dispose()
    const socket = recordingSocket()
    release?.(socket)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(socket.destroyed).toBe(true)
    expect(transport.sent.some(message => message.t === 'egress.opened' && message.id === 11)).toBe(false)
  })

  it('answers egress.close when the inbound pump hits a transport error', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('origin-f', () => true)
    const { bridge, transport } = fakeTransport(egress)
    transport.emit(egressOpenFrame(12, 'broken.example', 80, 'origin-f'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    socket.emitError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    socket.emitClose()
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(transport.sent.some(message => message.t === 'egress.close' && message.id === 12)).toBe(true)
    await bridge.dispose()
  })

  it('closes the stream when a guest write lands on a dead relay handle', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('origin-g', () => true)
    const { bridge, transport } = fakeTransport(egress)
    transport.emit(egressOpenFrame(13, 'dead.example', 80, 'origin-g'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    // Error without close: the handle refuses writes while the pump still waits.
    socket.emitError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    transport.emit(JSON.stringify({ t: 'egress.write', id: 13, d: Buffer.from('late').toString('base64') }))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    socket.emitClose()
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(socket.written).toEqual([])
    await bridge.dispose()
  })

  it('ignores payloads the bridge cannot parse and non-egress events', async () => {
    const egress = new WorldEgress('ask')
    const { bridge, transport } = fakeTransport(egress)
    transport.emit('not json at all')
    transport.emit(JSON.stringify({ t: 'pong', n: 1 }))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(transport.sent).toEqual([])
    await bridge.dispose()
  })

  it('closes the relay handle on a guest close and stops routing after dispose', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress('ask', { connect: async () => socket })
    egress.register('origin-d', () => true)
    const { bridge, transport } = fakeTransport(egress)
    transport.emit(egressOpenFrame(5, 'gone.example', 80, 'origin-d'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    transport.emit(JSON.stringify({ t: 'egress.close', id: 5 }))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(socket.destroyed).toBe(true)
    await bridge.dispose()
    transport.emit(egressOpenFrame(6, 'late.example', 80, 'origin-d'))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(transport.sent.some(message => message.t === 'egress.opened' && message.id === 6)).toBe(false)
  })
})
