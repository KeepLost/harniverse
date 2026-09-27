import { EventEmitter, once } from 'node:events'
import { createConnection, createServer, Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { ClientChannel, OpenSSHAgent } from 'ssh2'
import { RemoteHostSshError } from '../src/errors.ts'
import { SshTransport } from '../src/connection.ts'
import type { Config } from '../src/types.ts'

const limits: Required<Config> = {
  connectTimeoutMs: 100,
  operationTimeoutMs: 100,
  maxOutputBytes: 32,
  maxReadBytes: 32,
}

class FakeResource extends EventEmitter {
  destroyed = 0
  readonly stderr = Object.assign(new EventEmitter(), { resume: vi.fn() })
  readonly unpipe = vi.fn()
  readonly resume = vi.fn()
  end = vi.fn()
  destroy = vi.fn(() => { this.destroyed++; this.emit('close') })
}

class FakePipeSocket extends EventEmitter {
  readonly destroy = vi.fn()
  pipe(destination: unknown): unknown { return destination }
}

class FakePipeStream extends FakeResource {
  pipe(destination: unknown): unknown { return destination }
}

type Operation<T> = { succeed(value: T): void; fail(): void }
type Tunnel = {
  active(): boolean
  own<T>(resource: T): T
  wait(task: Promise<void>): void
  close(): Promise<void>
}
type Internals = {
  socket: Socket
  client: EventEmitter
  lifetime: AbortController
  resources: Map<unknown, Promise<void>>
  track<T>(resource: T, fatal?: boolean): T
  pipe(socket: Socket, stream: ClientChannel): void
  agent(path: string): OpenSSHAgent
  operation<T>(start: (operation: Operation<T>) => void): Promise<T>
  stop(error: RemoteHostSshError): void
  tunnel(removeListener: () => Promise<void>): Tunnel
}

function internals(transport: SshTransport): Internals {
  return transport as unknown as Internals
}

it.each(['socket', 'client'] as const)('closes the transport after a fatal %s error', async (source) => {
  const transport = new SshTransport(limits)
  internals(transport)[source].emit('error', new Error('fixture error'))
  await transport.closed
  expect(transport.signal.aborted).toBe(true)
})

it('contains agent paths that throw and refuses streams requested after closure', async () => {
  const transport = new SshTransport(limits)
  const active = internals(transport)
  const agent = active.agent('fixture-agent')
  const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { throw new Error('connect failed') })
  const error = await new Promise<Error | undefined>((resolve) => {
    agent.getStream((failure) => {
      const socket = [...active.resources.keys()][0] as Socket | undefined
      socket?.emit('connect')
      resolve(failure ?? undefined)
    })
  })
  connect.mockRestore()
  expect(error).toMatchObject({ code: 'CONNECT_FAILED' })
  await transport.dispose()
  const closed = await new Promise<Error | undefined>((resolve) => {
    agent.getStream((failure) => { resolve(failure ?? undefined) })
  })
  expect(closed).toMatchObject({ code: 'CLOSED' })
})

it('retains an existing ssh2 agent object and rejects readiness that precedes host verification', async () => {
  const transport = new SshTransport(limits)
  const active = internals(transport)
  const client = active.client as unknown as {
    connect(options: { hostVerifier(key: Buffer): boolean }): void
    emit(event: string): boolean
  }
  const key = Buffer.from('fixture-host-key')
  const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
  client.connect = (options) => {
    expect(options.hostVerifier(key)).toBe(true)
    queueMicrotask(() => { client.emit('ready') })
  }
  ;(active.socket as unknown as { connect(options: unknown): Socket }).connect = () => active.socket
  await expect(transport.connect({ host: 'fixture.invalid', username: 'runner' }, {
    password: 'fixture-password', agent: { getStream() {} } as unknown as OpenSSHAgent, authHandler: ['password'],
  }, fingerprint)).resolves.toBe(fingerprint)
  await transport.dispose()

  const premature = new SshTransport(limits)
  const state = internals(premature)
  const prematureClient = state.client as unknown as { connect(): void; emit(event: string): boolean }
  prematureClient.connect = () => { queueMicrotask(() => { prematureClient.emit('ready') }) }
  ;(state.socket as unknown as { connect(options: unknown): Socket }).connect = () => state.socket
  await expect(premature.connect({ host: 'fixture.invalid', port: 22, username: 'runner' }, { password: 'fixture-password' }, fingerprint))
    .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  await premature.closed
})

