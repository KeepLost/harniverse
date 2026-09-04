/**
 * Grant management boundaries: the option and policy rejections every caller
 * must observe before a mutation reaches durable state, the legacy-registry
 * refusal, and the audit-failure rollback that keeps the registry and its
 * mandatory access record consistent.
 */

import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticationGrantId, type AuthenticationCapability } from '@deepseek-ai/dsh-authentication'
import type { AccessLogOptions, AccessRecord } from '../src/access-log.ts'

const audit = vi.hoisted(() => ({
  /** Error raised by the mandatory access record, or undefined to persist it. */
  error: undefined as Error | undefined,
  records: [] as AccessRecord[],
}))
const registryWrite = vi.hoisted(() => ({
  /** Registry writes that succeed before the rest fail, or undefined to allow all. */
  failAfter: undefined as number | undefined,
  error: undefined as Error | undefined,
  calls: 0,
}))

vi.mock('../src/private-files.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/private-files.ts')>()
  return {
    ...actual,
    writePrivateFile: async (...args: Parameters<typeof actual.writePrivateFile>): Promise<void> => {
      if (args[0].endsWith('grants.json')) {
        registryWrite.calls += 1
        if (registryWrite.failAfter !== undefined && registryWrite.calls > registryWrite.failAfter) {
          throw registryWrite.error ?? new Error('registry write blocked')
        }
      }
      await actual.writePrivateFile(...args)
    },
  }
})

vi.mock('../src/access-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/access-log.ts')>()
  return {
    ...actual,
    appendAccessRecord: async (record: AccessRecord, options?: AccessLogOptions): Promise<void> => {
      audit.records.push(record)
      if (audit.error !== undefined) throw audit.error
      await actual.appendAccessRecord(record, options)
    },
  }
})

const {
  approveEnrollmentRequest,
  authenticationGrantDeadline,
  createAuthenticationClientGrant,
  createEnrollmentRequest,
  consumeAuthenticationGrant,
  getEnrollmentStatus,
  grantRegistryPath,
  isAuthenticationGrantActive,
  listAuthenticationGrants,
  readGrantRegistry,
  revokeAuthenticationGrant,
} = await import('../src/grant-registry.ts')

const homes: string[] = []

