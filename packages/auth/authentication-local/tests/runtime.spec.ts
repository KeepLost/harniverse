import { Context } from '@deepseek-ai/cordis'
import { ALL_AUTHENTICATION_CAPABILITIES } from '@deepseek-ai/dsh-authentication'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalAuthentication, { resolveSpec, type Config } from '../src/index.ts'
import { accessLogPath } from '../src/access-log.ts'
import { approveEnrollmentRequest, createEnrollmentRequest, revokeAuthenticationGrant } from '../src/grant-registry.ts'
import { createGrantFixture, signedProof } from './grant-fixture.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-runtime-'))
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

describe('local Grant authentication runtime', () => {
  it('rejects credential lifetimes above their security ceilings', () => {
    expect(() => resolveSpec({ accessTokenTtlMs: 15 * 60_000 + 1 })).toThrow(/accessTokenTtlMs cannot exceed 15 minutes/)
    expect(() => resolveSpec({ challengeTtlMs: 5 * 60_000 + 1 })).toThrow(/challengeTtlMs cannot exceed 5 minutes/)
    expect(() => resolveSpec({ enrollmentTtlMs: 15 * 60_000 + 1 })).toThrow(/enrollmentTtlMs cannot exceed 15 minutes/)
    expect(() => resolveSpec({ maxAccessTokens: 2, maxAccessTokensPerGrant: 3 })).toThrow(/cannot exceed its global capacity/)
  })

  it('starts sealed, accepts enrollment, and exposes approval without opening business APIs', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    expect(await ctx.authentication.status()).toEqual({ mode: 'authenticated', sealed: true })
    await expect(ctx.authentication.authenticate({ channel: 'http-api' })).resolves.toEqual({
      kind: 'rejected',
      reason: 'authentication-unavailable',
    })

    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pendingDecision = await ctx.authentication.requestEnrollment({
      name: 'phone',
      kind: 'device',
      publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    })
    if (pendingDecision.kind !== 'accepted') throw new Error('expected pending enrollment')
    const pending = pendingDecision.value
    expect(pending).toMatchObject({ state: 'pending', name: 'phone', kind: 'device' })
    const grant = await approveEnrollmentRequest(pending.id, {
      capabilities: ALL_AUTHENTICATION_CAPABILITIES,
    }, { dshHome })
    expect(await ctx.authentication.enrollmentStatus(pending.id)).toMatchObject({
      state: 'approved',
      grantId: grant.id,
      capabilities: ALL_AUTHENTICATION_CAPABILITIES,
    })
    expect(await ctx.authentication.status()).toEqual({ mode: 'authenticated', sealed: false })

    const observerDecision = await ctx.authentication.requestEnrollment({
      name: 'observer',
      kind: 'device',
      publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    })
    if (observerDecision.kind !== 'accepted') throw new Error('expected pending observer enrollment')
    const observer = observerDecision.value
    await approveEnrollmentRequest(observer.id, {
      capabilities: ['harniverse.observe'],
    }, { dshHome })
    await revokeAuthenticationGrant(grant.id, { dshHome })
    expect(await ctx.authentication.status()).toEqual({ mode: 'authenticated', sealed: true })
  })

  it('returns stable enrollment input and name-conflict rejections', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome)
    const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')

    await expect(ctx.authentication.requestEnrollment({
      name: 'line\nbreak', kind: 'device', publicKey,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-name' })
    await expect(ctx.authentication.requestEnrollment({
      name: '我的设备', kind: 'device', publicKey: 'not-a-key',
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-public-key' })
    await expect(ctx.authentication.requestEnrollment({
      name: '我的设备', kind: 'device', publicKey,
    })).resolves.toMatchObject({ kind: 'accepted' })
    await expect(ctx.authentication.requestEnrollment({
      name: '我的设备', kind: 'device', publicKey,
    })).resolves.toEqual({ kind: 'rejected', reason: 'name-conflict' })
  })

  it('exchanges signed challenges for short bearer and browser credentials', async () => {
    const dshHome = await home()
    const fixture = await createGrantFixture(dshHome, 'phone')
    const ctx = await boot(dshHome)

    const accessProof = await signedProof(ctx, fixture, 'access-token')
    const exchange = await ctx.authentication.exchangeAccessToken(accessProof, '192.0.2.10')
    expect(exchange.kind).toBe('accepted')
    if (exchange.kind !== 'accepted') return
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${exchange.value.value}`,
      peerAddress: '192.0.2.10',
    })).resolves.toMatchObject({
      kind: 'accepted',
      principal: { kind: 'grant', grantId: fixture.grant.id, capabilities: fixture.grant.capabilities },
    })

    const browserProof = await signedProof(ctx, fixture, 'browser-session')
    const login = await ctx.authentication.createBrowserSession(browserProof, '192.0.2.10')
    expect(login.kind).toBe('accepted')
    if (login.kind !== 'accepted') return
    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      browserSession: login.session.value,
    })).resolves.toMatchObject({ kind: 'accepted', principal: { grantId: fixture.grant.id } })
  })

  it('rejects replayed proofs and Access Tokens after targeted Grant revocation', async () => {
    const dshHome = await home()
    const fixture = await createGrantFixture(dshHome, 'phone')
    await createGrantFixture(dshHome, 'backup-owner')
    const ctx = await boot(dshHome)
    const proof = await signedProof(ctx, fixture, 'access-token')
    const exchange = await ctx.authentication.exchangeAccessToken(proof)
    if (exchange.kind !== 'accepted') throw new Error('expected Access Token')
    await expect(ctx.authentication.exchangeAccessToken(proof)).resolves.toEqual({ kind: 'rejected', reason: 'invalid-proof' })

    await revokeAuthenticationGrant(fixture.grant.id, { dshHome })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', authorization: `Bearer ${exchange.value.value}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })

  it('seals all business admission when the final owner is revoked', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const observer = await createGrantFixture(dshHome, 'observer', ['harniverse.observe'])
    const ctx = await boot(dshHome)
    const observerProof = await signedProof(ctx, observer, 'access-token')
    const access = await ctx.authentication.exchangeAccessToken(observerProof)
    if (access.kind !== 'accepted') throw new Error('expected observer Access Token')
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    await revokeAuthenticationGrant(owner.grant.id, { dshHome })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', authorization: `Bearer ${access.value.value}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('publishes global unavailability when the final owner expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const enrollment = await createEnrollmentRequest({
      name: 'expiring-owner',
      kind: 'device',
      publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    }, { dshHome })
    await approveEnrollmentRequest(enrollment.id, {
      capabilities: ALL_AUTHENTICATION_CAPABILITIES,
      expiresInMs: 1_000,
    }, { dshHome })
    const ctx = await boot(dshHome)
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    await vi.advanceTimersByTimeAsync(1_001)

    await expect(ctx.authentication.authenticate({ channel: 'http-api' })).resolves.toEqual({
      kind: 'rejected', reason: 'authentication-unavailable',
    })
    expect(unavailable).toHaveBeenCalledOnce()
  })

  it('reconciles final-owner loss even when filesystem watching is disabled', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    await createGrantFixture(dshHome, 'observer', ['harniverse.observe'])
    const ctx = await boot(dshHome, 'authenticated', { reconcileIntervalMs: 10 })
    const unavailable = vi.fn()
    ctx.on('authentication/unavailable', unavailable)

    await revokeAuthenticationGrant(owner.grant.id, { dshHome })

    await vi.waitFor(() => { expect(unavailable).toHaveBeenCalledOnce() })
    await expect(ctx.authentication.authenticate({ channel: 'http-api' })).resolves.toEqual({
      kind: 'rejected', reason: 'authentication-unavailable',
    })
  })

  it('caps temporary credentials at the Grant idle deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const temporary = await createGrantFixture(dshHome, 'temporary', ['harniverse.observe'], 'temporary')
    const ctx = await boot(dshHome, 'authenticated', { accessTokenTtlMs: 60_000 })
    const expectedExpiry = new Date(Date.now() + 15_000).toISOString()

    const access = await ctx.authentication.exchangeAccessToken(await signedProof(ctx, temporary, 'access-token'))
    expect(access).toMatchObject({ kind: 'accepted', value: { expiresAt: expectedExpiry } })
    const browser = await ctx.authentication.createBrowserSession(await signedProof(ctx, temporary, 'browser-session'))
    expect(browser).toMatchObject({ kind: 'accepted', session: { expiresAt: expectedExpiry } })
  })

  it('issues only reduced, unrenewable emergency tokens from an owner Grant', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner', ALL_AUTHENTICATION_CAPABILITIES)
    const ctx = await boot(dshHome)
    const ownerProof = await signedProof(ctx, owner, 'access-token')
    const ownerToken = await ctx.authentication.exchangeAccessToken(ownerProof)
    if (ownerToken.kind !== 'accepted') throw new Error('expected owner token')

    const emergency = await ctx.authentication.issueEmergencyAccessToken(
      ownerToken.value.principal,
      ['harniverse.observe', 'harniverse.operate'],
      60_000,
    )
    expect(emergency).toMatchObject({
      kind: 'accepted',
      value: { principal: { capabilities: ['harniverse.observe', 'harniverse.operate'] } },
    })
    await expect(ctx.authentication.issueEmergencyAccessToken(
      ownerToken.value.principal,
      ['harniverse.authorize'],
      60_000,
    )).resolves.toEqual({ kind: 'rejected', reason: 'invalid-grant' })
  })

  it('bounds browser sessions and expires them at the configured Access Token TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    const fixture = await createGrantFixture(dshHome, 'phone')
    const ctx = await boot(dshHome, 'authenticated', { maxBrowserSessions: 2, accessTokenTtlMs: 10 })
    const sessions = []
    for (let index = 0; index < 3; index += 1) {
      const proof = await signedProof(ctx, fixture, 'browser-session')
      const login = await ctx.authentication.createBrowserSession(proof)
      if (login.kind !== 'accepted') throw new Error('expected browser session')
      sessions.push(login.session)
    }
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', browserSession: sessions[0]!.value,
    })).resolves.toMatchObject({ kind: 'rejected' })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', browserSession: sessions[2]!.value,
    })).resolves.toMatchObject({ kind: 'accepted' })

    vi.setSystemTime(new Date('2026-08-17T00:00:00.011Z'))
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', browserSession: sessions[2]!.value,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })

  it('never evicts another Grant at browser-session capacity', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const other = await createGrantFixture(dshHome, 'other')
    const third = await createGrantFixture(dshHome, 'third')
    const ctx = await boot(dshHome, 'authenticated', {
      maxBrowserSessions: 2,
      maxBrowserSessionsPerGrant: 1,
    })
    const ownerSession = await ctx.authentication.createBrowserSession(await signedProof(ctx, owner, 'browser-session'))
    const otherSession = await ctx.authentication.createBrowserSession(await signedProof(ctx, other, 'browser-session'))
    if (ownerSession.kind !== 'accepted' || otherSession.kind !== 'accepted') throw new Error('expected browser sessions')

    await expect(ctx.authentication.createBrowserSession(await signedProof(ctx, third, 'browser-session'))).resolves.toEqual({
      kind: 'rejected', reason: 'authentication-unavailable',
    })
    expect(await readFile(accessLogPath(dshHome), 'utf8')).toContain('"event":"browser-login-rejected"')
    expect(await readFile(accessLogPath(dshHome), 'utf8')).toContain('"reasonCode":"capacity"')
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', browserSession: ownerSession.session.value,
    })).resolves.toMatchObject({ kind: 'accepted' })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', browserSession: otherSession.session.value,
    })).resolves.toMatchObject({ kind: 'accepted' })

    await expect(ctx.authentication.createBrowserSession(await signedProof(ctx, owner, 'browser-session')))
      .resolves.toMatchObject({ kind: 'accepted' })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', browserSession: ownerSession.session.value,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api', browserSession: otherSession.session.value,
    })).resolves.toMatchObject({ kind: 'accepted' })
  })

  it('records challenge capacity rejection instead of challenge issuance', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const other = await createGrantFixture(dshHome, 'other')
    const third = await createGrantFixture(dshHome, 'third')
    const ctx = await boot(dshHome, 'authenticated', {
      maxChallenges: 2,
      maxChallengesPerGrant: 1,
    })
    await expect(ctx.authentication.createChallenge(owner.grant.id, 'access-token')).resolves.toMatchObject({ kind: 'accepted' })
    await expect(ctx.authentication.createChallenge(other.grant.id, 'access-token')).resolves.toMatchObject({ kind: 'accepted' })
    await expect(ctx.authentication.createChallenge(third.grant.id, 'access-token')).resolves.toEqual({
      kind: 'rejected', reason: 'authentication-unavailable',
    })

    const records = await readFile(accessLogPath(dshHome), 'utf8')
    expect(records).toContain('"event":"challenge-rejected"')
    expect(records).toContain('"reasonCode":"capacity"')
  })

  it('rate limits repeated invalid bearer credentials by channel and peer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    await createGrantFixture(dshHome, 'phone')
    const ctx = await boot(dshHome, 'authenticated', {
      authFailureLimit: 2,
      authFailureWindowMs: 1_000,
      authFailureBlockMs: 5_000,
    })
    const attempt = { channel: 'http-api' as const, authorization: 'Bearer invalid', peerAddress: '192.0.2.10' }
    await expect(ctx.authentication.authenticate(attempt)).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
    await expect(ctx.authentication.authenticate(attempt)).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
    await expect(ctx.authentication.authenticate(attempt)).resolves.toEqual({
      kind: 'rejected', reason: 'rate-limited', retryAfterMs: 5_000,
    })
  })

  it('rate limits enrollment creation per direct peer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    const ctx = await boot(dshHome, 'authenticated', {
      enrollmentRequestLimit: 2,
      enrollmentRequestWindowMs: 60_000,
      maxPendingEnrollments: 8,
    })
    const enroll = (name: string, peerAddress: string) => ctx.authentication.requestEnrollment({
      name,
      kind: 'device',
      publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    }, peerAddress)

    await expect(enroll('phone', '192.0.2.10')).resolves.toMatchObject({ kind: 'accepted' })
    await expect(enroll('tablet', '192.0.2.10')).resolves.toMatchObject({ kind: 'accepted' })
    await expect(enroll('laptop', '192.0.2.10')).resolves.toEqual({
      kind: 'rejected', reason: 'rate-limited', retryAfterMs: 60_000,
    })
    await expect(enroll('desktop', '192.0.2.11')).resolves.toMatchObject({ kind: 'accepted' })
  })

  it('admits without credentials only in explicit bypass mode and still owns the lease', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome, 'bypass')
    await expect(ctx.authentication.authenticate({ channel: 'http-api' })).resolves.toMatchObject({
      kind: 'accepted',
      principal: { kind: 'bypass', capabilities: ALL_AUTHENTICATION_CAPABILITIES },
    })

    const contender = new Context().plugin(LocalAuthentication, { dshHome, mode: 'authenticated', watch: false })
    cleanups.push(() => contender.dispose())
    await expect(contender).rejects.toThrow(/already running in bypass mode/)
  })
})
