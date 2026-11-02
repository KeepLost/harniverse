import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('denies every request when no policy is set', async () => {
    const egress = new WorldEgress(undefined)
    const denial = await egress.open('example.com', 443).catch((error: unknown) => error)
    expect(denial).toBeInstanceOf(EgressDeniedError)
    expect((denial as EgressDeniedError).request).toEqual({ host: 'example.com', port: 443 })
  })

  it('denies when the policy declines, after it sees the request', async () => {
    const seen: EgressRequest[] = []
    const egress = new WorldEgress(async (request) => {
      seen.push(request)
      return false
    })
    await expect(egress.open('denied.example', 80)).rejects.toBeInstanceOf(EgressDeniedError)
    expect(seen).toEqual([{ host: 'denied.example', port: 80 }])
  })

  it('dials approved requests and relays bytes in both directions', async () => {
    const socket = recordingSocket()
    const dialed: EgressRequest[] = []
    const egress = new WorldEgress(() => true, {
      connect: async (request) => {
        dialed.push(request)
        return socket
      },
    })
    const handle = await egress.open('approved.example', 8080)
    expect(dialed).toEqual([{ host: 'approved.example', port: 8080 }])
    expect(handle.request).toEqual({ host: 'approved.example', port: 8080 })

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
    const egress = new WorldEgress(() => true, { connect: async () => socket })
    const handle = await egress.open('early.example', 80)
    socket.emitData(Buffer.from('a'))
    socket.emitData(Buffer.from('b'))
    const iterator = handle[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: Buffer.from('a') })
    await expect(iterator.next()).resolves.toMatchObject({ value: Buffer.from('b') })
  })

  it('rejects writes and surface transport errors after close', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress(() => true, { connect: async () => socket })
    const handle = await egress.open('closed.example', 80)
    socket.emitError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    socket.emitClose()
    const iterator = handle[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toBeInstanceOf(EgressConnectError)
    expect(() => { handle.write('late') }).toThrow(/closed/)
  })

  it('maps a refused dial to EgressConnectError with the errno code', async () => {
    const egress = new WorldEgress(() => true, {
      connect: async () => {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
      },
    })
    const failure = egress.open('refused.example', 1).catch((error: unknown) => error)
    await expect(failure).resolves.toBeInstanceOf(EgressConnectError)
    expect((await failure as EgressConnectError).code).toBe('ECONNREFUSED')
  })

  it('times out a dial that never connects', async () => {
    vi.useFakeTimers()
    try {
      const egress = new WorldEgress(() => true, { connect: () => new Promise<EgressSocket>(() => {}) })
      const failure = egress.open('slow.example', 80).catch((error: unknown) => error)
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
    const egress = new WorldEgress(() => true)
    const handle = await egress.open('127.0.0.1', port)
    const iterator = handle[Symbol.asyncIterator]()
    const reply = iterator.next()
    handle.write('ping')
    await expect(reply).resolves.toMatchObject({ value: Buffer.from('echo:ping') })
    await handle.close()
  })

  it('hands a waiting iterator the chunk that arrives late', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress(() => true, { connect: async () => socket })
    const handle = await egress.open('late.example', 80)
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
    const egress = new WorldEgress(() => true, {
      connect: () => rejectWith('plain string rejection'),
    })
    await expect(egress.open('odd.example', 80)).rejects.toMatchObject({ name: 'EgressConnectError' })
  })

  it('closeAll ends live handles and denies further opens', async () => {
    const socket = recordingSocket()
    const egress = new WorldEgress(() => true, { connect: async () => socket })
    const handle = await egress.open('tracked.example', 80)
    await egress.closeAll()
    await expect(handle.closed).resolves.toBeUndefined()
    expect(socket.destroyed).toBe(true)
    await expect(handle.close()).resolves.toBeUndefined()
    await expect(egress.open('after.example', 80)).rejects.toBeInstanceOf(EgressDeniedError)
  })
})
