import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendAccessRecord, appendAccessRecords, accessLogPath } from '../src/access-log.ts'
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
  it('persists a durable admission batch as ordered individual JSONL records', async () => {
    const dshHome = await home()
    await appendAccessRecords([
      {
        time: '2026-08-16T00:00:00.000Z',
        event: 'access-accepted',
        mode: 'authenticated',
        channel: 'http-api',
        outcome: 'accepted',
        peer: '127.0.0.1',
      },
      {
        time: '2026-08-16T00:00:00.001Z',
        event: 'access-rejected',
        mode: 'authenticated',
        channel: 'http-api',
        outcome: 'rejected',
        peer: '127.0.0.2',
        reasonCode: 'invalid-credential',
      },
    ], { dshHome })

    const records = (await readFile(accessLogPath(dshHome), 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; peer: string })
    expect(records).toEqual([
      expect.objectContaining({ event: 'access-accepted', peer: '127.0.0.1' }),
      expect.objectContaining({ event: 'access-rejected', peer: '127.0.0.2' }),
    ])
  })

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

describe('access log rotation', () => {
  const record = (event: 'instance-started' | 'instance-stopped', time: string): Parameters<typeof appendAccessRecord>[0] =>
    ({ time, event })

  /** Existing rotated generations, newest first, as their raw text. */
  async function generations(dshHome: string, maxFiles: number): Promise<Array<string | undefined>> {
    const path = accessLogPath(dshHome)
    return await Promise.all(Array.from({ length: maxFiles }, async (_, index) =>
      await readFile(`${path}.${String(index + 1)}`, 'utf8').catch(() => undefined)))
  }

  it('rotates the active file once it would exceed the byte bound', async () => {
    const dshHome = await home()
    const path = accessLogPath(dshHome)
    const first = record('instance-started', '2026-08-16T00:00:00.000Z')
    const line = `${JSON.stringify(first)}\n`
    // A bound that admits exactly one record forces the second to rotate.
    const maxBytes = Buffer.byteLength(line)

    await appendAccessRecord(first, { dshHome, maxBytes, maxFiles: 3 })
    await appendAccessRecord(record('instance-stopped', '2026-08-16T00:00:01.000Z'), { dshHome, maxBytes, maxFiles: 3 })

    expect(await readFile(path, 'utf8')).toContain('instance-stopped')
    expect(await readFile(`${path}.1`, 'utf8')).toContain('instance-started')
  })

  it('splits one batch across a rotation boundary in admission order', async () => {
    const dshHome = await home()
    const path = accessLogPath(dshHome)
    const first = record('instance-started', '2026-08-16T00:00:00.000Z')
    const maxBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`)

    await appendAccessRecords([
      first,
      record('instance-stopped', '2026-08-16T00:00:01.000Z'),
    ], { dshHome, maxBytes, maxFiles: 2 })

    // The first record is written before rotation so the batch stays ordered
    // across the boundary rather than being reordered or dropped.
    expect(await readFile(`${path}.1`, 'utf8')).toContain('instance-started')
    expect(await readFile(path, 'utf8')).toContain('instance-stopped')
  })

  it('shifts existing generations and discards the oldest beyond the file bound', async () => {
    const dshHome = await home()
    const maxBytes = Buffer.byteLength(`${JSON.stringify(record('instance-started', '2026-08-16T00:00:00.000Z'))}\n`)
    const times = Array.from({ length: 5 }, (_, index) => `2026-08-16T00:00:0${String(index)}.000Z`)

    for (const time of times) {
      await appendAccessRecord(record('instance-started', time), { dshHome, maxBytes, maxFiles: 2 })
    }

    // Two generations are retained: the newest rotated pair. Older ones are gone.
    const retained = await generations(dshHome, 3)
    expect(retained[0]).toContain(times[3] as string)
    expect(retained[1]).toContain(times[2] as string)
    expect(retained[2]).toBeUndefined()
    expect(await readFile(accessLogPath(dshHome), 'utf8')).toContain(times[4] as string)
  })

  it('keeps one oversized record in its own generation', async () => {
    const dshHome = await home()
    const path = accessLogPath(dshHome)

    // A record larger than the whole bound cannot be split, so it is written
    // whole rather than refused or truncated.
    await appendAccessRecord(record('instance-started', '2026-08-16T00:00:00.000Z'), { dshHome, maxBytes: 1, maxFiles: 2 })
    expect(await readFile(path, 'utf8')).toContain('instance-started')
    await appendAccessRecord(record('instance-stopped', '2026-08-16T00:00:01.000Z'), { dshHome, maxBytes: 1, maxFiles: 2 })
    expect(await readFile(path, 'utf8')).toContain('instance-stopped')
    expect(await readFile(`${path}.1`, 'utf8')).toContain('instance-started')
  })

  it('writes nothing for an empty batch', async () => {
    const dshHome = await home()
    await appendAccessRecords([], { dshHome })
    await expect(readFile(accessLogPath(dshHome), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['maxBytes', { maxBytes: 0 }, /maxBytes must be a positive integer/],
    ['fractional maxBytes', { maxBytes: 1.5 }, /maxBytes must be a positive integer/],
    ['maxFiles', { maxFiles: 0 }, /maxFiles must be a positive integer/],
    ['fractional maxFiles', { maxFiles: 2.5 }, /maxFiles must be a positive integer/],
  ])('refuses an unusable %s bound', async (_label, options, message) => {
    const dshHome = await home()
    await expect(appendAccessRecord(record('instance-started', '2026-08-16T00:00:00.000Z'), { dshHome, ...options }))
      .rejects.toThrow(message)
  })

  it('propagates a non-missing failure while measuring the active file', async () => {
    const dshHome = await home()
    const path = accessLogPath(dshHome)
    await appendAccessRecord(record('instance-started', '2026-08-16T00:00:00.000Z'), { dshHome })
    // A directory in the active file's place is not a missing file, so the
    // size probe must fail loudly instead of restarting the log at zero.
    await rm(path)
    await mkdir(path, { recursive: true })

    await expect(appendAccessRecord(record('instance-stopped', '2026-08-16T00:00:01.000Z'), { dshHome }))
      .rejects.toThrow()
  })
})
