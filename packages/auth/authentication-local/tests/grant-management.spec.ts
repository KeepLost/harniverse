/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */

/**
 * Authorized Grant management surface: the enrollment observation, approval,
 * listing, and revocation operations the Web manager and local CLI drive,
 * plus the configuration resolution that bounds them.
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticationGrantId, type AuthenticationEnrollmentId } from '@deepseek-ai/dsh-authentication'
import LocalAuthentication, { resolveSpec, type Config } from '../src/index.ts'
import { createEnrollmentRequest } from '../src/grant-registry.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-manage-'))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

async function boot(
  dshHome: string,
  mode: 'authenticated' | 'bypass' = 'authenticated',
  config: Partial<Config> = {},
): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, { ...config, dshHome, mode, watch: false })
  cleanups.push(() => fiber.dispose())
  await fiber
  return ctx
}

function publicKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

/** Enroll one device through the service and return its pending receipt. */
async function enroll(ctx: Context, name: string, kind: 'device' | 'temporary' = 'device') {
  const decision = await ctx.authentication.requestEnrollment({ name, kind, publicKey: publicKey() })
  if (decision.kind !== 'accepted') throw new Error(`enrollment refused: ${decision.reason}`)
  return decision.value
}

/**
 * Satisfy owner bootstrap: the first active Grant must carry authority, so
 * tests about later Grants approve an owner first.
 */
async function seedOwner(ctx: Context): Promise<string> {
  const request = await enroll(ctx, 'owner')
  const summary = await ctx.authentication.approveEnrollment(request.id, {
    capabilities: ['harniverse.observe', 'harniverse.authorize'],
  })
  return summary.id
}

describe('enrollment observation', () => {
  it('lists only pending requests with their approval codes', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    await seedOwner(ctx)
    const first = await enroll(ctx, 'alpha')
    const second = await enroll(ctx, 'beta', 'temporary')

    const pending = await ctx.authentication.listPendingEnrollments()
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'pending', id: first.id, name: 'alpha', kind: 'device' }),
      expect.objectContaining({ state: 'pending', id: second.id, name: 'beta', kind: 'temporary' }),
    ]))
    for (const request of pending) expect(request.approvalCode).toMatch(/\S/)

    // Approving one removes it from the pending view.
    await ctx.authentication.approveEnrollment(first.id, { capabilities: ['harniverse.observe'] })
    expect((await ctx.authentication.listPendingEnrollments()).map(item => item.id)).toEqual([second.id])
  })

  it('reports a pending status without leaking a Grant, and an approved status once committed', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    await seedOwner(ctx)
    const request = await enroll(ctx, 'device')

    await expect(ctx.authentication.enrollmentStatus(request.id)).resolves.toEqual({
      state: 'pending',
      id: request.id,
      approvalCode: request.approvalCode,
      name: 'device',
      kind: 'device',
      expiresAt: request.expiresAt,
    })

    await ctx.authentication.approveEnrollment(request.id, { capabilities: ['harniverse.observe'] })
    await expect(ctx.authentication.enrollmentStatus(request.id))
      .resolves.toMatchObject({ state: 'approved', id: request.id })
  })

  it('reports no status for an unknown enrollment id', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)

    await expect(ctx.authentication.enrollmentStatus('aaaaaaaaaaaaaaaa' as AuthenticationEnrollmentId))
      .resolves.toBeUndefined()
  })

  it('lists no pending request before any enrollment', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)

    await expect(ctx.authentication.listPendingEnrollments()).resolves.toEqual([])
  })
})

describe('Grant approval and listing', () => {
  it('summarizes an unbounded Grant without lifetime fields', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    const request = await enroll(ctx, 'device')

    const summary = await ctx.authentication.approveEnrollment(request.id, {
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
    })
    expect(summary).toEqual({
      id: expect.any(String),
      name: 'device',
      kind: 'device',
      revision: 1,
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
      createdAt: expect.any(String),
    })
    // A summary carries no key material.
    expect(JSON.stringify(summary)).not.toContain('publicKey')
  })

  it('summarizes a bounded Grant with its expiry, idle timeout, and activity', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    await seedOwner(ctx)
    const request = await enroll(ctx, 'temp', 'temporary')

    const summary = await ctx.authentication.approveEnrollment(request.id, {
      capabilities: ['harniverse.observe'],
      expiresInMs: 60_000,
      idleTimeoutMs: 15_000,
    })
    expect(summary).toMatchObject({
      name: 'temp',
      kind: 'temporary',
      idleTimeoutMs: 15_000,
      expiresAt: expect.any(String),
      lastUsedAt: expect.any(String),
    })
  })

  it('lists every committed Grant in stable name order', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    await seedOwner(ctx)
    for (const name of ['zeta', 'alpha']) {
      const request = await enroll(ctx, name)
      await ctx.authentication.approveEnrollment(request.id, { capabilities: ['harniverse.observe'] })
    }

    expect((await ctx.authentication.listGrants()).map(grant => grant.name)).toEqual(['alpha', 'owner', 'zeta'])
  })

  it('opens business admission as soon as an owner Grant exists', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    expect(await ctx.authentication.status()).toEqual({ mode: 'authenticated', sealed: true })

    const request = await enroll(ctx, 'owner')
    await ctx.authentication.approveEnrollment(request.id, {
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
    })

    // Approval refreshes the live view without an external filesystem event.
    expect(await ctx.authentication.status()).toEqual({ mode: 'authenticated', sealed: false })
  })

  it('refuses to approve an enrollment that never existed', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)

    await expect(ctx.authentication.approveEnrollment(
      'aaaaaaaaaaaaaaaa' as AuthenticationEnrollmentId,
      { capabilities: ['harniverse.observe'] },
    )).rejects.toThrow(/does not exist or has expired/)
  })
})

