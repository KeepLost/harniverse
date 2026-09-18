/** Invitation issue, redemption, and same-key enrollment replacement. */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  approveEnrollmentRequest,
  createEnrollmentRequest,
  getEnrollmentStatus,
  grantRegistryPath,
  InvitationRedeemError,
  issueEnrollmentInvitation,
  listAuthenticationGrants,
  listEnrollmentInvitations,
  listEnrollmentRequests,
  parseGrantRegistry,
  redeemEnrollmentInvitation,
  revokeEnrollmentInvitation,
} from '../src/grant-registry.ts'
import { accessLogPath } from '../src/access-log.ts'
import { writePrivateFile } from '../src/private-files.ts'

const OWNER_CAPS = ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'] as const

const homes: string[] = []

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-invitation-registry-'))
  homes.push(value)
  return value
}

function publicKey(): string {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

function token(): string {
  return `dshi1_${'x'.repeat(27)}`
}

/** A DSH home whose registry already carries one active owner Grant. */
async function ownerHome(): Promise<string> {
  const dshHome = await home()
  const owner = await createEnrollmentRequest({ name: 'owner', kind: 'device', publicKey: publicKey() }, { dshHome })
  await approveEnrollmentRequest(owner.id, { capabilities: [...OWNER_CAPS] }, { dshHome })
  return dshHome
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('enrollment invitation issue', () => {
  it('issues a one-time invitation whose secret exists only outside the registry', async () => {
    const dshHome = await home()
    const issued = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS,
      kind: 'device',
      ttlMs: 60 * 60_000,
    }, { dshHome })

    expect(issued.token).toMatch(/^dshi1_[A-Za-z0-9_-]{27}$/)
    const listed = await listEnrollmentInvitations({ dshHome })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: issued.id,
      kind: 'device',
      state: 'active',
      capabilities: [...OWNER_CAPS],
    })
    expect(listed[0] !== undefined && 'codeHash' in listed[0]).toBe(false)
    const document = await readFile(grantRegistryPath(dshHome), 'utf8')
    expect(document).not.toContain(issued.token)
    expect((JSON.parse(document) as { invitations: unknown[] }).invitations).toHaveLength(1)
  })

  it('rejects a non-positive or fractional lifetime before touching the registry', async () => {
    const dshHome = await home()
    await expect(issueEnrollmentInvitation({ capabilities: ['harniverse.observe'], kind: 'device', ttlMs: 0 }, { dshHome }))
      .rejects.toThrow(/ttlMs must be a positive integer/)
    await expect(issueEnrollmentInvitation({ capabilities: ['harniverse.observe'], kind: 'device', ttlMs: 1.5 }, { dshHome }))
      .rejects.toThrow(/ttlMs must be a positive integer/)
    await expect(issueEnrollmentInvitation(
      { capabilities: ['harniverse.observe'], kind: 'device', ttlMs: 60_000 },
      { dshHome, maxActiveInvitations: 0 },
    )).rejects.toThrow(/maxActiveInvitations must be a positive integer/)
  })

  it('requires a bounded lifetime and enforces the active-invitation bound', async () => {
    const dshHome = await home()
    await expect(issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 7 * 24 * 3600_000 + 1,
    }, { dshHome })).rejects.toThrow(/cannot exceed 7 days/)
    await expect(issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 0,
    }, { dshHome })).rejects.toThrow(/positive integer/)

    await issueEnrollmentInvitation({ capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000 }, { dshHome, maxActiveInvitations: 1 })
    await expect(issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome, maxActiveInvitations: 1 })).rejects.toThrow(/active invitation capacity is full/)
  })

  it('refuses invitations a sealed registry cannot admit', async () => {
    const dshHome = await home()
    await expect(issueEnrollmentInvitation({
      capabilities: ['harniverse.observe'], kind: 'device', ttlMs: 60_000,
    }, { dshHome })).rejects.toThrow(/first active Grant must authorize/)
    await expect(issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'temporary', ttlMs: 60_000,
    }, { dshHome })).rejects.toThrow(/temporary invitation cannot authorize/)
  })

  it('prunes retained invitations once they are long expired or used', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const startedAt = new Date('2026-09-18T00:00:00.000Z')
    vi.setSystemTime(startedAt)
    const dshHome = await home()
    const used = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    const request = await createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome })
    await redeemEnrollmentInvitation(request.id, used.token, { dshHome })
    vi.setSystemTime(new Date(startedAt.getTime() + 8 * 24 * 3600_000))

    await issueEnrollmentInvitation({ capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000 }, { dshHome })
    const listed = await listEnrollmentInvitations({ dshHome })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.state).toBe('active')
  })

  it('revokes an unused invitation so it can no longer be redeemed', async () => {
    const dshHome = await home()
    const issued = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    await revokeEnrollmentInvitation(issued.id, { dshHome })
    expect(await listEnrollmentInvitations({ dshHome })).toHaveLength(0)

    const request = await createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome })
    await expect(redeemEnrollmentInvitation(request.id, issued.token, { dshHome })).rejects.toBeInstanceOf(InvitationRedeemError)
    await expect(redeemEnrollmentInvitation(request.id, issued.token, { dshHome })).rejects.toMatchObject({ reason: 'invalid-invitation' })
  })
})

