import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import RemoteHostSsh from '../src/index.ts'
import { fixture } from './fixture.ts'

describe('pinned remote SSH transport', () => {
  let host: Awaited<ReturnType<typeof fixture>>
  let ctx: Context
  let service: RemoteHostSsh
  beforeEach(async () => {
    host = await fixture()
    ctx = new Context()
    service = new RemoteHostSsh(ctx)
  })
  afterEach(async () => {
    await service.dispose()
    await ctx.fiber.dispose()
    await host.close()
  })

  it('observes a SHA256 fingerprint while rejecting the key before authentication', async () => {
    expect(await service.probe(host.config)).toBe(host.config.fingerprint)
    expect(host.authentications).toEqual([])
    expect(host.commands).toEqual([])
  })

  it('rejects a mismatched pin before sending credentials', async () => {
    await expect(service.open({ ...host.config, fingerprint: `SHA256:${'A'.repeat(43)}` },
      { kind: 'password', password: 'fixture-password' })).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' })
    expect(host.authentications).toEqual([])
  })

  it('keeps stdout, stderr and exit status separate and closes idempotently', async () => {
    const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
    const result = await connection.exec('echo input', 'hello')
    expect(result).toEqual({ stdout: Buffer.from('hello'), stderr: Buffer.from('fixture-stderr'), exitCode: 7, signal: null })
    await Promise.all([connection.dispose(), connection.dispose()])
    await connection.closed
    expect(host.commands).toEqual(['echo input'])
    await expect(connection.exec('after close')).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('sanitizes authentication failures', async () => {
    await expect(service.open(host.config, { kind: 'password', password: 'secret-that-must-not-appear' }))
      .rejects.toMatchObject({ code: 'CONNECT_FAILED', message: 'SSH connection failed' })
  })
})
