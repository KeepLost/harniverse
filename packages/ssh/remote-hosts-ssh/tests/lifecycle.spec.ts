import { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import RemoteHostSsh, { RemoteHostSshError } from '../src/index.ts'
import type { RemoteHostSshAuthentication } from '../src/types.ts'
import { encryptedKey, fixture, privateKey } from './fixture.ts'

let host: Awaited<ReturnType<typeof fixture>>
let ctx: Context
let service: RemoteHostSsh
beforeEach(async () => {
  host = await fixture()
  ctx = new Context()
  service = new RemoteHostSsh(ctx, { operationTimeoutMs: 800, maxOutputBytes: 16 })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await host.close()
})

it.each<RemoteHostSshAuthentication>([
  { kind: 'key', privateKey },
  { kind: 'key', privateKey: encryptedKey, passphrase: 'fixture-passphrase' },
])('authenticates with explicit $kind credentials including encrypted keys', async (authentication) => {
  const connection = await service.open(host.config, authentication)
  expect(host.authentications).toEqual(['publickey', 'publickey'])
  await connection.dispose()
})

it('reports signal exits and absent exit metadata without inventing success', async () => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  expect(await connection.exec('signal')).toMatchObject({ exitCode: null, signal: 'SIGTERM' })
  expect(await connection.exec('no-exit')).toMatchObject({ exitCode: null, signal: null })
})

it('bounds combined stdout/stderr in bytes and rejects overflow', async () => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  expect(await connection.exec('echo', 'é')).toMatchObject({ stdout: Buffer.from('é'), stderr: Buffer.from('fixture-stderr') })
  await expect(connection.exec('echo', 'éé')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  await connection.closed
})

it('aborts active commands, sanitizes abort reasons, and joins channel teardown', async () => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  const controller = new AbortController()
  const started = once(host.events, 'exec')
  const result = expect(connection.exec('hang', undefined, controller.signal)).rejects.toMatchObject({ code: 'ABORTED', message: 'SSH operation aborted' })
  await started
  controller.abort(new Error('secret abort reason'))
  await result
  await connection.dispose()
  expect(connection.signal.aborted).toBe(true)
  expect(host.commands).toEqual(['hang'])
})

it('times out an unresponsive command and drains transport resources', async () => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  await expect(connection.exec('hang')).rejects.toMatchObject({ code: 'TIMED_OUT' })
  await connection.closed
})

it('cancels before admission without opening a socket or disturbing an existing connection', async () => {
  const signal = AbortSignal.abort('secret')
  await expect(service.open(host.config, { kind: 'password', password: 'fixture-password' }, signal)).rejects.toMatchObject({ code: 'ABORTED' })
  expect(host.authentications).toEqual([])
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  await expect(connection.exec('hang', undefined, signal)).rejects.toMatchObject({ code: 'ABORTED' })
  expect(connection.signal.aborted).toBe(false)
})

it('rejects new connections synchronously when disposal triggers reentrant listeners', async () => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  let rejected: Promise<unknown> | undefined
  connection.signal.addEventListener('abort', () => {
    rejected = expect(service.open(host.config, { kind: 'password', password: 'fixture-password' })
      .then(() => 'opened', (error: unknown) => error instanceof RemoteHostSshError ? error.code : 'unknown')).resolves.toBe('CLOSED')
  }, { once: true })
  await service.dispose()
  await rejected
})

it('plugin disposal removes the service and closes established connections', async () => {
  await ctx.fiber.dispose()
  ctx = new Context()
  const fiber = ctx.plugin(RemoteHostSsh)
  await fiber
  const connection = await ctx.remoteHostSsh.open(host.config, { kind: 'password', password: 'fixture-password' })
  await fiber.dispose()
  await connection.closed
  expect(ctx.get('remoteHostSsh')).toBeUndefined()
})

it('times out a silent TCP peer and closes the socket before rejecting open', async () => {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.resume()
    socket.on('close', () => sockets.delete(socket))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  const other = new Context()
  const short = new RemoteHostSsh(other, { connectTimeoutMs: 50 })
  try {
    await expect(short.open({ ...host.config, port: address.port }, { kind: 'password', password: 'fixture-password' }))
      .rejects.toMatchObject({ code: 'TIMED_OUT' })
    await short.dispose()
  } finally {
    await other.fiber.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})
