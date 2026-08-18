import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import { AccessTokenLedger } from '../src/access-tokens.ts'
import { ChallengeLedger } from '../src/challenges.ts'
import type { AuthenticationGrant } from '../src/grant-registry.ts'

function fixtureGrant(): { grant: AuthenticationGrant; signPayload: (payload: string) => string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    grant: {
      id: authenticationGrantId('abcdefghijklmnop'),
      name: 'phone',
      kind: 'device',
      revision: 2,
      publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      capabilities: ['harniverse.observe', 'harniverse.operate'],
      createdAt: '2026-08-17T00:00:00.000Z',
    },
    signPayload: payload => sign('sha256', Buffer.from(payload), {
      key: pair.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  }
}

describe('Grant challenge exchange', () => {
  it('binds a single-use challenge to the instance, Grant revision, and purpose', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const { grant, signPayload } = fixtureGrant()
    const challenges = new ChallengeLedger({ ttlMs: 30_000, maxChallenges: 10, maxChallengesPerGrant: 10 })
    const challenge = challenges.issue('instance-1', grant, 'access-token')
    if (challenge === undefined) throw new Error('expected challenge')
    const signature = signPayload(challenge.payload)

    expect(JSON.parse(challenge.payload)).toMatchObject({
      version: 1,
      instanceId: 'instance-1',
      grantId: grant.id,
      grantRevision: 2,
      purpose: 'access-token',
    })
    expect(challenges.consume({ challengeId: challenge.id, signature })).toMatchObject({
      kind: 'accepted',
      grantId: grant.id,
      grantRevision: 2,
      purpose: 'access-token',
    })
    expect(challenges.consume({ challengeId: challenge.id, signature })).toEqual({ kind: 'rejected', reason: 'invalid-proof' })
    vi.useRealTimers()
  })

  it('rejects invalid and expired signatures', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const { grant } = fixtureGrant()
    const challenges = new ChallengeLedger({ ttlMs: 10, maxChallenges: 10, maxChallengesPerGrant: 10 })
    const invalid = challenges.issue('instance-1', grant, 'browser-session')
    if (invalid === undefined) throw new Error('expected challenge')
    expect(challenges.consume({ challengeId: invalid.id, signature: Buffer.alloc(64).toString('base64url') }))
      .toEqual({ kind: 'rejected', reason: 'invalid-proof' })

    const expired = challenges.issue('instance-1', grant, 'access-token')
    if (expired === undefined) throw new Error('expected challenge')
    vi.setSystemTime(new Date('2026-08-17T00:00:00.011Z'))
    expect(challenges.consume({ challengeId: expired.id, signature: Buffer.alloc(64).toString('base64url') }))
      .toEqual({ kind: 'rejected', reason: 'expired' })
    vi.useRealTimers()
  })

  it('issues bounded short-lived Access Tokens carrying the Grant capabilities', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const { grant } = fixtureGrant()
    const tokens = new AccessTokenLedger({ ttlMs: 10_000, maxTokens: 2, maxTokensPerGrant: 2 })
    const first = tokens.issue(grant)
    const second = tokens.issue(grant)
    if (first === undefined || second === undefined) throw new Error('expected Access Tokens')

    expect(first.value).toMatch(/^dsha1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/)
    expect(tokens.authenticate(first.value)).toEqual(first.principal)
    expect(first.principal).toMatchObject({
      kind: 'grant',
      grantId: grant.id,
      grantRevision: 2,
      capabilities: ['harniverse.observe', 'harniverse.operate'],
    })

    const third = tokens.issue(grant)
    if (third === undefined) throw new Error('expected Access Token')
    expect(tokens.authenticate(first.value)).toBeUndefined()
    expect(tokens.authenticate(second.value)).toBeDefined()
    expect(tokens.authenticate(third.value)).toBeDefined()

    tokens.revoke(grant.id, grant.revision)
    expect(tokens.authenticate(second.value)).toBeUndefined()
    vi.useRealTimers()
  })

  it('issues reduced, short emergency tokens', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const { grant } = fixtureGrant()
    const tokens = new AccessTokenLedger({ ttlMs: 10_000, maxTokens: 2, maxTokensPerGrant: 2 })

    const emergency = tokens.issueRestricted(grant, ['harniverse.observe'], 500)
    if (emergency === undefined) throw new Error('expected emergency token')

    expect(emergency.principal.capabilities).toEqual(['harniverse.observe'])
    expect(emergency.expiresAt).toBe('2026-08-17T00:00:00.500Z')
    vi.useRealTimers()
  })

  it('never evicts another Grant at challenge or token capacity', () => {
    const { grant, signPayload } = fixtureGrant()
    const other: AuthenticationGrant = {
      ...grant,
      id: authenticationGrantId('qrstuvwxyzABCDEF'),
      name: 'other',
    }
    const third: AuthenticationGrant = {
      ...grant,
      id: authenticationGrantId('1234567890abcdef'),
      name: 'third',
    }
    const challenges = new ChallengeLedger({ ttlMs: 30_000, maxChallenges: 2, maxChallengesPerGrant: 1 })
    const firstChallenge = challenges.issue('instance-1', grant, 'access-token')
    const otherChallenge = challenges.issue('instance-1', other, 'access-token')
    if (firstChallenge === undefined || otherChallenge === undefined) throw new Error('expected challenges')
    expect(challenges.issue('instance-1', third, 'access-token')).toBeUndefined()
    expect(challenges.issue('instance-1', grant, 'access-token')).toBeDefined()
    expect(challenges.consume({ challengeId: otherChallenge.id, signature: signPayload(otherChallenge.payload) })).toMatchObject({
      kind: 'accepted', grantId: other.id,
    })

    const tokens = new AccessTokenLedger({ ttlMs: 10_000, maxTokens: 2, maxTokensPerGrant: 1 })
    const firstToken = tokens.issue(grant)
    const otherToken = tokens.issue(other)
    if (firstToken === undefined || otherToken === undefined) throw new Error('expected Access Tokens')
    expect(tokens.issue(third)).toBeUndefined()
    expect(tokens.issue(grant)).toBeDefined()
    expect(tokens.authenticate(otherToken.value)).toEqual(otherToken.principal)
  })
})
