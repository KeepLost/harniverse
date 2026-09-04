/**
 * Failure containment and capacity refusal across the credential surface: an
 * admission the access log cannot record is not an admission, a credential the
 * ledgers cannot hold is refused rather than silently dropped, and every
 * unavailability is reported to callers instead of thrown at them.
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  authenticationGrantId,
  type AuthenticationPrincipal,
} from '@deepseek-ai/dsh-authentication'
import type { AccessRecord } from '../src/access-log.ts'

const audit = vi.hoisted(() => ({
  /**
   * Records whose write fails, keyed by `event` or `event:reasonCode`. An
   * empty set persists everything.
   */
  failing: new Set<string>(),
  error: new Error('access log unavailable'),
  records: [] as AccessRecord[],
}))

vi.mock('../src/access-log.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/access-log.ts')>()
  const reject = (record: AccessRecord): boolean =>
    audit.failing.has(record.event)
    || (record.reasonCode !== undefined && audit.failing.has(`${record.event}:${record.reasonCode}`))
  return {
    ...actual,
    appendAccessRecord: async (...args: Parameters<typeof actual.appendAccessRecord>): Promise<void> => {
      audit.records.push(args[0])
      if (reject(args[0])) throw audit.error
      await actual.appendAccessRecord(...args)
    },
    appendAccessRecords: async (...args: Parameters<typeof actual.appendAccessRecords>): Promise<void> => {
      audit.records.push(...args[0])
      if (args[0].some(reject)) throw audit.error
      await actual.appendAccessRecords(...args)
    },
  }
})

const { default: LocalAuthentication } = await import('../src/index.ts')
const { revokeAuthenticationGrant } = await import('../src/grant-registry.ts')
const { createGrantFixture, signedProof } = await import('./grant-fixture.ts')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  audit.failing.clear()
  audit.records.length = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-contain-'))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

interface BootOptions {
  mode?: 'authenticated' | 'bypass'
  config?: Record<string, unknown>
}

async function boot(dshHome: string, options: BootOptions = {}): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAuthentication, {
    ...options.config,
    dshHome,
    mode: options.mode ?? 'authenticated',
    watch: false,
  })
  cleanups.push(() => fiber.dispose())
  await fiber
  return ctx
}

/** A booted service whose owner Grant can sign proofs. */
async function owned(config: Record<string, unknown> = {}) {
  const dshHome = await home()
  const fixture = await createGrantFixture(dshHome)
  const ctx = await boot(dshHome, { config })
  const challenge = async (purpose: 'access-token' | 'browser-session' = 'access-token') =>
    await signedProof(ctx, fixture, purpose)
  return { ctx, dshHome, fixture, challenge }
}

/** Collected logger warnings for one context. */
function warningsOf(ctx: Context): string[] {
  const collected: string[] = []
  ctx.logger.warn = ((message: unknown) => { collected.push(String(message)) }) as typeof ctx.logger.warn
  return collected
}

