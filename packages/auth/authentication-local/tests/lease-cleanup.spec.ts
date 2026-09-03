/**
 * Instance-lease cleanup contention: a vacated lease directory is removed
 * against live competitors, so the platform's contention code must be
 * tolerated and retried while an unremovable directory still fails loudly.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const LEASE_LEAF = 'inbound-authentication.lease'

const control = vi.hoisted(() => ({
  /** Error code every rmdir of the lease root raises, or undefined to pass through. */
  rmdirCode: undefined as string | undefined,
  /** Remaining rmdir calls that raise; undefined raises indefinitely. */
  rmdirCount: undefined as number | undefined,
  rmdirCalls: 0,
  /**
   * Error code publication into the lease root raises. POSIX rename replaces an
   * empty destination directory, so reaching the cleanup path deterministically
   * requires denying that publication.
   */
  renameCode: undefined as string | undefined,
  /** Remaining rename calls that raise; undefined raises indefinitely. */
  renameCount: undefined as number | undefined,
  renameCalls: 0,
  /** Runs after a denied publication, modelling what the competitor did next. */
  onRenameFailure: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const targetsLease = (path: string): boolean => path.endsWith('inbound-authentication.lease')
  return {
    ...actual,
    rmdir: async (...args: Parameters<typeof actual.rmdir>): Promise<void> => {
      if (control.rmdirCode !== undefined && targetsLease(String(args[0]))) {
        control.rmdirCalls += 1
        if (control.rmdirCount === undefined || control.rmdirCalls <= control.rmdirCount) {
          throw Object.assign(new Error(`simulated ${control.rmdirCode}`), { code: control.rmdirCode })
        }
      }
      await actual.rmdir(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>): Promise<void> => {
      if (control.renameCode !== undefined && targetsLease(String(args[1]))) {
        control.renameCalls += 1
        if (control.renameCount === undefined || control.renameCalls <= control.renameCount) {
          const code = control.renameCode
          await control.onRenameFailure?.()
          throw Object.assign(new Error(`simulated ${code}`), { code })
        }
      }
      await actual.rename(...args)
    },
  }
})

const { acquireAuthenticationLease } = await import('../src/instance-lease.ts')

const homes: string[] = []

