import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendAccessRecord, accessLogPath } from '../src/access-log.ts'
import { acquireAuthenticationLease } from '../src/instance-lease.ts'

const homes: string[] = []

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-lease-'))
  homes.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('authentication instance lease', () => {
  it('allows only one network-serving process per DSH home and releases by owner nonce', async () => {
    const dshHome = await home()
    const lease = await acquireAuthenticationLease({ dshHome, mode: 'authenticated' })
    await expect(acquireAuthenticationLease({ dshHome, mode: 'bypass' })).rejects.toThrow(/already running/)
    await lease.release()
    const next = await acquireAuthenticationLease({ dshHome, mode: 'bypass' })
    await next.release()
  })

  it('treats an empty lease during concurrent stale-owner cleanup as retryable', async () => {
    const dshHome = await home()
    const root = join(dshHome, 'runtime', 'inbound-authentication.lease')
    const nonce = '0'.repeat(32)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(join(root, `owner-${nonce}.json`), `${JSON.stringify({
      version: 1,
      mode: 'authenticated',
      pid: 2_147_483_647,
      nonce,
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })

    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
      acquireAuthenticationLease({ dshHome, mode: 'authenticated' })))
    const acquired = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireAuthenticationLease>>> =>
      attempt.status === 'fulfilled')
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected')
    expect(acquired).toHaveLength(1)
    expect(rejected).toHaveLength(3)
    for (const attempt of rejected) expect(String(attempt.reason)).toMatch(/already running/)
    await acquired[0]!.value.release()
  })

  it('rejects a lease directory containing an unexpected entry', async () => {
    const dshHome = await home()
    const root = join(dshHome, 'runtime', 'inbound-authentication.lease')
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'partial-owner.tmp'), '', { mode: 0o600 })

    await expect(acquireAuthenticationLease({ dshHome, mode: 'authenticated' }))
      .rejects.toThrow(/invalid instance lease/)
  })
})

describe('authentication access records', () => {
  it('persists sanitized global records without credential material', async () => {
    const dshHome = await home()
    await appendAccessRecord({
      time: '2026-08-16T00:00:00.000Z',
      event: 'access-accepted',
      mode: 'authenticated',
      channel: 'http-api',
      outcome: 'accepted',
      peer: '127.0.0.1',
      grantName: 'laptop',
    }, { dshHome })
    const text = await readFile(accessLogPath(dshHome), 'utf8')
    expect(text).toContain('"grantName":"laptop"')
    expect(text).not.toContain('Authorization')
    expect(text).not.toContain('cookie')
    expect(text.endsWith('\n')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects an existing access log exposed beyond its owner', async () => {
    const dshHome = await home()
    const path = accessLogPath(dshHome)
    await appendAccessRecord({ time: new Date().toISOString(), event: 'instance-started' }, { dshHome })
    await chmod(path, 0o644)
    await expect(appendAccessRecord({ time: new Date().toISOString(), event: 'instance-stopped' }, { dshHome }))
      .rejects.toThrow(/accessible beyond its owner/)
  })
})