it('owns a successfully opened agent socket until transport disposal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-agent-edge-'))
  const path = process.platform === 'win32' ? String.raw`\\.\pipe\ssh-edge-${randomUUID()}` : join(directory, 'agent.sock')
  const server = createServer((socket) => { socket.on('error', () => {}); socket.resume() }).listen(path)
  await once(server, 'listening')
  const transport = new SshTransport(limits)
  try {
    const agent = internals(transport).agent(path)
    const socket = await new Promise<Socket>((resolve, reject) => {
      agent.getStream((error, stream) => { if (error) reject(error); else resolve(stream as Socket) })
    })
    const closed = once(socket, 'close')
    await transport.dispose()
    await closed
    expect(transport.signal.aborted).toBe(true)
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(directory, { recursive: true, force: true })
  }
})

it('stops on fatal owned-resource errors and releases resources tracked after closure', async () => {
  const transport = new SshTransport(limits)
  const resource = new FakeResource()
  internals(transport).track(resource)
  resource.emit('error', new Error('resource failed'))
  await transport.closed
  expect(transport.signal.aborted).toBe(true)
  expect(resource.destroyed).toBeGreaterThan(0)

  const late = new SshTransport(limits)
  await late.dispose()
  const resourceAfterClose = new FakeResource()
  internals(late).track(resourceAfterClose)
  expect(resourceAfterClose.destroyed).toBeGreaterThan(0)
})

it('normalizes an unexpected abort reason while an operation is pending', async () => {
  const transport = new SshTransport(limits)
  const active = internals(transport)
  const operation = active.operation<undefined>(() => {})
  active.lifetime.abort('untyped cancellation')
  await expect(operation).rejects.toMatchObject({ code: 'CLOSED' })
  active.socket.destroy()
  await transport.closed
})

it('releases tunneled resources when either side reports a socket error', async () => {
  const transport = new SshTransport(limits)
  const socket = new FakePipeSocket()
  const stream = new FakePipeStream()
  internals(transport).pipe(socket as unknown as Socket, stream as unknown as ClientChannel)
  socket.emit('error', new Error('local socket error'))
  expect(stream.destroyed).toBe(1)
  stream.emit('error', new Error('remote channel error'))
  expect(socket.destroy).toHaveBeenCalledTimes(2)
  await transport.dispose()
})

it('discards an SSH command channel returned after its operation has been cancelled', async () => {
  const transport = new SshTransport(limits)
  const client = internals(transport).client as unknown as {
    exec(command: string, callback: (error: Error | null, stream: unknown) => void): void
  }
  let complete!: (error: Error | null, stream: unknown) => void
  client.exec = (_command, callback) => { complete = callback }
  const pending = transport.exec('late channel')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
  await transport.dispose()
  const stream = new FakeResource()
  complete(null, stream)
  await rejected
  expect(stream.destroyed).toBeGreaterThan(0)
})

it('captures command output and ignores data arriving after the channel has closed', async () => {
  const transport = new SshTransport(limits)
  const client = internals(transport).client as unknown as {
    exec(command: string, callback: (error: Error | null, stream: unknown) => void): void
  }
  const stream = new FakeResource()
  client.exec = (_command, callback) => { callback(null, stream) }
  const result = transport.exec('fixture output')
  stream.emit('data', Buffer.from('out'))
  stream.stderr.emit('data', Buffer.from('err'))
  stream.emit('exit', null, 'TERM')
  stream.emit('close')
  await expect(result).resolves.toEqual({ stdout: Buffer.from('out'), stderr: Buffer.from('err'), exitCode: null, signal: 'TERM' })
  stream.emit('data', Buffer.from('late'))
  stream.stderr.emit('data', Buffer.from('late'))
  await transport.dispose()
})