describe('enrollment invitation redemption', () => {
  it('redeems a device invitation into an approved enrollment exactly once', async () => {
    const dshHome = await ownerHome()
    const issued = await issueEnrollmentInvitation({
      capabilities: ['harniverse.observe', 'harniverse.operate'], kind: 'device', ttlMs: 60 * 60_000,
    }, { dshHome })
    const request = await createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome })

    const receipt = await redeemEnrollmentInvitation(request.id, issued.token, { dshHome })
    expect(receipt).toMatchObject({ state: 'approved', id: request.id, capabilities: ['harniverse.observe', 'harniverse.operate'] })
    expect(await getEnrollmentStatus(request.id, { dshHome })).toMatchObject({ state: 'approved' })
    const grants = await listAuthenticationGrants({ dshHome })
    expect(grants).toHaveLength(2)
    expect(grants.find(grant => grant.name === 'phone')).toMatchObject({
      kind: 'device', capabilities: ['harniverse.observe', 'harniverse.operate'],
    })
    expect((await listEnrollmentInvitations({ dshHome }))[0]).toMatchObject({ state: 'used', usedByName: 'phone' })

    // Replaying the settled enrollment finds nothing pending; a fresh
    // enrollment cannot reuse the consumed invitation token.
    await expect(redeemEnrollmentInvitation(request.id, issued.token, { dshHome })).rejects.toMatchObject({ reason: 'not-found' })
    const replay = await createEnrollmentRequest({
      name: 'replay', kind: 'device', publicKey: publicKey(),
    }, { dshHome })
    await expect(redeemEnrollmentInvitation(replay.id, issued.token, { dshHome })).rejects.toMatchObject({ reason: 'invalid-invitation' })
    const log = await readFile(accessLogPath(dshHome), 'utf8')
    expect(log).toContain('invitation-issued')
    expect(log).toContain('invitation-redeemed')
  })

  it('applies temporary lifetime rules when redeeming a temporary invitation', async () => {
    const dshHome = await ownerHome()
    const issued = await issueEnrollmentInvitation({
      capabilities: ['harniverse.observe'], kind: 'temporary', ttlMs: 60 * 60_000,
    }, { dshHome })
    const request = await createEnrollmentRequest({
      name: 'kiosk', kind: 'temporary', publicKey: publicKey(),
    }, { dshHome })

    await redeemEnrollmentInvitation(request.id, issued.token, { dshHome })
    const [grant] = await listAuthenticationGrants({ dshHome })
    expect(grant).toMatchObject({ kind: 'temporary', idleTimeoutMs: 15 * 60_000 })
    expect(grant?.expiresAt !== undefined
      && Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(60 * 60_000)
  })

  it('rejects an out-of-bounds receipt lifetime before touching the registry', async () => {
    const dshHome = await home()
    const issued = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    const request = await createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome })
    await expect(redeemEnrollmentInvitation(request.id, issued.token, { dshHome, enrollmentTtlMs: 15 * 60_000 + 1 }))
      .rejects.toThrow(/enrollmentTtlMs must be between 1 millisecond and 15 minutes/)
  })

  it('rejects expired invitations, expired enrollments, and kind or binding mismatches', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const startedAt = new Date('2026-09-18T00:00:00.000Z')
    vi.setSystemTime(startedAt)
    const dshHome = await home()
    const used = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    const request = await createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome, enrollmentTtlMs: 120_000 })
    vi.setSystemTime(new Date(startedAt.getTime() + 90_000))
    await expect(redeemEnrollmentInvitation(request.id, used.token, { dshHome })).rejects.toMatchObject({ reason: 'invalid-invitation' })

    vi.setSystemTime(new Date(startedAt.getTime() + 121_000))
    const fresh = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    await expect(redeemEnrollmentInvitation(request.id, fresh.token, { dshHome })).rejects.toMatchObject({ reason: 'not-found' })

    vi.setSystemTime(new Date(startedAt.getTime() + 121_000))
    const deviceRequest = await createEnrollmentRequest({
      name: 'laptop', kind: 'temporary', publicKey: publicKey(),
    }, { dshHome })
    await expect(redeemEnrollmentInvitation(deviceRequest.id, fresh.token, { dshHome })).rejects.toMatchObject({
      reason: 'invitation-kind', expected: 'device',
    })

    const bound = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000, bindName: 'Alice 笔记本',
    }, { dshHome })
    const stranger = await createEnrollmentRequest({
      name: 'other', kind: 'device', publicKey: publicKey(),
    }, { dshHome })
    await expect(redeemEnrollmentInvitation(stranger.id, bound.token, { dshHome })).rejects.toMatchObject({ reason: 'invitation-name' })
    const alice = await createEnrollmentRequest({
      name: 'Alice 笔记本', kind: 'device', publicKey: publicKey(),
    }, { dshHome })
    await expect(redeemEnrollmentInvitation(alice.id, bound.token, { dshHome })).resolves.toMatchObject({ state: 'approved' })
  })

  it('rejects malformed invitation tokens without consulting the registry', async () => {
    const dshHome = await home()
    const request = await createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome })
    await expect(redeemEnrollmentInvitation(request.id, 'dshi1_short', { dshHome })).rejects.toMatchObject({ reason: 'invalid-invitation' })
    await expect(redeemEnrollmentInvitation(request.id, token(), { dshHome })).rejects.toMatchObject({ reason: 'invalid-invitation' })
  })

  it('lets an authorizing invitation bootstrap a sealed registry', async () => {
    const dshHome = await home()
    const issued = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60 * 60_000,
    }, { dshHome })
    const request = await createEnrollmentRequest({
      name: 'first-owner', kind: 'device', publicKey: publicKey(),
    }, { dshHome })

    await expect(redeemEnrollmentInvitation(request.id, issued.token, { dshHome })).resolves.toMatchObject({ state: 'approved' })
    expect((await listAuthenticationGrants({ dshHome }))[0]).toMatchObject({ capabilities: [...OWNER_CAPS] })
  })
})

