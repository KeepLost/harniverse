import { describe, expect, it } from 'vitest'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  authenticationChallengeId,
  authenticationEnrollmentId,
  authenticationGrantId,
  isAuthenticationCapability,
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
})
