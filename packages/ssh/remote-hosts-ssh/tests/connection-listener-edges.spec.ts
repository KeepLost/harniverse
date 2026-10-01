import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const netState = vi.hoisted(() => ({
  server: undefined as unknown,
  onConnection: undefined as unknown,
}))

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  return {
    ...actual,
    createServer: (onConnection: (socket: unknown) => void) => {
      netState.onConnection = onConnection
      return netState.server
    },
  }
})

import { SshTransport } from '../src/connection.ts'
import type { Config } from '../src/types.ts'

const limits: Required<Config> = {
  connectTimeoutMs: 100,
  operationTimeoutMs: 100,
  maxOutputBytes: 32,
  maxReadBytes: 32,
}

class FakeServer extends EventEmitter {
  listening!: () => void
  closed = false
  constructor(private readonly value: unknown = { address: '127.0.0.1', family: 'IPv4', port: 45678 }) { super() }
  listen(_options: unknown, callback: () => void): void { this.listening = callback }
  address(): unknown { return this.value }
  close(callback: () => void): void { this.closed = true; callback() }
}

class FakeSocket extends EventEmitter {
  remotePort: number | undefined
  destroyed = false
  destroy(): void { this.destroyed = true; this.emit('close') }
  unpipe(): void {}
  resume(): void {}
}

function useServer(value?: unknown): FakeServer {
  const server = new FakeServer(value)
  netState.server = server
  netState.onConnection = undefined
  return server
}

function onConnection(): (socket: unknown) => void {
  if (typeof netState.onConnection !== 'function') throw new Error('local listener callback missing')
  return netState.onConnection as (socket: unknown) => void
}

it('releases accepted sockets that arrive after their local forward has closed', async () => {
  const server = useServer()
  const transport = new SshTransport(limits)
  const opening = transport.forward('remote.example', 9000)
  server.listening()
  const forward = await opening
  await forward.close()
  const socket = new FakeSocket()
  onConnection()(socket)
  expect(socket.destroyed).toBe(true)
  await transport.dispose()
})

it('closes a forward server when its listen operation fails', async () => {
  const server = useServer()
  const transport = new SshTransport(limits)
  const opening = transport.forward('remote.example', 9000)
  server.emit('error', new Error('local listen failed'))
  await expect(opening).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  expect(server.closed).toBe(true)
  await transport.dispose()
})

it('contains a listen callback that arrives after the forward operation was cancelled', async () => {
  const server = useServer()
  const transport = new SshTransport(limits)
  const controller = new AbortController()
  const opening = transport.forward('remote.example', 9000, controller.signal)
  controller.abort()
  await expect(opening).rejects.toMatchObject({ code: 'ABORTED' })
  server.listening()
  await transport.closed
  expect(server.closed).toBe(true)
})

it('uses an ephemeral source port when an admitted socket has none yet', async () => {
  const server = useServer()
  const transport = new SshTransport(limits)
  const client = (transport as unknown as { client: EventEmitter }).client as unknown as {
    forwardOut(sourceHost: string, sourcePort: number, destinationHost: string, destinationPort: number,
      callback: (error: Error | null, stream: unknown) => void): void
  }
  const forwardOut = vi.fn((_sourceHost: string, sourcePort: number, _destinationHost: string, _destinationPort: number,
    callback: (error: Error | null, stream: unknown) => void) => {
    expect(sourcePort).toBe(0)
    callback(new Error('remote refused'), undefined)
  })
  client.forwardOut = forwardOut
  const opening = transport.forward('remote.example', 9000)
  server.listening()
  const forward = await opening
  const socket = new FakeSocket()
  onConnection()(socket)
  await vi.waitFor(() => { expect(forwardOut).toHaveBeenCalledOnce() })
  expect(socket.destroyed).toBe(true)
  await forward.close()
  await transport.dispose()
})
