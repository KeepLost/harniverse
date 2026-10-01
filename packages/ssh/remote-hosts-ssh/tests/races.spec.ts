import { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import RemoteHostSsh from '../src/index.ts'
import { fixture } from './fixture.ts'

let host: Awaited<ReturnType<typeof fixture>>
let ctx: Context
let service: RemoteHostSsh
let directory: string
beforeEach(async () => {
  host = await fixture()
  ctx = new Context()
  service = new RemoteHostSsh(ctx, { operationTimeoutMs: 3000 })
  directory = await mkdtemp(join(tmpdir(), 'ssh-race-'))
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await host.close()
  await rm(directory, { recursive: true, force: true })
})

it.each(['read', 'write', 'sftp'])('joins stalled SFTP %s cancellation', async (stage) => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  const local = join(directory, 'data')
  await writeFile(local, Buffer.alloc(256 * 1024))
  host.files.set('/data', { data: Buffer.alloc(64), mode: 0o600 })
  host.holds.add(stage)
  const controller = new AbortController()
  const started = once(host.events, stage)
  const request = stage === 'write' ? connection.upload(local, '/data', controller.signal)
    : connection.readFile('/data', controller.signal)
  const result = expect(request).rejects.toMatchObject({ code: 'ABORTED' })
  await started
  controller.abort()
  await result
  await connection.dispose()
  await connection.closed
  expect(connection.signal.aborted).toBe(true)
})

it('rejects private-mode failures before transferring any local data', async () => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  const local = join(directory, 'data')
  await writeFile(local, 'sensitive fixture')
  host.holds.add('chmod')
  await expect(connection.upload(local, '/data')).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  expect(host.files.get('/data')?.data.length).toBe(0)
})

it('disposes a connection while authentication is pending', async () => {
  host.holds.add('authentication')
  const started = once(host.events, 'authentication')
  const result = expect(service.open(host.config, { kind: 'password', password: 'fixture-password' }))
    .rejects.toMatchObject({ code: 'CLOSED' })
  await started
  await service.dispose()
  await result
})

it('transfers into an already-private destination when subsequent permission changes are denied', async () => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  const local = join(directory, 'data')
  await writeFile(local, 'private fixture')
  host.holds.add('repeated-chmod')
  await connection.upload(local, '/data')
  expect(host.files.get('/data')).toEqual({ data: Buffer.from('private fixture'), mode: 0o600 })
})

it('contains remote disconnect while command creation is pending', async () => {
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  const result = expect(connection.exec('hang')).rejects.toBeInstanceOf(Error)
  for (const peer of host.peers) peer.end()
  await result
  await connection.closed
  expect(connection.signal.aborted).toBe(true)
})
