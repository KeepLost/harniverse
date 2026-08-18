import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  approveEnrollmentRequest,
  createAuthenticationClientGrant,
  createEnrollmentRequest,
  getEnrollmentStatus,
  grantRegistryPath,
  listAuthenticationGrants,
  listEnrollmentRequests,
  parseGrantRegistry,
  readGrantRegistry,
  revokeAuthenticationGrant,
} from '../src/grant-registry.ts'

const homes: string[] = []

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-grant-registry-'))
  homes.push(value)
  return value
}

function publicKey(): string {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('public-key Grant registry', () => {
  it('creates a pending device request and approves the first owner Grant', async () => {
    const dshHome = await home()
    const request = await createEnrollmentRequest({
      name: 'phone',
      kind: 'device',
      publicKey: publicKey(),
    }, { dshHome })

    expect(request).toMatchObject({ name: 'phone', kind: 'device', state: 'pending' })
    expect(request.id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{15}$/)
    expect(await listEnrollmentRequests({ dshHome })).toEqual([request])

    const grant = await approveEnrollmentRequest(request.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
    }, { dshHome })
    expect(grant).toMatchObject({
      name: 'phone',
      kind: 'device',
      revision: 1,
      capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
    })
    expect(grant.id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{15}$/)
    expect(await listEnrollmentRequests({ dshHome })).toEqual([])
    expect(await listAuthenticationGrants({ dshHome })).toEqual([grant])

    const document = await readFile(grantRegistryPath(dshHome), 'utf8')
    expect(document).toContain(request.publicKey)
    expect(document).not.toContain('PRIVATE KEY')
  })

  it('keeps a fresh bounded approval receipt after the pending deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const startedAt = new Date('2026-08-17T00:00:00.000Z')
    vi.setSystemTime(startedAt)
    const dshHome = await home()
    const request = await createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome, enrollmentTtlMs: 1_000 })
    vi.setSystemTime(new Date(startedAt.getTime() + 900))
    const grant = await approveEnrollmentRequest(request.id, {
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
    }, { dshHome, enrollmentTtlMs: 1_000 })
    vi.setSystemTime(new Date(startedAt.getTime() + 1_100))

    await expect(getEnrollmentStatus(request.id, { dshHome })).resolves.toMatchObject({
      state: 'approved', grantId: grant.id,
    })
  })

  it('supports temporary Grant limits and targeted revocation', async () => {
    const dshHome = await home()
    const owner = await createEnrollmentRequest({
      name: 'owner',
      kind: 'device',
      publicKey: publicKey(),
    }, { dshHome })
    await approveEnrollmentRequest(owner.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
    }, { dshHome })
    const request = await createEnrollmentRequest({
      name: 'public-computer',
      kind: 'temporary',
      publicKey: publicKey(),
    }, { dshHome })
    const grant = await approveEnrollmentRequest(request.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate'],
      expiresInMs: 60_000,
      idleTimeoutMs: 15_000,
    }, { dshHome })
    expect(grant.kind).toBe('temporary')
    expect(grant.expiresAt).toBeDefined()
    expect(grant.idleTimeoutMs).toBe(15_000)

    await revokeAuthenticationGrant(grant.id, { dshHome })
    expect(await listAuthenticationGrants({ dshHome })).toHaveLength(1)
  })

  it('requires the first active Grant to carry owner authority', async () => {
    const dshHome = await home()
    const observer = await createEnrollmentRequest({
      name: 'observer',
      kind: 'device',
      publicKey: publicKey(),
    }, { dshHome })

    await expect(approveEnrollmentRequest(observer.id, {
      capabilities: ['harniverse.observe'],
    }, { dshHome })).rejects.toThrow(/first active Grant must authorize/)

    await expect(createAuthenticationClientGrant({
      name: 'observer-client',
      publicKey: publicKey(),
      capabilities: ['harniverse.observe'],
    }, { dshHome })).rejects.toThrow(/first active Grant must authorize/)
  })

  it('rejects authorize on temporary Grants and rejects legacy token state', async () => {
    const dshHome = await home()
    const request = await createEnrollmentRequest({
      name: 'temporary',
      kind: 'temporary',
      publicKey: publicKey(),
    }, { dshHome })
    await expect(approveEnrollmentRequest(request.id, {
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
      expiresInMs: 60_000,
      idleTimeoutMs: 15_000,
    }, { dshHome })).rejects.toThrow(/temporary Grant cannot authorize/)

    const legacyHome = await home()
    await mkdir(join(legacyHome, 'auth'))
    await writeFile(join(legacyHome, 'auth', 'tokens.json'), '{}', { mode: 0o600 })
    await expect(readGrantRegistry({ dshHome: legacyHome })).rejects.toThrow(/tokens\.json is unsupported/)
  })

  it('rejects malformed public keys and duplicate names', async () => {
    const dshHome = await home()
    await expect(createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: 'not-a-key',
    }, { dshHome })).rejects.toThrow(/public key/)

    await createEnrollmentRequest({ name: 'phone', kind: 'device', publicKey: publicKey() }, { dshHome })
    await expect(createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome })).rejects.toThrow(/already exists/)
  })

  it('rejects enrollment lifetimes above the security ceiling', async () => {
    await expect(createEnrollmentRequest({
      name: 'slow-enrollment',
      kind: 'device',
      publicKey: publicKey(),
    }, { dshHome: await home(), enrollmentTtlMs: 15 * 60_000 + 1 }))
      .rejects.toThrow(/enrollmentTtlMs cannot exceed 15 minutes/)
  })

  it('bounds pending enrollments after pruning expired records', async () => {
    const dshHome = await home()
    for (const name of ['phone', 'tablet']) {
      await createEnrollmentRequest({ name, kind: 'device', publicKey: publicKey() }, {
        dshHome,
        maxPendingEnrollments: 2,
      })
    }

    await expect(createEnrollmentRequest({
      name: 'laptop', kind: 'device', publicKey: publicKey(),
    }, { dshHome, maxPendingEnrollments: 2 })).rejects.toThrow(/pending enrollment capacity/)
    expect(await listEnrollmentRequests({ dshHome })).toHaveLength(2)
  })

  it('rejects durable temporary Grants that bypass lifetime policy', async () => {
    const dshHome = await home()
    const owner = await createEnrollmentRequest({ name: 'owner', kind: 'device', publicKey: publicKey() }, { dshHome })
    await approveEnrollmentRequest(owner.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
    }, { dshHome })
    const temporary = await createEnrollmentRequest({ name: 'temporary', kind: 'temporary', publicKey: publicKey() }, { dshHome })
    await approveEnrollmentRequest(temporary.id, {
      capabilities: ['harniverse.observe', 'harniverse.operate'],
      expiresInMs: 60_000,
      idleTimeoutMs: 15_000,
    }, { dshHome })
    const baseline = JSON.parse(await readFile(grantRegistryPath(dshHome), 'utf8')) as {
      grants: Array<Record<string, unknown>>
    }
    const temporaryIndex = baseline.grants.findIndex(grant => grant.kind === 'temporary')
    if (temporaryIndex < 0) throw new Error('expected temporary Grant')

    for (const mutate of [
      (grant: Record<string, unknown>) => { Reflect.deleteProperty(grant, 'expiresAt') },
      (grant: Record<string, unknown>) => { Reflect.deleteProperty(grant, 'idleTimeoutMs') },
      (grant: Record<string, unknown>) => { grant.idleTimeoutMs = 15 * 60_000 + 1 },
      (grant: Record<string, unknown>) => {
        grant.expiresAt = new Date(Date.parse(String(grant.createdAt)) + 60 * 60_000 + 1).toISOString()
      },
    ]) {
      const document = structuredClone(baseline)
      mutate(document.grants[temporaryIndex]!)
      expect(() => parseGrantRegistry(JSON.stringify(document))).toThrow(/temporary Grant/)
    }
  })

  it('rejects contradictory or excessively future Grant timestamps', async () => {
    const dshHome = await home()
    const request = await createEnrollmentRequest({ name: 'owner', kind: 'device', publicKey: publicKey() }, { dshHome })
    await approveEnrollmentRequest(request.id, {
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
    }, { dshHome })
    const baseline = JSON.parse(await readFile(grantRegistryPath(dshHome), 'utf8')) as {
      grants: Array<Record<string, unknown>>
    }

    for (const mutate of [
      (grant: Record<string, unknown>) => { grant.expiresAt = grant.createdAt },
      (grant: Record<string, unknown>) => {
        grant.lastUsedAt = new Date(Date.parse(String(grant.createdAt)) - 1).toISOString()
      },
      (grant: Record<string, unknown>) => {
        grant.lastUsedAt = new Date(Date.now() + 5 * 60_000 + 1_000).toISOString()
      },
    ]) {
      const document = structuredClone(baseline)
      mutate(document.grants[0]!)
      expect(() => parseGrantRegistry(JSON.stringify(document))).toThrow(/Grant 0/)
    }
  })
})
