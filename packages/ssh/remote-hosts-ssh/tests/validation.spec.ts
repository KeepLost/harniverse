import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it } from 'vitest'
import RemoteHostSsh from '../src/index.ts'
import type { Config, RemoteHostSshAuthentication, RemoteHostSshConfig } from '../src/types.ts'
import { fixture } from './fixture.ts'

let ctx: Context
let host: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => { ctx = new Context(); host = await fixture() })
afterEach(async () => { await ctx.fiber.dispose(); await host.close() })

it.each([0, -1, NaN, Infinity, 1.5, 2 ** 31])('rejects invalid bounds %s at plugin construction', (maxOutputBytes) => {
  expect(() => new RemoteHostSsh(ctx, { maxOutputBytes })).toThrow('Invalid SSH configuration')
})

it('rejects malformed endpoints, fingerprints and authentication before connecting', async () => {
  const service = new RemoteHostSsh(ctx)
  const targets: unknown[] = [
    null, { ...host.config, host: '' }, { ...host.config, port: 0 }, { ...host.config, port: 65536 },
    { ...host.config, username: '\0' }, { ...host.config, fingerprint: '' },
    { ...host.config, fingerprint: `SHA256:${'B'.repeat(43)}` },
  ]
  for (const target of targets) {
    await expect(service.open(target as RemoteHostSshConfig, { kind: 'password', password: 'fixture-password' }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  }
  const identities: unknown[] = [null, { kind: 'missing' }, { kind: 'password', password: 1 },
    { kind: 'key', privateKey: '' }, { kind: 'key', privateKey: 'x', passphrase: 5 }, { kind: 'agent', socket: '' }]
  for (const identity of identities) {
    await expect(service.open(host.config, identity as RemoteHostSshAuthentication)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  }
  expect(host.authentications).toEqual([])
  expect(host.peers.size).toBe(0)
})

it('validates operation arguments without invalidating a working connection', async () => {
  const service = new RemoteHostSsh(ctx)
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  for (const result of [connection.exec(''), connection.upload('', '/file'), connection.readFile(''), connection.mkdir(''),
    connection.realpath(''), connection.forward('', 80), connection.forward('127.0.0.1', -1),
    connection.reverse({ localHost: '', localPort: 80 }), connection.reverse({ localHost: '127.0.0.1', localPort: 0 })]) {
    await expect(result).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }
  expect(connection.signal.aborted).toBe(false)
})

it('sanitizes malformed encrypted key failures and keeps service admission available', async () => {
  const service = new RemoteHostSsh(ctx)
  await expect(service.open(host.config, { kind: 'key', privateKey: 'secret invalid key' }))
    .rejects.toMatchObject({ message: 'SSH operation failed' })
  const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
  await connection.dispose()
})

it('uses validated plugin schema defaults', () => {
  const config: Config = RemoteHostSsh.Config({})
  expect(config).toEqual({ connectTimeoutMs: 30000, operationTimeoutMs: 120000, maxOutputBytes: 8388608, maxReadBytes: 4194304 })
})