afterEach(async () => {
  audit.error = undefined
  audit.records.length = 0
  registryWrite.failAfter = undefined
  registryWrite.error = undefined
  registryWrite.calls = 0
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-grant-boundary-'))
  homes.push(value)
  return value
}

function publicKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

const OWNER: readonly AuthenticationCapability[] = ['harniverse.observe', 'harniverse.authorize']

/** A home whose owner Grant already exists, so bootstrap is satisfied. */
async function ownedHome(): Promise<string> {
  const dshHome = await home()
  const request = await createEnrollmentRequest({ name: 'owner', kind: 'device', publicKey: publicKey() }, { dshHome })
  await approveEnrollmentRequest(request.id, { capabilities: OWNER }, { dshHome })
  return dshHome
}

describe('legacy registry refusal', () => {
  it('refuses to operate beside a legacy token registry', async () => {
    const dshHome = await home()
    const legacy = join(dshHome, 'auth', 'tokens.json')
    await mkdir(join(dshHome, 'auth'), { recursive: true, mode: 0o700 })
    await writeFile(legacy, '{"version":1,"tokens":[]}\n', { mode: 0o600 })

    // The named-token era is unsupported; the operator must remove it.
    await expect(readGrantRegistry({ dshHome })).rejects.toThrow(/legacy .* is unsupported/)
    await expect(listAuthenticationGrants({ dshHome })).rejects.toThrow(/legacy .* is unsupported/)
  })

  it.skipIf(process.platform === 'win32')('refuses a legacy registry exposed beyond its owner', async () => {
    const dshHome = await home()
    const legacy = join(dshHome, 'auth', 'tokens.json')
    await mkdir(join(dshHome, 'auth'), { recursive: true, mode: 0o700 })
    await writeFile(legacy, '{}\n', { mode: 0o600 })
    await chmod(legacy, 0o644)

    await expect(readGrantRegistry({ dshHome })).rejects.toThrow(/accessible beyond its owner/)
  })

  it('propagates a non-missing failure while probing the legacy registry', async () => {
    const dshHome = await home()
    // A directory in the legacy file's place is not a missing file.
    await mkdir(join(dshHome, 'auth', 'tokens.json'), { recursive: true, mode: 0o700 })

    await expect(readGrantRegistry({ dshHome })).rejects.toThrow()
  })
})

describe('enrollment request boundaries', () => {
  it.each([
    ['a zero lifetime', { enrollmentTtlMs: 0 }, /enrollmentTtlMs must be a positive integer/],
    ['a fractional lifetime', { enrollmentTtlMs: 1.5 }, /enrollmentTtlMs must be a positive integer/],
    ['a lifetime above the ceiling', { enrollmentTtlMs: 15 * 60_000 + 1 }, /enrollmentTtlMs cannot exceed 15 minutes/],
    ['a zero pending bound', { maxPendingEnrollments: 0 }, /maxPendingEnrollments must be a positive integer/],
    ['a fractional pending bound', { maxPendingEnrollments: 2.5 }, /maxPendingEnrollments must be a positive integer/],
  ])('refuses %s', async (_label, options, message) => {
    const dshHome = await home()
    await expect(createEnrollmentRequest(
      { name: 'device', kind: 'device', publicKey: publicKey() },
      { dshHome, ...options },
    )).rejects.toThrow(message)
  })
})

describe('approval boundaries', () => {
  it.each([
    ['a zero expiry', { expiresInMs: 0 }, /expiresInMs must be a positive integer/],
    ['a fractional expiry', { expiresInMs: 1.5 }, /expiresInMs must be a positive integer/],
    ['a zero idle timeout', { idleTimeoutMs: 0 }, /idleTimeoutMs must be a positive integer/],
    ['a fractional idle timeout', { idleTimeoutMs: 1.5 }, /idleTimeoutMs must be a positive integer/],
  ])('refuses %s', async (_label, approval, message) => {
    const dshHome = await ownedHome()
    const request = await createEnrollmentRequest({ name: 'device', kind: 'device', publicKey: publicKey() }, { dshHome })

    // Option validation is synchronous, before any promise exists.
    expect(() => approveEnrollmentRequest(request.id, {
      capabilities: ['harniverse.observe'],
      ...approval,
    }, { dshHome })).toThrow(message)
  })

  it.each([
    ['a zero receipt lifetime', 0],
    ['a receipt lifetime above the ceiling', 15 * 60_000 + 1],
  ])('refuses %s', async (_label, enrollmentTtlMs) => {
    const dshHome = await ownedHome()
    const request = await createEnrollmentRequest({ name: 'device', kind: 'device', publicKey: publicKey() }, { dshHome })

    expect(() => approveEnrollmentRequest(
      request.id,
      { capabilities: ['harniverse.observe'] },
      { dshHome, enrollmentTtlMs },
    )).toThrow(/enrollmentTtlMs must be between 1 millisecond and 15 minutes/)
  })

  it('refuses an unknown enrollment id', async () => {
    const dshHome = await ownedHome()
    await expect(approveEnrollmentRequest('aaaaaaaaaaaaaaaa', { capabilities: ['harniverse.observe'] }, { dshHome }))
      .rejects.toThrow(/does not exist or has expired/)
  })

  it('refuses an already approved enrollment', async () => {
    const dshHome = await ownedHome()
    const request = await createEnrollmentRequest({ name: 'device', kind: 'device', publicKey: publicKey() }, { dshHome })
    await approveEnrollmentRequest(request.id, { capabilities: ['harniverse.observe'] }, { dshHome })

    // The receipt survives, but approval is single-use.
    await expect(approveEnrollmentRequest(request.id, { capabilities: ['harniverse.observe'] }, { dshHome }))
      .rejects.toThrow(/does not exist or has expired/)
  })

  it.each([
    [
      'authority on a temporary Grant',
      { capabilities: ['harniverse.observe', 'harniverse.authorize'], expiresInMs: 60_000, idleTimeoutMs: 15_000 },
      /temporary Grant cannot authorize/,
    ],
    [
      'a temporary Grant with no expiry',
      { capabilities: ['harniverse.observe'], idleTimeoutMs: 15_000 },
      /temporary Grant requires expiry and idle timeout/,
    ],
    [
      'a temporary Grant with no idle timeout',
      { capabilities: ['harniverse.observe'], expiresInMs: 60_000 },
      /temporary Grant requires expiry and idle timeout/,
    ],
    [
      'a temporary lifetime above 60 minutes',
      { capabilities: ['harniverse.observe'], expiresInMs: 60 * 60_000 + 1, idleTimeoutMs: 15_000 },
      /temporary Grant cannot exceed 60 minutes/,
    ],
    [
      'a temporary idle timeout above 15 minutes',
      { capabilities: ['harniverse.observe'], expiresInMs: 60_000, idleTimeoutMs: 15 * 60_000 + 1 },
      /temporary Grant idle timeout cannot exceed 15 minutes/,
    ],
  ])('refuses %s', async (_label, approval, message) => {
    const dshHome = await ownedHome()
    const request = await createEnrollmentRequest({ name: 'temp', kind: 'temporary', publicKey: publicKey() }, { dshHome })

    await expect(approveEnrollmentRequest(request.id, approval as never, { dshHome })).rejects.toThrow(message)
  })
})

describe('API client Grant boundaries', () => {
  it.each([
    ['a zero expiry', { expiresInMs: 0 }],
    ['a fractional expiry', { expiresInMs: 1.5 }],
  ])('refuses %s', async (_label, extra) => {
    const dshHome = await ownedHome()
    await expect(createAuthenticationClientGrant({
      name: 'automation',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
      ...extra,
    }, { dshHome })).rejects.toThrow(/expiresInMs must be a positive integer/)
  })

  it('refuses a name already held by a Grant or a pending enrollment', async () => {
    const dshHome = await ownedHome()
    await expect(createAuthenticationClientGrant({
      name: 'owner',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
    }, { dshHome })).rejects.toThrow(/"owner" already exists/)

    await createEnrollmentRequest({ name: 'awaiting', kind: 'device', publicKey: publicKey() }, { dshHome })
    await expect(createAuthenticationClientGrant({
      name: 'awaiting',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
    }, { dshHome })).rejects.toThrow(/"awaiting" already exists/)
  })

  it('commits a bounded API client Grant', async () => {
    const dshHome = await ownedHome()
    const grant = await createAuthenticationClientGrant({
      name: 'automation',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
      expiresInMs: 60_000,
    }, { dshHome })

    expect(grant).toMatchObject({ kind: 'api-client', revision: 1, name: 'automation' })
    expect(grant.expiresAt).toBeDefined()
  })
})

describe('Grant exchange and revocation boundaries', () => {
  it('records a rejection for an unknown or superseded Grant revision', async () => {
    const dshHome = await ownedHome()
    const [owner] = await listAuthenticationGrants({ dshHome })
    if (owner === undefined) throw new Error('expected owner Grant')

    await expect(consumeAuthenticationGrant(owner.id, owner.revision + 1, { dshHome })).resolves.toBeUndefined()
    await expect(consumeAuthenticationGrant(authenticationGrantId('aaaaaaaaaaaaaaaa'), 1, { dshHome }))
      .resolves.toBeUndefined()
    expect(audit.records.filter(item => item.event === 'challenge-exchange-rejected')).toHaveLength(2)
  })

  it('records exchange activity only for a Grant with an idle bound', async () => {
    const dshHome = await ownedHome()
    const [owner] = await listAuthenticationGrants({ dshHome })
    if (owner === undefined) throw new Error('expected owner Grant')

    // A device Grant without an idle timeout has no activity to record.
    const consumed = await consumeAuthenticationGrant(owner.id, owner.revision, { dshHome })
    expect(consumed?.lastUsedAt).toBeUndefined()

    const temporary = await createEnrollmentRequest({ name: 'temp', kind: 'temporary', publicKey: publicKey() }, { dshHome })
    const grant = await approveEnrollmentRequest(temporary.id, {
      capabilities: ['harniverse.observe'],
      expiresInMs: 60_000,
      idleTimeoutMs: 15_000,
    }, { dshHome })
    const refreshed = await consumeAuthenticationGrant(grant.id, grant.revision, { dshHome })
    expect(refreshed?.lastUsedAt).toBeDefined()
  })

  it('refuses to revoke a Grant that does not exist', async () => {
    const dshHome = await ownedHome()
    await expect(revokeAuthenticationGrant(authenticationGrantId('aaaaaaaaaaaaaaaa'), { dshHome }))
      .rejects.toThrow(/authentication Grant does not exist/)
  })
})

describe('Grant listing and lifetime bounds', () => {
  it('lists Grants in stable name order', async () => {
    const dshHome = await ownedHome()
    for (const name of ['zeta', 'alpha']) {
      await createAuthenticationClientGrant({
        name,
        publicKey: publicKey(),
        capabilities: ['harniverse.observe'],
      }, { dshHome })
    }

    expect((await listAuthenticationGrants({ dshHome })).map(grant => grant.name))
      .toEqual(['alpha', 'owner', 'zeta'])
  })

  it('records the first idle window at approval time', async () => {
    const dshHome = await ownedHome()
    const request = await createEnrollmentRequest({ name: 'temp', kind: 'temporary', publicKey: publicKey() }, { dshHome })
    const grant = await approveEnrollmentRequest(request.id, {
      capabilities: ['harniverse.observe'],
      expiresInMs: 10 * 60_000,
      idleTimeoutMs: 15_000,
    }, { dshHome })

    // Approval seeds activity, so the idle bound is already anchored and is
    // the earlier of the two deadlines.
    expect(grant.lastUsedAt).toBe(grant.createdAt)
    expect(authenticationGrantDeadline(grant)).toBe(Date.parse(grant.createdAt) + 15_000)
    expect(isAuthenticationGrantActive(grant)).toBe(true)
    expect(isAuthenticationGrantActive(grant, Date.parse(grant.createdAt) + 15_001)).toBe(false)
  })

  it('measures an idle bound with no recorded use from creation', () => {
    // A stored Grant may carry an idle timeout without activity: lastUsedAt is
    // optional in the durable document.
    const createdAt = '2026-01-01T00:00:00.000Z'
    const deadline = authenticationGrantDeadline({
      id: authenticationGrantId('aaaaaaaaaaaaaaaa'),
      kind: 'temporary',
      name: 'stored',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
      revision: 1,
      createdAt,
      idleTimeoutMs: 15_000,
    } as never)

    expect(deadline).toBe(Date.parse(createdAt) + 15_000)
  })

  it('treats a Grant with no bounds as unbounded', () => {
    const deadline = authenticationGrantDeadline({
      id: authenticationGrantId('aaaaaaaaaaaaaaaa'),
      kind: 'device',
      name: 'unbounded',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never)

    expect(deadline).toBe(Number.POSITIVE_INFINITY)
  })

  it('treats an expired enrollment receipt as absent', async () => {
    const dshHome = await ownedHome()
    const request = await createEnrollmentRequest(
      { name: 'brief', kind: 'device', publicKey: publicKey() },
      { dshHome, enrollmentTtlMs: 1 },
    )
    await new Promise((resolve) => { setTimeout(resolve, 5) })

    // The record is still stored, but it is no longer observable and can no
    // longer be approved.
    await expect(getEnrollmentStatus(request.id, { dshHome })).resolves.toBeUndefined()
    await expect(approveEnrollmentRequest(request.id, { capabilities: ['harniverse.observe'] }, { dshHome }))
      .rejects.toThrow(/does not exist or has expired/)
  })

  it('reports a live enrollment receipt', async () => {
    const dshHome = await ownedHome()
    const request = await createEnrollmentRequest({ name: 'live', kind: 'device', publicKey: publicKey() }, { dshHome })

    await expect(getEnrollmentStatus(request.id, { dshHome }))
      .resolves.toMatchObject({ id: request.id, name: 'live', state: 'pending' })
    await expect(getEnrollmentStatus('aaaaaaaaaaaaaaaa' as never, { dshHome })).resolves.toBeUndefined()
  })
})

describe('audit failure rollback', () => {
  it('restores the previous registry when the mandatory access record fails', async () => {
    const dshHome = await ownedHome()
    const before = await readFile(grantRegistryPath(dshHome), 'utf8')
    audit.error = new Error('audit unavailable')

    await expect(createAuthenticationClientGrant({
      name: 'automation',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
    }, { dshHome })).rejects.toThrow(/audit unavailable/)

    // The mutation is not durable without its access record.
    expect(await readFile(grantRegistryPath(dshHome), 'utf8')).toBe(before)
    expect((await listAuthenticationGrants({ dshHome })).map(grant => grant.name)).toEqual(['owner'])
  })

  it('reports both failures when the rollback itself cannot complete', async () => {
    const dshHome = await ownedHome()
    audit.error = new Error('audit unavailable')
    // The mutation write succeeds; only the rollback write fails, so the
    // operator learns the registry no longer matches its access log.
    registryWrite.failAfter = 1
    registryWrite.error = new Error('rollback blocked')
    registryWrite.calls = 0

    const failure = await createAuthenticationClientGrant({
      name: 'automation',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
    }, { dshHome }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(String(failure)).toMatch(/rollback was incomplete/)
    expect((failure as AggregateError).errors.map(String)).toEqual([
      'Error: audit unavailable',
      'Error: rollback blocked',
    ])
  })
})
