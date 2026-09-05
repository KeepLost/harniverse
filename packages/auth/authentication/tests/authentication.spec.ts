import { describe, expect, it } from 'vitest'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  authenticationChallengeId,
  authenticationEnrollmentId,
  authenticationGrantId,
  authenticationPrincipalIdentity,
  isAuthenticationCapability,
  sameAuthenticationPrincipal,
} from '../src/index.ts'

describe('authentication opaque identities', () => {
  it('brands non-empty Grant, enrollment, and challenge ids', () => {
    expect(authenticationGrantId('grant-1')).toBe('grant-1')
    expect(authenticationEnrollmentId('enrollment-1')).toBe('enrollment-1')
    expect(authenticationChallengeId('challenge-1')).toBe('challenge-1')
    expect(() => authenticationGrantId('')).toThrow(TypeError)
    expect(() => authenticationEnrollmentId('')).toThrow(TypeError)
    expect(() => authenticationChallengeId('')).toThrow(TypeError)
  })
})

describe('authentication principals', () => {
  it('publishes the complete capability vocabulary in stable order', () => {
    expect(ALL_AUTHENTICATION_CAPABILITIES).toEqual([
      'harniverse.observe',
      'harniverse.operate',
      'harniverse.administer',
      'harniverse.authorize',
    ])
    expect(ALL_AUTHENTICATION_CAPABILITIES.every(isAuthenticationCapability)).toBe(true)
    expect(isAuthenticationCapability('harniverse.unknown')).toBe(false)
  })

  it('compares principal identities only within the same kind and revision', () => {
    const grant = {
      kind: 'grant',
      grantId: authenticationGrantId('grant-1'),
      grantRevision: 1,
    } as const
    expect(sameAuthenticationPrincipal(grant, grant)).toBe(true)
    expect(sameAuthenticationPrincipal(grant, { ...grant, grantRevision: 2 })).toBe(false)
    expect(sameAuthenticationPrincipal(grant, { kind: 'bypass' })).toBe(false)
    expect(sameAuthenticationPrincipal(grant, undefined)).toBe(false)
    expect(sameAuthenticationPrincipal(undefined, grant)).toBe(false)
    expect(sameAuthenticationPrincipal({ kind: 'bypass' }, { kind: 'bypass' })).toBe(true)
  })

  it('projects principals to their non-secret identity', () => {
    expect(authenticationPrincipalIdentity({ kind: 'bypass', capabilities: [] })).toEqual({ kind: 'bypass' })
    expect(authenticationPrincipalIdentity({
      kind: 'grant',
      grantId: authenticationGrantId('grant-1'),
      grantRevision: 3,
      capabilities: ['harniverse.observe'],
      expiresAt: '2027-01-01T00:00:00.000Z',
    })).toEqual({ kind: 'grant', grantId: 'grant-1', grantRevision: 3 })
  })
})