describe('Grant revocation', () => {
  it('removes a Grant from the listing and reseals when the last owner goes', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    const owner = await enroll(ctx, 'owner')
    const summary = await ctx.authentication.approveEnrollment(owner.id, {
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
    })
    expect(await ctx.authentication.status()).toMatchObject({ sealed: false })

    await ctx.authentication.revokeGrant(summary.id)
    expect(await ctx.authentication.listGrants()).toEqual([])
    expect(await ctx.authentication.status()).toMatchObject({ sealed: true })
  })

  it('refuses to revoke a Grant that does not exist', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)

    await expect(ctx.authentication.revokeGrant(authenticationGrantId('aaaaaaaaaaaaaaaa')))
      .rejects.toThrow(/authentication Grant does not exist/)
  })
})

describe('management in bypass mode', () => {
  it('refuses enrollment while still reading the durable registry', async () => {
    const dshHome = await home()
    // A registry may already exist from an authenticated run.
    await createEnrollmentRequest({ name: 'left-over', kind: 'device', publicKey: publicKey() }, { dshHome })
    const ctx = await boot(dshHome, 'bypass')

    await expect(ctx.authentication.requestEnrollment({
      name: 'device', kind: 'device', publicKey: publicKey(),
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    // Observation is not admission, so the stored request stays readable.
    expect((await ctx.authentication.listPendingEnrollments()).map(item => item.name)).toEqual(['left-over'])
    expect(await ctx.authentication.status()).toEqual({ mode: 'bypass', sealed: false })
  })
})

describe('configuration resolution', () => {
  it('derives per-Grant capacities from their global bounds', () => {
    const spec = resolveSpec({})
    expect(spec).toMatchObject({
      mode: 'authenticated',
      watch: true,
      maxAccessTokens: 4_096,
      maxAccessTokensPerGrant: 64,
      maxChallenges: 4_096,
      maxChallengesPerGrant: 16,
      maxBrowserSessions: 1_024,
      maxBrowserSessionsPerGrant: 16,
    })
    expect(spec.dshHome).toBeUndefined()
  })

  it('floors a per-Grant capacity at a smaller global bound', () => {
    expect(resolveSpec({ maxAccessTokens: 8 })).toMatchObject({
      maxAccessTokens: 8,
      maxAccessTokensPerGrant: 8,
    })
    expect(resolveSpec({ maxChallenges: 4 })).toMatchObject({ maxChallengesPerGrant: 4 })
    expect(resolveSpec({ maxBrowserSessions: 2 })).toMatchObject({ maxBrowserSessionsPerGrant: 2 })
  })

  it('accepts explicit per-Grant capacities within their global bounds', () => {
    expect(resolveSpec({
      maxAccessTokens: 100,
      maxAccessTokensPerGrant: 10,
      maxChallenges: 50,
      maxChallengesPerGrant: 5,
      maxBrowserSessions: 20,
      maxBrowserSessionsPerGrant: 2,
    })).toMatchObject({
      maxAccessTokensPerGrant: 10,
      maxChallengesPerGrant: 5,
      maxBrowserSessionsPerGrant: 2,
    })
  })

  it.each([
    ['maxChallenges', { maxChallenges: 2, maxChallengesPerGrant: 3 }],
    ['maxBrowserSessions', { maxBrowserSessions: 2, maxBrowserSessionsPerGrant: 3 }],
  ])('refuses a per-Grant capacity above its %s bound', (_label, config) => {
    expect(() => resolveSpec(config)).toThrow(/cannot exceed its global capacity/)
  })

  it.each([
    ['accessTokenTtlMs', { accessTokenTtlMs: 0 }],
    ['challengeTtlMs', { challengeTtlMs: 0 }],
    ['enrollmentTtlMs', { enrollmentTtlMs: 1.5 }],
    ['maxAccessTokens', { maxAccessTokens: 0 }],
    ['maxChallenges', { maxChallenges: 1.5 }],
    ['maxBrowserSessions', { maxBrowserSessions: 0 }],
    ['maxPendingEnrollments', { maxPendingEnrollments: 0 }],
    ['enrollmentRequestLimit', { enrollmentRequestLimit: 0 }],
    ['enrollmentRequestWindowMs', { enrollmentRequestWindowMs: 1.5 }],
    ['maxEnrollmentPeerKeys', { maxEnrollmentPeerKeys: 0 }],
    ['maxAccessTokensPerGrant', { maxAccessTokensPerGrant: 0 }],
  ])('refuses a non-positive %s', (_label, config) => {
    expect(() => resolveSpec(config)).toThrow(/must be a positive integer/)
  })

  it('keeps an explicitly configured state root and mode', () => {
    expect(resolveSpec({ dshHome: '/tmp/example', mode: 'bypass', watch: false, debounceMs: 25 }))
      .toMatchObject({ dshHome: '/tmp/example', mode: 'bypass', watch: false, debounceMs: 25 })
  })
})
