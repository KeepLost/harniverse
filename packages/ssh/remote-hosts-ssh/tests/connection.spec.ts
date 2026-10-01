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

  it('authenticates an unpinned target and reports the accepted fingerprint with its probe output', async () => {
    const result = await service.verify(host.config, { kind: 'password', password: 'fixture-password' }, 'uname -s && uname -m')
    expect(result).toEqual({ fingerprint: host.config.fingerprint, output: 'Linux\nx86_64\n' })
    expect(host.authentications).toEqual(['password'])
  })

  it('rejects a mismatched pin before sending credentials', async () => {
    await expect(service.open({ ...host.config, fingerprint: `SHA256:${'A'.repeat(43)}` },
      { kind: 'password', password: 'fixture-password' })).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' })
    expect(host.authentications).toEqual([])
  })

  it('sanitizes a rejected connectivity test and sends no probe command', async () => {
    await expect(service.verify(host.config, { kind: 'password', password: 'wrong-password' }, 'uname -s && uname -m'))
      .rejects.toMatchObject({ code: 'CONNECT_FAILED', message: 'SSH connection failed' })
    expect(host.commands).toEqual([])
  })

  it('rejects a connectivity test whose probe command is empty or fails', async () => {
    await expect(service.verify(host.config, { kind: 'password', password: 'fixture-password' }, ''))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    // The fixture exits non-zero for any command other than its detection answer.
    await expect(service.verify(host.config, { kind: 'password', password: 'fixture-password' }, 'false'))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  })

  it('keeps stdout, stderr and exit status separate and closes idempotently', async () => {
    const connection = await service.open(host.config, { kind: 'password', password: 'fixture-password' })
    const result = await connection.exec('echo input', 'hello')
    expect(result).toEqual({ stdout: Buffer.from('hello'), stderr: Buffer.from('fixture-stderr'), exitCode: 7, signal: null })
    const binary = await connection.exec('binary input', Buffer.from([0, 255]))
    expect(binary.stdout).toEqual(Buffer.from([0, 255]))
    await Promise.all([connection.dispose(), connection.dispose()])
    await connection.closed
    expect(host.commands).toEqual(['echo input', 'binary input'])
    await expect(connection.exec('after close')).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('sanitizes authentication failures', async () => {
    await expect(service.open(host.config, { kind: 'password', password: 'secret-that-must-not-appear' }))
      .rejects.toMatchObject({ code: 'CONNECT_FAILED', message: 'SSH connection failed' })
  })

  it('contains an unavailable explicit SSH agent socket', async () => {
    await expect(service.open(host.config, { kind: 'agent', socket: '/tmp/dsh-missing-agent.sock' }))
      .rejects.toMatchObject({ code: 'CONNECT_FAILED', message: 'SSH connection failed' })
    expect(host.authentications).toEqual([])
  })
})