it('rejects command output that exceeds its configured byte limit', async () => {
  const transport = new SshTransport({ ...limits, maxOutputBytes: 2 })
  const client = internals(transport).client as unknown as {
    exec(command: string, callback: (error: Error | null, stream: unknown) => void): void
  }
  const stream = new FakeResource()
  client.exec = (_command, callback) => { callback(null, stream) }
  const pending = transport.exec('oversized output')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  stream.emit('data', Buffer.from('too large'))
  await rejected
  await transport.closed
})

it('releases an SFTP subsystem returned after the request was cancelled', async () => {
  const transport = new SshTransport(limits)
  const client = internals(transport).client as unknown as {
    sftp(callback: (error: Error | null, sftp: unknown) => void): void
  }
  let complete!: (error: Error | null, sftp: unknown) => void
  client.sftp = (callback) => { complete = callback }
  const pending = transport.readFile('/fixture')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
  await transport.dispose()
  const sftp = new FakeResource()
  complete(null, sftp)
  await rejected
  expect(sftp.destroyed).toBeGreaterThan(0)
})

it('stops an in-progress SFTP read before returning partial file bytes', async () => {
  const transport = new SshTransport(limits)
  const active = internals(transport)
  const readStarted = Promise.withResolvers<undefined>()
  const sftp = new FakeResource() as FakeResource & {
    open(path: string, flags: string, callback: (error: Error | null, handle: Buffer) => void): void
    read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number,
      callback: (error: Error | null, bytes: number) => void): void
  }
  sftp.open = (_path, _flags, callback) => { callback(null, Buffer.from('handle')) }
  sftp.read = (_handle, buffer, _offset, _length, _position, callback) => {
    buffer[0] = 65
    readStarted.resolve(undefined)
    queueMicrotask(() => { active.stop(new RemoteHostSshError('CLOSED')) })
    callback(null, 1)
  }
  sftp.end = vi.fn(() => { sftp.emit('close') })
  const client = active.client as unknown as { sftp(callback: (error: Error | null, value: unknown) => void): void }
  client.sftp = (callback) => { callback(null, sftp) }
  const pending = transport.readFile('/fixture')
  await readStarted.promise
  await expect(pending).rejects.toMatchObject({ code: 'CLOSED' })
  expect(sftp.destroyed).toBeGreaterThan(0)
  await transport.closed
})

it('bounds tunnel teardown when an owned resource ignores its first destroy', async () => {
  const transport = new SshTransport({ ...limits, operationTimeoutMs: 10 })
  const resource = new FakeResource()
  let destroys = 0
  resource.destroy = vi.fn(() => {
    destroys++
    if (destroys > 1) resource.emit('close')
  })
  const tunnel = internals(transport).tunnel(async () => {})
  tunnel.own(resource)
  await tunnel.close()
  await transport.closed
  expect(destroys).toBeGreaterThan(1)
})

it('drains a tunnel resource whose transport tracking entry has already settled', async () => {
  const transport = new SshTransport(limits)
  const active = internals(transport)
  const resource = new FakeResource()
  resource.destroy = vi.fn()
  const tunnel = active.tunnel(async () => {})
  tunnel.own(resource)
  active.resources.delete(resource)
  await tunnel.close()
  resource.emit('close')
  await transport.dispose()
})

