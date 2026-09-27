import { Context } from '@deepseek-ai/cordis'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import type { ServerChannel } from 'ssh2'
import { afterEach, beforeEach, expect, it } from 'vitest'
import RemoteHostSsh from '../src/index.ts'
import type { RemoteHostSshConnection } from '../src/types.ts'
import { fixture } from './fixture.ts'
import { echoServer, exchange } from './forwarding-fixture.ts'

let host: Awaited<ReturnType<typeof fixture>>
let echo: Awaited<ReturnType<typeof echoServer>>
let ctx: Context
let service: RemoteHostSsh
let connection: RemoteHostSshConnection
beforeEach(async () => {
  host = await fixture()
  echo = await echoServer()
  ctx = new Context()
  service = new RemoteHostSsh(ctx, { operationTimeoutMs: 1000 })
  connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await host.close()
  await echo.close()
})

it('forwards local loopback sockets through forwardOut and closes the listener', async () => {
  const forward = await connection.forward('127.0.0.1', echo.port)
  expect(await exchange(forward.port, 'forwarded')).toBe('forwarded')
  expect(host.forwarding[0]!.destinations[0]).toMatchObject({ destIP: '127.0.0.1', destPort: echo.port })
  await Promise.all([forward.close(), forward.close()])
  const socket = createConnection({ host: '127.0.0.1', port: forward.port })
  expect((await once(socket, 'error'))[0]).toMatchObject({ code: 'ECONNREFUSED' })
})

it('binds reverse forwarding only to remote loopback and passes bytes only to its configured destination', async () => {
  const reverse = await connection.reverse({ localHost: '127.0.0.1', localPort: echo.port })
  expect(host.forwarding[0]!.binds).toEqual([{ bindAddr: '127.0.0.1', bindPort: 0 }])
  expect(await exchange(reverse.port, 'reverse')).toBe('reverse')
  await reverse.close()
  expect(host.forwarding[0]!.listeners.size).toBe(0)
})

it('rejects unregistered destination addresses, ports and connections', async () => {
  const reverse = await connection.reverse({ localHost: '127.0.0.1', localPort: echo.port })
  const peer = [...host.peers][0]!
  for (const [address, port] of [['0.0.0.0', reverse.port], ['127.0.0.1', reverse.port === 65535 ? 1 : reverse.port + 1]] as const) {
    const error = await new Promise(resolve => peer.forwardOut(address, port, '127.0.0.1', 1234, (error, stream) => {
      stream?.destroy()
      resolve(error)
    }))
    expect(error).toBeInstanceOf(Error)
  }
  const second = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  const secondPeer = [...host.peers].find(value => value !== peer)!
  const error = await new Promise(resolve => secondPeer.forwardOut('127.0.0.1', reverse.port, '127.0.0.1', 1234, (error, stream) => {
    stream?.destroy()
    resolve(error)
  }))
  expect(error).toBeInstanceOf(Error)
  await second.dispose()
})

it('drains active sockets and removes both listeners during connection disposal', async () => {
  const forward = await connection.forward('127.0.0.1', echo.port)
  const reverse = await connection.reverse({ localHost: '127.0.0.1', localPort: echo.port })
  const sockets = [forward.port, reverse.port].map(port => createConnection({ host: '127.0.0.1', port }))
  for (const socket of sockets) socket.on('error', () => {})
  const closed = sockets.map(socket => once(socket, 'close'))
  await Promise.all(sockets.map(socket => once(socket, 'connect')))
  await connection.dispose()
  await Promise.all(closed)
  await Promise.all([forward.close(), reverse.close(), connection.closed])
  expect(connection.signal.aborted).toBe(true)
  expect(host.commands).toEqual([])
})

it('rejects duplicate bindings and snapshots destinations before asynchronous bind completion', async () => {
  const target = { localHost: '127.0.0.1', localPort: echo.port }
  const binding = connection.reverse(target)
  target.localPort = 1
  const reverse = await binding
  await expect(connection.reverse({ remotePort: reverse.port, localHost: '127.0.0.1', localPort: echo.port }))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(await exchange(reverse.port, 'snapshot')).toBe('snapshot')
  await reverse.close()
})

it('reports refused remote binds without invalidating other operations', async () => {
  await expect(connection.reverse({ remotePort: echo.port, localHost: '127.0.0.1', localPort: echo.port }))
    .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  expect(connection.signal.aborted).toBe(false)
})

it.each(['tcpip-forward', 'cancel-tcpip-forward', 'tcpip'])('bounds stalled %s acknowledgments and drains listeners', async (stage) => {
  if (stage === 'tcpip-forward') {
    host.holds.add(stage)
    await expect(connection.reverse({ localHost: '127.0.0.1', localPort: echo.port })).rejects.toMatchObject({ code: 'TIMED_OUT' })
  } else if (stage === 'cancel-tcpip-forward') {
    const reverse = await connection.reverse({ localHost: '127.0.0.1', localPort: echo.port })
    host.holds.add(stage)
    await reverse.close()
  } else {
    const forward = await connection.forward('127.0.0.1', echo.port)
    host.holds.add(stage)
    const started = once(host.events, stage)
    const socket = createConnection({ host: '127.0.0.1', port: forward.port })
    socket.on('error', () => {}) // The operation deadline closes this accepted socket.
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    await started
    await forward.close()
    await closed
  }
  await connection.closed
  expect(connection.signal.aborted).toBe(true)
})

it('joins a channel whose open acknowledgment arrives after forwarding close begins', async () => {
  const forward = await connection.forward('127.0.0.1', echo.port)
  host.holds.add('tcpip')
  const started = once(host.events, 'tcpip') as Promise<[() => ServerChannel]>
  const socket = createConnection({ host: '127.0.0.1', port: forward.port })
  socket.on('error', () => {}) // Closing the forwarding handle releases this socket.
  const [accept] = await started
  const closing = forward.close()
  const stream = accept()
  stream.resume()
  let closed = false
  stream.on('close', () => { closed = true })
  await closing
  expect(closed).toBe(true)
  expect(connection.signal.aborted).toBe(false)
})