describe('same-key pending enrollment replacement', () => {
  it('replaces the previous pending request from the same browser key', async () => {
    const dshHome = await home()
    const key = publicKey()
    const first = await createEnrollmentRequest({ name: 'first', kind: 'device', publicKey: key }, { dshHome })
    const second = await createEnrollmentRequest({ name: 'second', kind: 'device', publicKey: key }, { dshHome })

    const pending = await listEnrollmentRequests({ dshHome })
    expect(pending.map(request => request.name)).toEqual(['second'])
    expect(pending[0]?.id).toBe(second.id)
    expect(await getEnrollmentStatus(first.id, { dshHome })).toBeUndefined()

    const renamed = await createEnrollmentRequest({ name: 'second', kind: 'temporary', publicKey: key }, { dshHome })
    expect((await listEnrollmentRequests({ dshHome })).map(request => [request.name, request.kind]))
      .toEqual([['second', 'temporary']])
    expect(renamed.id).not.toBe(second.id)
    const log = await readFile(accessLogPath(dshHome), 'utf8')
    expect(log).toContain('superseded')
  })

  it('still rejects the same name from a different key', async () => {
    const dshHome = await home()
    await createEnrollmentRequest({ name: 'phone', kind: 'device', publicKey: publicKey() }, { dshHome })
    await expect(createEnrollmentRequest({
      name: 'phone', kind: 'device', publicKey: publicKey(),
    }, { dshHome })).rejects.toMatchObject({ name: 'EnrollmentRequestInputError' })
  })
})