it('ignores a remote reverse-forward acknowledgment that arrives after cancellation', async () => {
  const transport = new SshTransport(limits)
  const client = internals(transport).client as unknown as {
    forwardIn(address: string, port: number, callback: (error: Error | null, port: number) => void): void
  }
  let acknowledge!: (error: Error | null, port: number) => void
  client.forwardIn = (_address, _port, callback) => { acknowledge = callback }
  const controller = new AbortController()
  const pending = transport.reverse({ localHost: '127.0.0.1', localPort: 9000 }, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  controller.abort()
  await rejected
  acknowledge(null, 45004)
  await transport.closed
})

it('closes a local forward socket when ssh2 rejects its remote channel request', async () => {
  const transport = new SshTransport(limits)
  const client = internals(transport).client as unknown as {
    forwardOut(sourceHost: string, sourcePort: number, destinationHost: string, destinationPort: number,
      callback: (error: Error | null, stream: unknown) => void): void
  }
  const forwardOut = vi.fn((_sourceHost: string, _sourcePort: number, _destinationHost: string, _destinationPort: number,
    callback: (error: Error | null, stream: unknown) => void) => {
    callback(new Error('remote destination refused'), undefined)
  })
  client.forwardOut = forwardOut
  const forwarding = await transport.forward('remote.example', 9000)
  const socket = createConnection({ host: '127.0.0.1', port: forwarding.port })
  socket.on('error', () => {})
  const closed = once(socket, 'close')
  await once(socket, 'connect')
  await closed
  expect(forwardOut).toHaveBeenCalledOnce()
  await forwarding.close()
  await transport.dispose()
})

it('does not close an upload handle after cancellation during permission setup', async () => {
  const transport = new SshTransport(limits)
  const active = internals(transport)
  const sftp = new FakeResource() as FakeResource & {
    open(path: string, flags: string, attrs: { mode: number }, callback: (error: Error | null, handle: Buffer) => void): void
    fchmod(handle: Buffer, mode: number, callback: (error?: Error | null) => void): void
    close(handle: Buffer, callback: (error?: Error | null) => void): void
    fastPut(source: string, destination: string, options: unknown, callback: (error?: Error | null) => void): void
  }
  sftp.open = (_path, _flags, _attrs, callback) => { callback(null, Buffer.from('handle')) }
  sftp.fchmod = (_handle, _mode, callback) => {
    active.stop(new RemoteHostSshError('CLOSED'))
    callback(null)
  }
  sftp.close = vi.fn((_handle: Buffer, callback: (error?: Error | null) => void) => { callback(null) })
  sftp.fastPut = vi.fn((_source: string, _destination: string, _options: unknown,
    callback: (error?: Error | null) => void) => { callback(null) })
  const client = active.client as unknown as { sftp(callback: (error: Error | null, value: unknown) => void): void }
  client.sftp = (callback) => { callback(null, sftp) }
  await expect(transport.upload('/local', '/remote')).rejects.toMatchObject({ code: 'CLOSED' })
  await transport.closed
  const close = Reflect.get(sftp, 'close') as ReturnType<typeof vi.fn>
  const fastPut = Reflect.get(sftp, 'fastPut') as ReturnType<typeof vi.fn>
  expect(close).not.toHaveBeenCalled()
  expect(fastPut).not.toHaveBeenCalled()
})

it('settles a reverse TCP open when its configured local destination refuses the socket', async () => {
  const unavailable = createServer().listen(0, '127.0.0.1')
  await once(unavailable, 'listening')
  const address = unavailable.address()
  if (!address || typeof address === 'string') throw new Error('fixture port unavailable')
  await new Promise<void>(resolve => unavailable.close(() => { resolve() }))

  const transport = new SshTransport(limits)
  const active = internals(transport)
  const tasks: Promise<void>[] = []
  const rejected = vi.fn()
  active.client.emit('tcp connection', { destIP: '192.0.2.1', destPort: 45001 }, () => new FakePipeStream(), rejected)
  active.client.emit('tcp connection', { destIP: '127.0.0.1', destPort: 45001 }, () => new FakePipeStream(), rejected)
  expect(rejected).toHaveBeenCalledTimes(2)
  rejected.mockClear()
  const tunnel = {
    active: () => true,
    own: (resource: unknown) => {
      if (resource instanceof EventEmitter) resource.on('error', () => {})
      return resource
    },
    wait: (task: Promise<void>) => { tasks.push(task) },
    close: async () => {},
  }
  const reverseMappings = (transport as unknown as { reverseMappings: Map<number, unknown> }).reverseMappings
  reverseMappings.set(45001, { config: { localHost: '127.0.0.1', localPort: address.port }, tunnel })
  active.client.emit('tcp connection', { destIP: '127.0.0.1', destPort: 45001 }, () => new FakePipeStream(), rejected)
  await Promise.all(tasks)
  expect(rejected).toHaveBeenCalledOnce()
  await transport.dispose()
})

it('opens an admitted reverse channel from an active tunnel before the socket has a remote port', async () => {
  const transport = new SshTransport(limits)
  const active = internals(transport)
  const client = active.client as unknown as {
    forwardOut(sourceHost: string, sourcePort: number, destinationHost: string, destinationPort: number,
      callback: (error: Error | null, stream: unknown) => void): void
  }
  client.forwardOut = (_sourceHost, sourcePort, _destinationHost, _destinationPort, callback) => {
    expect(sourcePort).toBe(0)
    callback(new Error('remote channel refused'), undefined)
  }
  const tasks: Promise<void>[] = []
  const tunnel = {
    active: () => true,
    own: (resource: unknown) => {
      if (resource instanceof EventEmitter) resource.on('error', () => {})
      return resource
    },
    wait: (task: Promise<void>) => { tasks.push(task) },
    close: async () => {},
  }
  ;(transport as unknown as { reverseMappings: Map<number, unknown> }).reverseMappings.set(45005, {
    config: { localHost: '127.0.0.1', localPort: 9000 }, tunnel,
  })
  const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
    this.emit('connect')
    return this
  })
  active.client.emit('tcp connection', { destIP: '127.0.0.1', destPort: 45005 }, () => new FakePipeStream(), vi.fn())
  await Promise.all(tasks)
  connect.mockRestore()
  await transport.dispose()
})

