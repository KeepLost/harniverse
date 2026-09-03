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

  it('accepts a human-readable Unicode device name', async () => {
    const dshHome = await home()
    const request = await createEnrollmentRequest({
      name: '我的设备',
      kind: 'device',
      publicKey: publicKey(),
    }, { dshHome })

    expect(request.name).toBe('我的设备')
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

describe('durable Grant registry integrity', () => {
  /** One valid registry document with an owner Grant and a pending enrollment. */
  async function baselineDocument(): Promise<{
    dshHome: string
    document: {
      version: number
      instanceId: string
      grants: Array<Record<string, unknown>>
      enrollments: Array<Record<string, unknown>>
    }
  }> {
    const dshHome = await home()
    const owner = await createEnrollmentRequest({ name: 'owner', kind: 'device', publicKey: publicKey() }, { dshHome })
    await approveEnrollmentRequest(owner.id, {
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
    }, { dshHome })
    await createEnrollmentRequest({ name: 'pending-device', kind: 'device', publicKey: publicKey() }, { dshHome })
    return {
      dshHome,
      document: JSON.parse(await readFile(grantRegistryPath(dshHome), 'utf8')) as never,
    }
  }

  it.each([
    ['a non-object document', () => '[]', /Grant registry must be an object/],
    ['a null document', () => 'null', /Grant registry must be an object/],
  ])('rejects %s', async (_label, text, message) => {
    expect(() => parseGrantRegistry(text())).toThrow(message)
  })

  it('rejects a document whose envelope is wrong', async () => {
    const { document } = await baselineDocument()
    const cases: Array<[(doc: typeof document) => void, RegExp]> = [
      [(doc) => { Reflect.deleteProperty(doc, 'enrollments') }, /Grant registry has unexpected fields/],
      [(doc) => { (doc as Record<string, unknown>).extra = 1 }, /Grant registry has unexpected fields/],
      [(doc) => { doc.version = 99 }, /unsupported Grant registry version/],
      [(doc) => { doc.instanceId = 'too-short' }, /invalid instance id/],
      [(doc) => { (doc as Record<string, unknown>).instanceId = 7 }, /invalid instance id/],
      [(doc) => { (doc as Record<string, unknown>).grants = {} }, /Grant registry lists are invalid/],
      [(doc) => { (doc as Record<string, unknown>).enrollments = {} }, /Grant registry lists are invalid/],
    ]
    for (const [mutate, message] of cases) {
      const candidate = structuredClone(document)
      mutate(candidate)
      expect(() => parseGrantRegistry(JSON.stringify(candidate))).toThrow(message)
    }
  })

  it('rejects a Grant entry whose shape or fields are wrong', async () => {
    const { document } = await baselineDocument()
    const cases: Array<[unknown, RegExp]> = [
      ['not-an-object', /Grant 0 must be an object/],
      [null, /Grant 0 must be an object/],
      [[], /Grant 0 must be an object/],
      [{ ...document.grants[0], id: 'nope!' }, /Grant 0 has an invalid id/],
      [{ ...document.grants[0], id: 7 }, /Grant 0 has an invalid id/],
      [{ ...document.grants[0], kind: 'robot' }, /Grant 0 has an invalid kind/],
      [{ ...document.grants[0], revision: 0 }, /Grant 0 revision must be a positive integer/],
      [{ ...document.grants[0], revision: 1.5 }, /Grant 0 revision must be a positive integer/],
      [{ ...document.grants[0], createdAt: 'yesterday' }, /Grant 0 createdAt must be an ISO timestamp/],
      [{ ...document.grants[0], createdAt: '2026-08-17T00:00:00+00:00' }, /Grant 0 createdAt must be an ISO timestamp/],
      [{ ...document.grants[0], name: ' padded' }, /Grant name must contain/],
      [{ ...document.grants[0], name: '' }, /Grant name must contain/],
      [{ ...document.grants[0], name: 7 }, /Grant name must contain/],
      [{ ...document.grants[0], capabilities: [] }, /non-empty supported list/],
      [{ ...document.grants[0], capabilities: 'harniverse.observe' }, /non-empty supported list/],
      [{ ...document.grants[0], capabilities: ['harniverse.nope'] }, /non-empty supported list/],
      [
        { ...document.grants[0], capabilities: ['harniverse.observe', 'harniverse.observe'] },
        /must not contain duplicates/,
      ],
    ]
    for (const [grant, message] of cases) {
      const candidate = structuredClone(document)
      candidate.grants[0] = grant as Record<string, unknown>
      expect(() => parseGrantRegistry(JSON.stringify(candidate))).toThrow(message)
    }
  })

  it('rejects a Grant carrying an unusable public key', async () => {
    const { document } = await baselineDocument()
    const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    for (const key of ['short', 'x'.repeat(600), '_'.repeat(120), wrongCurve, 7]) {
      const candidate = structuredClone(document)
      candidate.grants[0] = { ...document.grants[0], publicKey: key }
      expect(() => parseGrantRegistry(JSON.stringify(candidate)))
        .toThrow(/public key must be a base64url P-256 SPKI key/)
    }
  })

  it('rejects an enrollment entry whose shape or fields are wrong', async () => {
    const { document } = await baselineDocument()
    // The approved owner receipt also lives here, so select the pending row.
    const index = document.enrollments.findIndex(entry => entry.state === 'pending')
    const pending = document.enrollments[index]
    if (pending === undefined) throw new Error('expected pending enrollment')
    const label = `enrollment ${String(index)}`
    const cases: Array<[unknown, RegExp]> = [
      ['not-an-object', new RegExp(`${label} must be an object`)],
      [null, new RegExp(`${label} must be an object`)],
      [[], new RegExp(`${label} must be an object`)],
      [{ ...pending, id: 'nope!' }, new RegExp(`${label} has an invalid id`)],
      [{ ...pending, id: 7 }, new RegExp(`${label} has an invalid id`)],
      [{ ...pending, approvalCode: 'lowercase' }, new RegExp(`${label} has an invalid approval code`)],
      [{ ...pending, approvalCode: 7 }, new RegExp(`${label} has an invalid approval code`)],
      [{ ...pending, kind: 'api-client' }, new RegExp(`${label} has an invalid kind`)],
      [{ ...pending, state: 'revoked' }, new RegExp(`${label} has an invalid state`)],
      [{ ...pending, extra: true }, new RegExp(`${label} has unexpected fields`)],
    ]
    for (const enrollment of cases) {
      const candidate = structuredClone(document)
      candidate.enrollments[index] = enrollment[0] as Record<string, unknown>
      expect(() => parseGrantRegistry(JSON.stringify(candidate))).toThrow(enrollment[1])
    }
  })

  it('rejects an approved enrollment receipt whose fields are wrong', async () => {
    const { document } = await baselineDocument()
    const approved = {
      id: 'aaaaaaaaaaaaaaaa',
      state: 'approved',
      grantId: 'bbbbbbbbbbbbbbbb',
      grantRevision: 1,
      capabilities: ['harniverse.observe'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const accepted = structuredClone(document)
    accepted.enrollments = [approved as never]
    expect(() => parseGrantRegistry(JSON.stringify(accepted))).not.toThrow()

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...approved, grantId: 'nope!' }, /invalid Grant id/],
      [{ ...approved, grantId: 7 }, /invalid Grant id/],
      [{ ...approved, grantRevision: 0 }, /Grant revision must be a positive integer/],
      [{ ...approved, capabilities: [] }, /non-empty supported list/],
      [{ ...approved, expiresAt: 'soon' }, /expiresAt must be an ISO timestamp/],
      [{ ...approved, extra: 1 }, /enrollment 0 has unexpected fields/],
    ]
    for (const [enrollment, message] of cases) {
      const candidate = structuredClone(document)
      candidate.enrollments = [enrollment as never]
      expect(() => parseGrantRegistry(JSON.stringify(candidate))).toThrow(message)
    }
  })

  it('rejects duplicate ids across Grants and enrollments', async () => {
    const { document } = await baselineDocument()
    const duplicateId = structuredClone(document)
    const grant = duplicateId.grants[0]
    const enrollment = duplicateId.enrollments[0]
    if (grant === undefined || enrollment === undefined) throw new Error('expected baseline entries')
    // One id namespace spans both lists, so an enrollment cannot shadow a Grant.
    duplicateId.enrollments[0] = { ...enrollment, id: grant.id }
    expect(() => parseGrantRegistry(JSON.stringify(duplicateId)))
      .toThrow(/duplicate Grant or enrollment id/)
  })

  it('rejects a duplicate name across Grants and enrollments', async () => {
    const { document } = await baselineDocument()
    const duplicateName = structuredClone(document)
    const grant = duplicateName.grants[0]
    const enrollment = duplicateName.enrollments.find(entry => entry.state === 'pending')
    if (grant === undefined || enrollment === undefined) throw new Error('expected baseline entries')
    // One name namespace spans both lists, so a pending request cannot claim
    // the name a committed Grant already holds.
    duplicateName.enrollments = duplicateName.enrollments.map(entry =>
      entry === enrollment ? { ...entry, name: grant.name } : entry)
    expect(() => parseGrantRegistry(JSON.stringify(duplicateName)))
      .toThrow(/duplicate Grant name/)
  })

  it('rejects a stored temporary Grant carrying authority', async () => {
    const { document } = await baselineDocument()
    const escalated = structuredClone(document)
    const grant = escalated.grants[0]
    if (grant === undefined) throw new Error('expected baseline Grant')
    // The approval path refuses this, and so must every later read: a stored
    // document is not trusted to have been written by this version.
    escalated.grants[0] = { ...grant, kind: 'temporary' }
    expect(() => parseGrantRegistry(JSON.stringify(escalated)))
      .toThrow(/temporary Grant cannot authorize/)
  })
})
