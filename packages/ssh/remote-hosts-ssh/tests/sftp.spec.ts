import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import RemoteHostSsh from '../src/index.ts'
import type { RemoteHostSshConnection } from '../src/types.ts'
import { fixture } from './fixture.ts'

let host: Awaited<ReturnType<typeof fixture>>
let ctx: Context
let connection: RemoteHostSshConnection
let directory: string
beforeEach(async () => {
  host = await fixture()
  ctx = new Context()
  const service = new RemoteHostSsh(ctx, { maxReadBytes: 16 })
  connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  directory = await mkdtemp(join(tmpdir(), 'remote-hosts-ssh-'))
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await host.close()
  await rm(directory, { recursive: true, force: true })
})

it('uploads bytes through SFTP and tightens existing file permissions', async () => {
  const local = join(directory, 'payload')
  await writeFile(local, 'private data')
  host.files.set('/payload', { data: Buffer.from('old'), mode: 0o666 })
  await connection.upload(local, '/payload')
  expect(host.files.get('/payload')).toEqual({ data: Buffer.from('private data'), mode: 0o600 })
  expect(await connection.readFile('/payload')).toEqual(Buffer.from('private data'))
  expect(host.commands).toEqual([])
})

it('creates private empty uploads and directories and passes paths to the server unchanged', async () => {
  const local = join(directory, 'empty')
  await writeFile(local, '')
  await connection.upload(local, 'C:/Users/fixture/empty')
  expect(host.files.get('C:/Users/fixture/empty')).toEqual({ data: Buffer.alloc(0), mode: 0o600 })
  await connection.mkdir('/private')
  expect(host.files.get('/private')?.mode).toBe(0o700)
  expect(await connection.realpath('.')).toBe('/home/fixture')
  await expect(connection.mkdir('/private')).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
})

it('enforces exact byte bounds, including multibyte data', async () => {
  host.files.set('/exact', { data: Buffer.from('é'.repeat(8)), mode: 0o600 })
  expect(await connection.readFile('/exact')).toEqual(Buffer.from('é'.repeat(8)))
  host.files.set('/large', { data: Buffer.from('é'.repeat(9)), mode: 0o600 })
  await expect(connection.readFile('/large')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  await connection.closed
})

it('sanitizes SFTP denial and local filesystem errors', async () => {
  await expect(connection.readFile('/denied')).rejects.toMatchObject({ code: 'OPERATION_FAILED', message: 'SSH operation failed' })
  await expect(connection.upload(join(directory, 'missing-secret-path'), '/payload'))
    .rejects.toMatchObject({ code: 'OPERATION_FAILED', message: 'SSH operation failed' })
})