it('rejects reverse TCP opens after tunnel cancellation and contains pending transport disposal', async () => {
  const destination = createServer((socket) => { socket.resume() }).listen(0, '127.0.0.1')
  await once(destination, 'listening')
  const address = destination.address()
  if (!address || typeof address === 'string') throw new Error('fixture port unavailable')
  const transport = new SshTransport(limits)
  const active = internals(transport)
  const tasks: Promise<void>[] = []
  let tunnelActive = true
  const accepted = vi.fn(() => new FakePipeStream())
  const rejected = vi.fn()
  const tunnel = {
    active: () => tunnelActive,
    own: (resource: unknown) => {
      if (resource instanceof EventEmitter) resource.on('error', () => {})
      tunnelActive = false
      return resource
    },
    wait: (task: Promise<void>) => { tasks.push(task) },
    close: async () => {},
  }
  const reverseMappings = (transport as unknown as { reverseMappings: Map<number, unknown> }).reverseMappings
  reverseMappings.set(45002, { config: { localHost: '127.0.0.1', localPort: address.port }, tunnel })
  active.client.emit('tcp connection', { destIP: '127.0.0.1', destPort: 45002 }, accepted, rejected)
  await Promise.all(tasks)
  expect(rejected).toHaveBeenCalledOnce()
  expect(accepted).not.toHaveBeenCalled()

  tunnelActive = true
  const pendingTunnel = {
    active: () => tunnelActive,
    own: (resource: unknown) => {
      if (resource instanceof EventEmitter) resource.on('error', () => {})
      return resource
    },
    wait: (task: Promise<void>) => { tasks.push(task) },
    close: async () => {},
  }
  reverseMappings.set(45003, { config: { localHost: '127.0.0.1', localPort: address.port }, tunnel: pendingTunnel })
  active.client.emit('tcp connection', { destIP: '127.0.0.1', destPort: 45003 }, accepted, rejected)
  await transport.dispose()
  await Promise.all(tasks)
  await new Promise<void>(resolve => destination.close(() => { resolve() }))
})