describe('invitation registry parsing', () => {
  function registryDocument(invitations: unknown): string {
    return `${JSON.stringify({
      version: 1,
      instanceId: 'aaaaaaaaaaaaaaaaaaaaaa',
      grants: [],
      enrollments: [],
      invitations,
    })}\n`
  }

  function activeInvitation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'Aa0123456789abcd',
      codeHash: 'A'.repeat(43),
      capabilities: ['harniverse.observe'],
      kind: 'device',
      createdAt: '2026-09-18T00:00:00.000Z',
      expiresAt: '2026-09-19T00:00:00.000Z',
      state: 'active',
      ...overrides,
    }
  }

  it('accepts a registry without invitations and reads it as empty', async () => {
    const dshHome = await home()
    expect(parseGrantRegistry(registryDocument(undefined)).invitations).toEqual([])
    await writePrivateFile(grantRegistryPath(dshHome), '{"version":1,"instanceId":"aaaaaaaaaaaaaaaaaaaaaa","grants":[],"enrollments":[]}\n')
    expect(await listEnrollmentInvitations({ dshHome })).toEqual([])
  })

  it('rejects malformed invitation records', () => {
    expect(() => parseGrantRegistry(registryDocument(['not-an-object']))).toThrow(/must be an object/)
    expect(() => parseGrantRegistry(registryDocument([['nested']]))).toThrow(/must be an object/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ id: 'short' })]))).toThrow(/invalid id/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ kind: 'visitor' })]))).toThrow(/invalid kind/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ state: 'expired' })]))).toThrow(/invalid state/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ codeHash: 'short' })]))).toThrow(/code hash/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ kind: 'temporary', capabilities: ['harniverse.authorize'] })])))
      .toThrow(/temporary invitation cannot authorize/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ createdAt: '2027-09-18T00:00:00.000Z' })]))).toThrow(/too far in the future/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ expiresAt: '2026-09-17T00:00:00.000Z' })]))).toThrow(/expiry must follow creation/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ usedByName: 'phone' })]))).toThrow(/unexpected fields/)
  })

  it('rejects a non-list invitations field', () => {
    expect(() => parseGrantRegistry(registryDocument({ folded: true }))).toThrow(/lists are invalid/)
  })

  it('rejects duplicate invitation ids or code hashes', () => {
    expect(() => parseGrantRegistry(registryDocument([activeInvitation(), activeInvitation({ id: 'Bb0123456789abcf' })])))
      .toThrow(/duplicate/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation(), activeInvitation({ codeHash: 'C'.repeat(43) })])))
      .toThrow(/duplicate/)
  })

  it('validates used invitations carry complete consumption facts', () => {
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ state: 'used', usedAt: '2026-09-18T01:00:00.000Z' })])))
      .toThrow(/unexpected fields/)
    expect(() => parseGrantRegistry(registryDocument([activeInvitation({ state: 'used', usedAt: '2099-09-18T01:00:00.000Z', usedByName: 'phone' })])))
      .toThrow(/outside its lifetime/)
  })
})