describe('access record failure containment', () => {
  it('withdraws an admission whose access record cannot be written', async () => {
    const { ctx, challenge } = await owned()
    const exchanged = await ctx.authentication.exchangeAccessToken(await challenge())
    if (exchanged.kind !== 'accepted') throw new Error('expected an Access Token')
    const warnings = warningsOf(ctx)

    audit.failing.add('access-accepted')
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${exchanged.value.value}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('access record batch failed')
  })

  it('refuses a browser login whose access record cannot be written', async () => {
    const { ctx, challenge } = await owned()
    const proof = await challenge('browser-session')
    const warnings = warningsOf(ctx)
    audit.failing.add('browser-login-accepted')

    await expect(ctx.authentication.createBrowserSession(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('browser login record failed')
  })

  it('refuses a rejected browser login whose access record cannot be written', async () => {
    const { ctx, fixture } = await owned()
    const issued = await ctx.authentication.createChallenge(fixture.grant.id, 'browser-session')
    if (issued.kind !== 'accepted') throw new Error('expected a challenge')
    const warnings = warningsOf(ctx)
    audit.failing.add('browser-login-rejected')

    // A tampered signature is an invalid proof, and its refusal is auditable.
    await expect(ctx.authentication.createBrowserSession({
      challengeId: issued.value.id,
      signature: 'A'.repeat(86),
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('browser login record failed')
  })

  it('discards a challenge whose issuance record cannot be written', async () => {
    const dshHome = await home()
    const fixture = await createGrantFixture(dshHome)
    const ctx = await boot(dshHome)
    const warnings = warningsOf(ctx)
    audit.failing.add('challenge-issued')

    await expect(ctx.authentication.createChallenge(fixture.grant.id, 'access-token'))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('challenge issue unavailable')

    // The discarded challenge cannot be exchanged afterwards.
    audit.failing.clear()
    const issued = await ctx.authentication.createChallenge(fixture.grant.id, 'access-token')
    expect(issued.kind).toBe('accepted')
  })

  it('reports a capacity refusal even when its record cannot be written', async () => {
    const { ctx, challenge } = await owned({ maxAccessTokens: 1, maxAccessTokensPerGrant: 1 })
    const warnings = warningsOf(ctx)
    await expect(ctx.authentication.exchangeAccessToken(await challenge()))
      .resolves.toMatchObject({ kind: 'accepted' })

    audit.failing.add('access-rejected:capacity')
    // The same Grant evicts its own oldest token, so no capacity refusal
    // arises and nothing needs recording.
    const second = await ctx.authentication.exchangeAccessToken(await challenge())
    expect(second.kind).toBe('accepted')
    expect(warnings.join('\n')).not.toContain('capacity rejection record failed')
  })
})

describe('closed service', () => {
  it('refuses admission once the fiber is disposed', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome)
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', watch: false })
    await fiber
    const authentication = ctx.authentication
    await fiber.dispose()

    await expect(authentication.authenticate({ channel: 'http-api' }))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })
})

describe('credential rejection shapes', () => {
  it('refuses a malformed authorization header before consulting a ledger', async () => {
    const { ctx } = await owned()

    for (const authorization of ['Bearer', 'Basic abc', 'Bearer with space', '']) {
      await expect(ctx.authentication.authenticate({ channel: 'http-api', authorization }))
        .resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
    }
  })

  it('refuses an unknown browser session and an unknown bearer token', async () => {
    const { ctx } = await owned()

    await expect(ctx.authentication.authenticate({ channel: 'websocket-mux', browserSession: 'nope' }))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
    await expect(ctx.authentication.authenticate({ channel: 'http-api', authorization: 'Bearer dsha1_aaaaaaaaaaaaaaaa_bbbb' }))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })

  it('refuses a forged secret carried by a real Access Token id', async () => {
    const { ctx, challenge } = await owned()
    const exchanged = await ctx.authentication.exchangeAccessToken(await challenge('access-token'))
    if (exchanged.kind !== 'accepted') throw new Error('expected an Access Token')
    const [prefix, id] = exchanged.value.value.split('_')
    if (prefix === undefined || id === undefined) throw new Error('expected a structured token')

    // The id resolves to a live record, so only the constant-time secret
    // comparison stands between the caller and an admission.
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${prefix}_${id}_${'z'.repeat(43)}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })

    // The genuine secret still works, so the record was not consumed.
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${exchanged.value.value}`,
    })).resolves.toMatchObject({ kind: 'accepted' })
  })

  it('forgets an expired browser session on presentation', async () => {
    const { ctx, challenge } = await owned({ accessTokenTtlMs: 20 })
    const login = await ctx.authentication.createBrowserSession(await challenge('browser-session'))
    if (login.kind !== 'accepted') throw new Error('expected a browser session')

    await new Promise((resolve) => { setTimeout(resolve, 30) })
    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      browserSession: login.session.value,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })

  it('refuses a credential whose Grant was revoked underneath it', async () => {
    const { ctx, dshHome, fixture, challenge } = await owned()
    const exchanged = await ctx.authentication.exchangeAccessToken(await challenge())
    if (exchanged.kind !== 'accepted') throw new Error('expected an Access Token')

    // Revoking outside the service leaves the token well formed but stale.
    await revokeAuthenticationGrant(fixture.grant.id, { dshHome })
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${exchanged.value.value}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })

  it('refuses a challenge for an unknown Grant', async () => {
    const { ctx } = await owned()

    await expect(ctx.authentication.createChallenge(authenticationGrantId('aaaaaaaaaaaaaaaa'), 'access-token'))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-grant' })
  })

  it('refuses a proof presented for the wrong purpose', async () => {
    const { ctx, challenge } = await owned()
    const proof = await challenge('access-token')

    // A browser-session login cannot consume an access-token challenge.
    await expect(ctx.authentication.createBrowserSession(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })

  it('revokes a browser session by value and ignores an absent one', async () => {
    const { ctx, challenge } = await owned()
    const login = await ctx.authentication.createBrowserSession(await challenge('browser-session'))
    if (login.kind !== 'accepted') throw new Error('expected a browser session')

    expect(() => { ctx.authentication.revokeBrowserSession(undefined) }).not.toThrow()
    ctx.authentication.revokeBrowserSession(login.session.value)
    await expect(ctx.authentication.authenticate({
      channel: 'websocket-mux',
      browserSession: login.session.value,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })
})

describe('emergency token authority', () => {
  it('refuses an issuer that is not an authorizing Grant', async () => {
    const { ctx, fixture } = await owned()
    const bypass: AuthenticationPrincipal = { kind: 'bypass', capabilities: [...ALL_AUTHENTICATION_CAPABILITIES] }
    const unauthorized: AuthenticationPrincipal = {
      kind: 'grant',
      grantId: fixture.grant.id,
      name: fixture.grant.name,
      grantRevision: fixture.grant.revision,
      capabilities: ['harniverse.observe'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    for (const issuer of [bypass, unauthorized]) {
      await expect(ctx.authentication.issueEmergencyAccessToken(issuer, ['harniverse.observe'], 60_000))
        .resolves.toEqual({ kind: 'rejected', reason: 'invalid-grant' })
    }
  })

  it.each([
    ['a non-positive lifetime', ['harniverse.observe'], 0],
    ['a fractional lifetime', ['harniverse.observe'], 1.5],
    ['a lifetime above 15 minutes', ['harniverse.observe'], 15 * 60_000 + 1],
    ['no capability at all', [], 60_000],
    ['a request to pass on authority', ['harniverse.authorize'], 60_000],
    ['a capability the issuer lacks', ['harniverse.administer'], 60_000],
  ])('refuses %s', async (_label, capabilities, ttlMs) => {
    const { ctx, fixture } = await owned()
    const issuer: AuthenticationPrincipal = {
      kind: 'grant',
      grantId: fixture.grant.id,
      name: fixture.grant.name,
      grantRevision: fixture.grant.revision,
      capabilities: ['harniverse.observe', 'harniverse.authorize'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    await expect(ctx.authentication.issueEmergencyAccessToken(issuer, capabilities as never, ttlMs))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-grant' })
  })

  it('refuses an issuer whose Grant no longer exists', async () => {
    const { ctx } = await owned()
    const stale: AuthenticationPrincipal = {
      kind: 'grant',
      grantId: authenticationGrantId('aaaaaaaaaaaaaaaa'),
      name: 'ghost',
      grantRevision: 1,
      capabilities: [...ALL_AUTHENTICATION_CAPABILITIES],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    await expect(ctx.authentication.issueEmergencyAccessToken(stale, ['harniverse.observe'], 60_000))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-grant' })
  })

  it('refuses every credential operation in bypass mode', async () => {
    const dshHome = await home()
    const ctx = await boot(dshHome, { mode: 'bypass' })

    // Bypass has no Grant authority to draw on, so the issuer is never one.
    await expect(ctx.authentication.issueEmergencyAccessToken(
      { kind: 'bypass', capabilities: [...ALL_AUTHENTICATION_CAPABILITIES] },
      ['harniverse.observe'],
      60_000,
    ))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-grant' })
    await expect(ctx.authentication.createChallenge(authenticationGrantId('aaaaaaaaaaaaaaaa'), 'access-token'))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    await expect(ctx.authentication.createBrowserSession({ challengeId: 'x' as never, signature: 'y' }))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })
})

describe('owner availability recovery', () => {
  it('re-establishes availability when an owner returns before a challenge', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const observer = await createGrantFixture(dshHome, 'observer', ['harniverse.observe'])
    const ctx = await boot(dshHome)
    const unavailable = vi.fn()
    const available = vi.fn()
    ctx.on('authentication/unavailable', unavailable)
    ctx.on('authentication/available', available)

    // Losing the last owner seals the deployment.
    await revokeAuthenticationGrant(owner.grant.id, { dshHome })
    await expect(ctx.authentication.createChallenge(observer.grant.id, 'access-token'))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(unavailable).toHaveBeenCalled()

    // A new owner enrolled out of band is observed on the next challenge.
    await createGrantFixture(dshHome, 'owner-again')
    await expect(ctx.authentication.createChallenge(observer.grant.id, 'access-token'))
      .resolves.toMatchObject({ kind: 'accepted' })
    expect(available).toHaveBeenCalled()
  })

  it('re-establishes availability when an owner returns before an exchange', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const observer = await createGrantFixture(dshHome, 'observer', ['harniverse.observe'])
    const ctx = await boot(dshHome)
    const proof = await signedProof(ctx, observer, 'access-token')

    await revokeAuthenticationGrant(owner.grant.id, { dshHome })
    await expect(ctx.authentication.exchangeAccessToken(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })

    // The proof was consumed by the sealed attempt, so a fresh one is needed.
    await createGrantFixture(dshHome, 'owner-again')
    const available = vi.fn()
    ctx.on('authentication/available', available)
    await expect(ctx.authentication.exchangeAccessToken(await signedProof(ctx, observer, 'access-token')))
      .resolves.toMatchObject({ kind: 'accepted' })
  })

  it('reports a missing browser credential distinctly from an invalid one', async () => {
    const { ctx } = await owned()

    await expect(ctx.authentication.authenticate({ channel: 'websocket-mux' }))
      .resolves.toEqual({ kind: 'rejected', reason: 'missing-credential' })
  })

  it('refuses an exchange for a Grant revoked between challenge and proof', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const observer = await createGrantFixture(dshHome, 'observer', ['harniverse.observe'])
    const ctx = await boot(dshHome)
    const proof = await signedProof(ctx, observer, 'access-token')

    // The challenge outlives its Grant; the exchange must not.
    await revokeAuthenticationGrant(observer.grant.id, { dshHome })
    await expect(ctx.authentication.exchangeAccessToken(proof))
      .resolves.toEqual({ kind: 'rejected', reason: 'invalid-grant' })
  })

  it('refuses a bearer credential whose own deadline has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const observer = await createGrantFixture(dshHome, 'observer', ['harniverse.observe'])
    const ctx = await boot(dshHome, { config: { accessTokenTtlMs: 1_000 } })
    const exchanged = await ctx.authentication.exchangeAccessToken(await signedProof(ctx, observer, 'access-token'))
    if (exchanged.kind !== 'accepted') throw new Error('expected an Access Token')

    vi.setSystemTime(new Date('2026-08-17T00:00:02.000Z'))
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: `Bearer ${exchanged.value.value}`,
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })
})

describe('credential capacity refusal', () => {
  it('refuses an Access Token exchange at global capacity', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const first = await createGrantFixture(dshHome, 'first', ['harniverse.observe'])
    const second = await createGrantFixture(dshHome, 'second', ['harniverse.observe'])
    const ctx = await boot(dshHome, { config: { maxAccessTokens: 1, maxAccessTokensPerGrant: 1 } })

    await expect(ctx.authentication.exchangeAccessToken(await signedProof(ctx, first, 'access-token')))
      .resolves.toMatchObject({ kind: 'accepted' })
    // A different Grant cannot evict the first Grant's only token.
    await expect(ctx.authentication.exchangeAccessToken(await signedProof(ctx, second, 'access-token')))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(audit.records.some(record =>
      record.event === 'access-rejected' && record.reasonCode === 'capacity')).toBe(true)
  })

  it('warns when a capacity refusal cannot be recorded', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const first = await createGrantFixture(dshHome, 'first', ['harniverse.observe'])
    const second = await createGrantFixture(dshHome, 'second', ['harniverse.observe'])
    const ctx = await boot(dshHome, { config: { maxAccessTokens: 1, maxAccessTokensPerGrant: 1 } })
    await ctx.authentication.exchangeAccessToken(await signedProof(ctx, first, 'access-token'))
    const warnings = warningsOf(ctx)
    audit.failing.add('access-rejected:capacity')

    // The refusal still reaches the caller; only its record is lost.
    await expect(ctx.authentication.exchangeAccessToken(await signedProof(ctx, second, 'access-token')))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('capacity rejection record failed')
  })

  it('refuses an emergency token at global capacity', async () => {
    const dshHome = await home()
    const owner = await createGrantFixture(dshHome, 'owner')
    const other = await createGrantFixture(dshHome, 'other', ['harniverse.observe'])
    const ctx = await boot(dshHome, { config: { maxAccessTokens: 1, maxAccessTokensPerGrant: 1 } })
    await ctx.authentication.exchangeAccessToken(await signedProof(ctx, other, 'access-token'))
    const issuer: AuthenticationPrincipal = {
      kind: 'grant',
      grantId: owner.grant.id,
      name: owner.grant.name,
      grantRevision: owner.grant.revision,
      capabilities: [...ALL_AUTHENTICATION_CAPABILITIES],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    await expect(ctx.authentication.issueEmergencyAccessToken(issuer, ['harniverse.observe'], 60_000))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
  })

  it('refuses a browser login at session capacity and records the reason', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const first = await createGrantFixture(dshHome, 'first', ['harniverse.observe'])
    const second = await createGrantFixture(dshHome, 'second', ['harniverse.observe'])
    const ctx = await boot(dshHome, { config: { maxBrowserSessions: 1, maxBrowserSessionsPerGrant: 1 } })

    await expect(ctx.authentication.createBrowserSession(await signedProof(ctx, first, 'browser-session')))
      .resolves.toMatchObject({ kind: 'accepted' })
    await expect(ctx.authentication.createBrowserSession(await signedProof(ctx, second, 'browser-session')))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(audit.records.some(record =>
      record.event === 'browser-login-rejected' && record.reasonCode === 'capacity')).toBe(true)
  })

  it('refuses a capacity-blocked login whose record also fails', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome, 'owner')
    const first = await createGrantFixture(dshHome, 'first', ['harniverse.observe'])
    const second = await createGrantFixture(dshHome, 'second', ['harniverse.observe'])
    const ctx = await boot(dshHome, { config: { maxBrowserSessions: 1, maxBrowserSessionsPerGrant: 1 } })
    await ctx.authentication.createBrowserSession(await signedProof(ctx, first, 'browser-session'))
    const warnings = warningsOf(ctx)
    audit.failing.add('browser-login-rejected')

    await expect(ctx.authentication.createBrowserSession(await signedProof(ctx, second, 'browser-session')))
      .resolves.toEqual({ kind: 'rejected', reason: 'authentication-unavailable' })
    expect(warnings.join('\n')).toContain('browser login record failed')
  })
})

describe('rate limit windows', () => {
  it('forgets a failure window once it elapses', async () => {
    const { ctx } = await owned({ authFailureLimit: 2, authFailureWindowMs: 40, authFailureBlockMs: 10_000 })

    await ctx.authentication.authenticate({ channel: 'http-api', authorization: 'Bearer bad', peerAddress: '10.0.0.1' })
    // The window lapses before the second failure, so no block accrues.
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    await ctx.authentication.authenticate({ channel: 'http-api', authorization: 'Bearer bad', peerAddress: '10.0.0.1' })

    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: 'Bearer bad',
      peerAddress: '10.0.0.1',
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })

  it('bounds the failure key table', async () => {
    const { ctx } = await owned({ maxAuthFailureKeys: 2 })

    for (const peer of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      await ctx.authentication.authenticate({ channel: 'http-api', authorization: 'Bearer bad', peerAddress: peer })
    }

    // The oldest peers were evicted, so the newest still gets a fresh window.
    await expect(ctx.authentication.authenticate({
      channel: 'http-api',
      authorization: 'Bearer bad',
      peerAddress: '10.0.0.3',
    })).resolves.toEqual({ kind: 'rejected', reason: 'invalid-credential' })
  })

  it('forgets an enrollment window once it elapses and bounds its key table', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome)
    const ctx = await boot(dshHome, {
      config: { enrollmentRequestLimit: 1, enrollmentRequestWindowMs: 40, maxEnrollmentPeerKeys: 2 },
    })
    const key = (): string => generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')

    await expect(ctx.authentication.requestEnrollment({ name: 'a', kind: 'device', publicKey: key() }, '10.0.0.1'))
      .resolves.toMatchObject({ kind: 'accepted' })
    await expect(ctx.authentication.requestEnrollment({ name: 'b', kind: 'device', publicKey: key() }, '10.0.0.1'))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'rate-limited' })

    await new Promise((resolve) => { setTimeout(resolve, 60) })
    await expect(ctx.authentication.requestEnrollment({ name: 'c', kind: 'device', publicKey: key() }, '10.0.0.1'))
      .resolves.toMatchObject({ kind: 'accepted' })

    // Distinct peers past the key bound evict the oldest window.
    for (const peer of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) {
      await ctx.authentication.requestEnrollment({ name: `peer-${peer}`, kind: 'device', publicKey: key() }, peer)
    }
    await expect(ctx.authentication.requestEnrollment({ name: 'again', kind: 'device', publicKey: key() }, '10.0.0.1'))
      .resolves.toMatchObject({ kind: 'accepted' })
  })

  it('refuses enrollment past the pending capacity with a retry hint', async () => {
    const dshHome = await home()
    await createGrantFixture(dshHome)
    const ctx = await boot(dshHome, { config: { maxPendingEnrollments: 1 } })
    const key = (): string => generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')

    await expect(ctx.authentication.requestEnrollment({ name: 'first', kind: 'device', publicKey: key() }))
      .resolves.toMatchObject({ kind: 'accepted' })
    const refused = await ctx.authentication.requestEnrollment({ name: 'second', kind: 'device', publicKey: key() })
    expect(refused).toMatchObject({ kind: 'rejected', reason: 'rate-limited' })
    if (refused.kind !== 'rejected' || refused.reason !== 'rate-limited') throw new Error('expected a rate limit')
    expect(refused.retryAfterMs).toBeGreaterThan(0)
  })
})
