/** Provider-level invitation redemption admission and rate limiting. */
import { Context } from '@deepseek-ai/cordis'
import { authenticationEnrollmentId } from '@deepseek-ai/dsh-authentication'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalAuthentication, { type Config } from '../src/index.ts'
import { accessLogPath } from '../src/access-log.ts'
import { createEnrollmentRequest, issueEnrollmentInvitation } from '../src/grant-registry.ts'

/** One-shot access-audit failures injected for invitation events. */
const auditFailures = vi.hoisted(() => ({ redeem: false, rejected: false }))

vi.mock('../src/access-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/access-log.ts')>()
  return {
    ...actual,
    appendAccessRecord: async (...args: Parameters<typeof actual.appendAccessRecord>) => {
      if (auditFailures.redeem && args[0].event === 'invitation-redeemed') {
        auditFailures.redeem = false
        throw new Error('audit down')
      }
      if (auditFailures.rejected && args[0].event === 'invitation-redeem-rejected') {
        auditFailures.rejected = false
        throw new Error('audit down')
      }
      await actual.appendAccessRecord(...args)
    },
  }
})

const OWNER_CAPS = ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'] as const
const PEER = '192.0.2.10'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-invitation-runtime-'))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

async function boot(dshHome: string, config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, { watch: false, ...config, dshHome })
  cleanups.push(() => fiber.dispose())
  await fiber
  return ctx
}

function publicKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

async function pendingEnrollment(dshHome: string, name: string, kind: 'device' | 'temporary' = 'device'): Promise<string> {
  const request = await createEnrollmentRequest({ name, kind, publicKey: publicKey() }, { dshHome })
  return request.id
}

describe('invitation redemption admission', () => {
  it('redeems through the service seam and exposes the resulting Grant', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    const issued = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    const id = await pendingEnrollment(dshHome, 'phone')

    const decision = await ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(id), issued.token, PEER)
    expect(decision).toMatchObject({
      kind: 'accepted',
      value: { state: 'approved', id, capabilities: [...OWNER_CAPS] },
    })
    expect((await ctx.authentication.listGrants()).map(grant => grant.name)).toEqual(['phone'])
    expect(await ctx.authentication.enrollmentStatus(authenticationEnrollmentId(id))).toMatchObject({ state: 'approved' })
  })

  it('rejects redemption in bypass mode', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome, { mode: 'bypass' })
    await expect(ctx.authentication.redeemEnrollmentInvitation(
      authenticationEnrollmentId('aaaaaaaaaaaaaaaa'), 'dshi1_x', PEER,
    )).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })

  it('reports kind mismatches with the invitation kind and stable input rejections', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    const issued = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    const temporary = await pendingEnrollment(dshHome, 'kiosk', 'temporary')
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(temporary), issued.token, PEER))
      .resolves.toEqual({ kind: 'rejected', reason: 'invitation-kind', expected: 'device' })

    const unknown = await pendingEnrollment(dshHome, 'other')
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(unknown), 'dshi1_short', PEER))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-invitation' })
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId('aaaaaaaaaaaaaaaa'), issued.token, PEER))
      .resolves.toEqual({ kind: 'rejected', reason: 'not-found' })
  })

  it('counts only failed secret matches toward the redemption limiter', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome, {
      authFailureLimit: 3, authFailureWindowMs: 60_000, authFailureBlockMs: 5 * 60_000,
    })
    const issued = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    const mismatch = await pendingEnrollment(dshHome, 'kiosk', 'temporary')

    // Legitimate corrections never feed the limiter.
    for (let index = 0; index < 4; index += 1) {
      await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(mismatch), issued.token, PEER))
        .resolves.toEqual({ kind: 'rejected', reason: 'invitation-kind', expected: 'device' })
    }
    for (let index = 0; index < 2; index += 1) {
      await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(mismatch), 'dshi1_short', PEER))
        .resolves.toEqual({ kind: 'rejected', reason: 'invalid-invitation' })
    }
    // The third failed secret match blocks the peer before any registry work.
    const phone = await pendingEnrollment(dshHome, 'phone')
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(phone), 'dshi1_short', PEER))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-invitation' })
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(phone), issued.token, PEER))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'rate-limited' })
    // Another peer redeems the same invitation without limiter interference.
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(phone), issued.token, '192.0.2.11'))
      .resolves.toMatchObject({ kind: 'accepted' })

    const log = await readFile(accessLogPath(dshHome), 'utf8')
    expect(log).toContain('invitation-redeem-rejected')
  })

  it('fails closed when the mandatory redemption audit cannot be written', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    const issued = await issueEnrollmentInvitation({
      capabilities: OWNER_CAPS, kind: 'device', ttlMs: 60_000,
    }, { dshHome })
    const id = await pendingEnrollment(dshHome, 'phone')

    // A broken accepted-redemption audit rolls the registry back: the token
    // stays unused and the decision degrades to authentication-unavailable.
    auditFailures.redeem = true
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(id), issued.token, PEER))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(id), issued.token, PEER))
      .resolves.toMatchObject({ kind: 'accepted' })

    // A broken rejection audit never hides the rejection itself.
    auditFailures.rejected = true
    const other = await pendingEnrollment(dshHome, 'other')
    await expect(ctx.authentication.redeemEnrollmentInvitation(authenticationEnrollmentId(other), 'dshi1_short', PEER))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-invitation' })
  })
})