afterEach(async () => {
  control.rmdirCode = undefined
  control.rmdirCount = undefined
  control.rmdirCalls = 0
  control.renameCode = undefined
  control.renameCount = undefined
  control.renameCalls = 0
  control.onRenameFailure = undefined
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** A DSH home whose lease directory holds one dead owner. */
async function homeWithStaleOwner(): Promise<string> {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-lease-cleanup-'))
  homes.push(dshHome)
  const root = join(dshHome, 'runtime', 'inbound-authentication.lease')
  const nonce = '1'.repeat(32)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(join(root, `owner-${nonce}.json`), `${JSON.stringify({
    version: 1,
    mode: 'authenticated',
    // A pid no live process holds, so the owner reads as stale.
    pid: 2_147_483_647,
    nonce,
    startedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 })
  return dshHome
}

/** A DSH home whose lease directory exists with no owner file at all. */
async function homeWithVacantLease(): Promise<string> {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-lease-vacant-'))
  homes.push(dshHome)
  await mkdir(join(dshHome, 'runtime', 'inbound-authentication.lease'), { recursive: true, mode: 0o700 })
  return dshHome
}

describe('instance lease cleanup contention', () => {
  it.each(['ENOTEMPTY', 'EPERM'])('retries a stale-owner cleanup reporting %s once', async (code) => {
    const dshHome = await homeWithStaleOwner()
    control.rmdirCode = code
    control.rmdirCount = 1

    // The first removal loses the race; the retry acquires the lease.
    const lease = await acquireAuthenticationLease({ dshHome, mode: 'authenticated' })
    expect(control.rmdirCalls).toBe(1)
    await lease.release()
  })

  it.each(['ENOTEMPTY', 'EPERM'])('retries a vacant lease cleanup reporting %s once', async (code) => {
    const dshHome = await homeWithVacantLease()
    // A competitor holds the empty lease root: publication is denied and the
    // owner read finds nobody, which is the vacant-cleanup path.
    control.renameCode = 'EEXIST'
    control.renameCount = 1
    control.rmdirCode = code
    control.rmdirCount = 1

    const lease = await acquireAuthenticationLease({ dshHome, mode: 'authenticated' })
    expect(control.rmdirCalls).toBe(1)
    await lease.release()
  })

  it('propagates a cleanup failure that is not contention', async () => {
    const dshHome = await homeWithStaleOwner()
    control.rmdirCode = 'EIO'

    await expect(acquireAuthenticationLease({ dshHome, mode: 'authenticated' }))
      .rejects.toMatchObject({ code: 'EIO' })
  })

  it('bounds acquisition when neither publication nor cleanup can win', async () => {
    const dshHome = await homeWithStaleOwner()
    control.renameCode = 'EEXIST'
    control.rmdirCode = 'EPERM'

    // Endless contention must fail loudly rather than spin forever.
    await expect(acquireAuthenticationLease({ dshHome, mode: 'authenticated' }))
      .rejects.toThrow(/could not acquire the instance lease in 64 attempts/)
    expect(control.rmdirCalls).toBeGreaterThan(1)
  })

  it('treats a lease that disappears during cleanup as removed', async () => {
    const dshHome = await homeWithStaleOwner()
    control.rmdirCode = 'ENOENT'
    control.rmdirCount = 1

    const lease = await acquireAuthenticationLease({ dshHome, mode: 'authenticated' })
    await lease.release()
  })

  it('retries when the whole lease disappears between publication and the owner read', async () => {
    const dshHome = await homeWithStaleOwner()
    const root = join(dshHome, 'runtime', LEASE_LEAF)
    control.renameCode = 'EEXIST'
    control.renameCount = 1
    // The competitor finishes its own cleanup first, so the owner read misses.
    control.onRenameFailure = async () => { await rm(root, { recursive: true, force: true }) }

    const lease = await acquireAuthenticationLease({ dshHome, mode: 'authenticated' })
    await lease.release()
  })

  it('propagates a publication failure that is not contention', async () => {
    const dshHome = await homeWithVacantLease()
    control.renameCode = 'EIO'

    await expect(acquireAuthenticationLease({ dshHome, mode: 'authenticated' }))
      .rejects.toMatchObject({ code: 'EIO' })
  })
})

describe('instance lease integrity', () => {
  /** A DSH home whose lease directory holds exactly the supplied entries. */
  async function homeWithLeaseEntries(entries: Record<string, string>): Promise<string> {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-lease-shape-'))
    homes.push(dshHome)
    const root = join(dshHome, 'runtime', LEASE_LEAF)
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const [name, body] of Object.entries(entries)) {
      await writeFile(join(root, name), body, { mode: 0o600 })
    }
    return dshHome
  }

  const NONCE = '2'.repeat(32)
  const owner = (overrides: Record<string, unknown> = {}): string => `${JSON.stringify({
    version: 1,
    mode: 'authenticated',
    pid: 2_147_483_647,
    nonce: NONCE,
    startedAt: new Date().toISOString(),
    ...overrides,
  })}\n`

  it('rejects a lease directory holding more than one entry', async () => {
    const dshHome = await homeWithLeaseEntries({
      [`owner-${NONCE}.json`]: owner(),
      'owner-extra.json': owner(),
    })

    await expect(acquireAuthenticationLease({ dshHome, mode: 'authenticated' }))
      .rejects.toThrow(/invalid instance lease/)
  })

  it('rejects an owner document whose filename does not match its nonce', async () => {
    const dshHome = await homeWithLeaseEntries({ [`owner-${'3'.repeat(32)}.json`]: owner() })

    await expect(acquireAuthenticationLease({ dshHome, mode: 'authenticated' }))
      .rejects.toThrow(/invalid instance lease/)
  })

  it.each([
    ['a non-object document', '[]\n'],
    ['an unknown version', JSON.stringify({ version: 2 })],
    ['an unknown mode', owner({ mode: 'other' })],
    ['a fractional pid', owner({ pid: 1.5 })],
    ['a non-positive pid', owner({ pid: 0 })],
    ['a non-string nonce', owner({ nonce: 1 })],
    ['a non-string start time', owner({ startedAt: 1 })],
  ])('rejects %s', async (_label, body) => {
    const dshHome = await homeWithLeaseEntries({ [`owner-${NONCE}.json`]: body })

    await expect(acquireAuthenticationLease({ dshHome, mode: 'authenticated' }))
      .rejects.toThrow(/invalid instance lease/)
  })
})

describe('instance lease release', () => {
  it('is idempotent', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-lease-release-'))
    homes.push(dshHome)
    const lease = await acquireAuthenticationLease({ dshHome, mode: 'authenticated' })

    await lease.release()
    await expect(lease.release()).resolves.toBeUndefined()
  })

  it('refuses to release a lease whose owner disappeared', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-lease-gone-'))
    homes.push(dshHome)
    const lease = await acquireAuthenticationLease({ dshHome, mode: 'authenticated' })
    const root = join(dshHome, 'runtime', LEASE_LEAF)
    await rm(join(root, (await readdir(root))[0] ?? ''), { force: true })

    await expect(lease.release()).rejects.toThrow(/owner disappeared before release/)
  })

  it('refuses to release a lease another process owns', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-lease-foreign-'))
    homes.push(dshHome)
    const lease = await acquireAuthenticationLease({ dshHome, mode: 'authenticated' })
    const root = join(dshHome, 'runtime', LEASE_LEAF)
    await rm(join(root, (await readdir(root))[0] ?? ''), { force: true })
    const foreign = '4'.repeat(32)
    await writeFile(join(root, `owner-${foreign}.json`), `${JSON.stringify({
      version: 1,
      mode: 'authenticated',
      pid: process.pid,
      nonce: foreign,
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })

    await expect(lease.release()).rejects.toThrow(/owned by another process/)
  })
})
