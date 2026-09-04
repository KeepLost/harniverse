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

describe('challenge ledger lifecycle', () => {
  const spec = { ttlMs: 30_000, maxChallenges: 10, maxChallengesPerGrant: 10 }

  it('rejects a signature of the wrong shape without verifying it', () => {
    const { grant } = fixtureGrant()
    const challenges = new ChallengeLedger(spec)
    const challenge = challenges.issue('instance-1', grant, 'access-token')
    if (challenge === undefined) throw new Error('expected challenge')

    // 86 base64url characters is the only accepted P-256 signature width, so a
    // short value is refused before any crypto work and still consumes the id.
    expect(challenges.consume({ challengeId: challenge.id, signature: 'too-short' }))
      .toEqual({ kind: 'rejected', reason: 'invalid-proof' })
    expect(challenges.consume({ challengeId: challenge.id, signature: 'too-short' }))
      .toEqual({ kind: 'rejected', reason: 'invalid-proof' })
  })

  it('rejects a proof whose stored key cannot be parsed', () => {
    const { grant, signPayload } = fixtureGrant()
    const challenges = new ChallengeLedger(spec)
    const challenge = challenges.issue('instance-1', { ...grant, publicKey: 'bm90LWEta2V5' }, 'access-token')
    if (challenge === undefined) throw new Error('expected challenge')

    // A throwing verification is a rejection, never an admission.
    expect(challenges.consume({ challengeId: challenge.id, signature: signPayload(challenge.payload) }))
      .toEqual({ kind: 'rejected', reason: 'invalid-proof' })
  })

  it('revokes only the named Grant revision', () => {
    const { grant, signPayload } = fixtureGrant()
    const challenges = new ChallengeLedger(spec)
    const current = challenges.issue('instance-1', grant, 'access-token')
    const other = challenges.issue('instance-1', { ...grant, revision: 3 }, 'access-token')
    if (current === undefined || other === undefined) throw new Error('expected challenges')

    challenges.revoke(grant.id, grant.revision)
    expect(challenges.consume({ challengeId: current.id, signature: signPayload(current.payload) }))
      .toEqual({ kind: 'rejected', reason: 'invalid-proof' })
    expect(challenges.consume({ challengeId: other.id, signature: signPayload(other.payload) }))
      .toMatchObject({ kind: 'accepted', grantRevision: 3 })
  })

  it('discards one unpublished challenge and clears every outstanding one', () => {
    const { grant, signPayload } = fixtureGrant()
    const challenges = new ChallengeLedger(spec)
    const discarded = challenges.issue('instance-1', grant, 'access-token')
    const kept = challenges.issue('instance-1', grant, 'browser-session')
    if (discarded === undefined || kept === undefined) throw new Error('expected challenges')

    // A challenge whose mandatory audit record failed was never published.
    challenges.discard(discarded.id)
    expect(challenges.consume({ challengeId: discarded.id, signature: signPayload(discarded.payload) }))
      .toEqual({ kind: 'rejected', reason: 'invalid-proof' })
    expect(challenges.consume({ challengeId: kept.id, signature: signPayload(kept.payload) }))
      .toMatchObject({ kind: 'accepted', purpose: 'browser-session' })

    const cleared = challenges.issue('instance-1', grant, 'access-token')
    if (cleared === undefined) throw new Error('expected challenge')
    challenges.clear()
    expect(challenges.consume({ challengeId: cleared.id, signature: signPayload(cleared.payload) }))
      .toEqual({ kind: 'rejected', reason: 'invalid-proof' })
  })

  it('prunes expired challenges before measuring capacity', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    try {
      const { grant, signPayload } = fixtureGrant()
      const challenges = new ChallengeLedger({ ttlMs: 1_000, maxChallenges: 1, maxChallengesPerGrant: 1 })
      const stale = challenges.issue('instance-1', grant, 'access-token')
      if (stale === undefined) throw new Error('expected challenge')

      // Once the stale record ages out, global capacity is free again.
      vi.setSystemTime(new Date('2026-08-17T00:00:02.000Z'))
      const fresh = challenges.issue('instance-1', { ...grant, id: authenticationGrantId('freshfreshfresh1') }, 'access-token')
      if (fresh === undefined) throw new Error('expected challenge after pruning')
      expect(challenges.consume({ challengeId: fresh.id, signature: signPayload(fresh.payload) }))
        .toMatchObject({ kind: 'accepted' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('access token ledger lifecycle', () => {
  const spec = { ttlMs: 10_000, maxTokens: 10, maxTokensPerGrant: 10 }

  it.each([
    ['a foreign prefix', 'bearer_abcdefghijklmnop_' + 'a'.repeat(43)],
    ['a short id', 'dsha1_short_' + 'a'.repeat(43)],
    ['a short secret', 'dsha1_abcdefghijklmnop_short'],
    ['an empty value', ''],
  ])('refuses %s', (_label, value) => {
    const tokens = new AccessTokenLedger(spec)
    expect(tokens.authenticate(value)).toBeUndefined()
  })

  it('refuses an unknown but well-formed token', () => {
    const tokens = new AccessTokenLedger(spec)
    expect(tokens.authenticate(`dsha1_${'a'.repeat(16)}_${'b'.repeat(43)}`)).toBeUndefined()
  })

  it('refuses a well-formed token whose secret does not match its record', () => {
    const { grant } = fixtureGrant()
    const tokens = new AccessTokenLedger(spec)
    const issued = tokens.issue(grant)
    if (issued === undefined) throw new Error('expected Access Token')
    const id = issued.value.split('_')[1]
    if (id === undefined) throw new Error('expected token id')

    // The id resolves, so only the constant-time secret comparison refuses it.
    expect(tokens.authenticate(`dsha1_${id}_${'z'.repeat(43)}`)).toBeUndefined()
    expect(tokens.authenticate(issued.value)).toEqual(issued.principal)
  })

  it('forgets an expired token when it is presented', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    try {
      const { grant } = fixtureGrant()
      const tokens = new AccessTokenLedger({ ttlMs: 1_000, maxTokens: 10, maxTokensPerGrant: 10 })
      const issued = tokens.issue(grant)
      if (issued === undefined) throw new Error('expected Access Token')

      vi.setSystemTime(new Date('2026-08-17T00:00:02.000Z'))
      expect(tokens.authenticate(issued.value)).toBeUndefined()
      expect(tokens.authenticate(issued.value)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('floors a token lifetime at its Grant deadline', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    try {
      const { grant } = fixtureGrant()
      const tokens = new AccessTokenLedger({ ttlMs: 60_000, maxTokens: 10, maxTokensPerGrant: 10 })
      // A temporary Grant outliving nothing: the token cannot outlive it.
      const issued = tokens.issue({ ...grant, expiresAt: '2026-08-17T00:00:05.000Z' })
      if (issued === undefined) throw new Error('expected Access Token')

      expect(issued.expiresAt).toBe('2026-08-17T00:00:05.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('revokes only the named Grant revision and clears everything on demand', () => {
    const { grant } = fixtureGrant()
    const tokens = new AccessTokenLedger(spec)
    const current = tokens.issue(grant)
    const next = tokens.issue({ ...grant, revision: 3 })
    if (current === undefined || next === undefined) throw new Error('expected Access Tokens')

    tokens.revoke(grant.id, grant.revision)
    expect(tokens.authenticate(current.value)).toBeUndefined()
    expect(tokens.authenticate(next.value)).toEqual(next.principal)

    tokens.clear()
    expect(tokens.authenticate(next.value)).toBeUndefined()
  })

  it('prunes expired tokens before measuring capacity', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    try {
      const { grant } = fixtureGrant()
      const tokens = new AccessTokenLedger({ ttlMs: 1_000, maxTokens: 1, maxTokensPerGrant: 1 })
      if (tokens.issue(grant) === undefined) throw new Error('expected Access Token')

      vi.setSystemTime(new Date('2026-08-17T00:00:02.000Z'))
      const other = tokens.issue({ ...grant, id: authenticationGrantId('freshfreshfresh1') })
      expect(other).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
