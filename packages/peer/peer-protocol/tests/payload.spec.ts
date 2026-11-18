import { expect, it } from 'vitest'
import type { PeerInvitePayload } from '../src/index.ts'
import {
  DEFAULT_INVITE_TTL_MS,
  PEER_CAPABILITY,
  PEER_ENROLLMENT_KIND,
  PEER_INVITE_SCHEME,
  PeerError,
  decodePeerInvite,
  encodePeerInvite,
  instanceIdOfGrantName,
  isDisplayName,
  newPeerInstanceId,
  peerGrantName,
  peerInstanceId,
  validateOrigin,
} from '../src/index.ts'

const instanceId = '3f2a8f9e-1111-4222-8333-444455556666'
const payload = {
  version: 1 as const,
  instanceId: instanceId as never,
  displayName: 'Build workstation',
  endpoint: { origin: 'https://build.example.org:8443' },
  token: `dshi1_${'A'.repeat(27)}`,
}

it('round-trips one invitation payload through the paste URI', () => {
  const uri = encodePeerInvite(payload)
  expect(uri.startsWith(`${PEER_INVITE_SCHEME}//`)).toBe(true)
  expect(decodePeerInvite(uri)).toEqual(payload)
})

it('carries an optional TLS fingerprint and rejects a malformed one', () => {
  const withPin = encodePeerInvite({ ...payload, tlsFingerprint: 'A'.repeat(43) })
  expect(decodePeerInvite(withPin).tlsFingerprint).toBe('A'.repeat(43))
  expect(() => decodePeerInvite(encodePeerInvite({ ...payload, tlsFingerprint: 'short' } as PeerInvitePayload)))
    .toThrow(PeerError)
})

it('rejects an empty invitation body and an unparsable origin', () => {
  expect(() => decodePeerInvite(`${PEER_INVITE_SCHEME}//`)).toThrowError(/INVALID_URI/)
  expect(() => validateOrigin({ origin: 'not a url' })).toThrowError(/INVALID_PAYLOAD/)
})

it('rejects foreign schemes, traversal, and oversized URIs', () => {
  expect(() => decodePeerInvite('https://example.org/invite')).toThrowError(/INVALID_URI/)
  expect(() => decodePeerInvite(`${PEER_INVITE_SCHEME}//${'A'.repeat(5000)}`)).toThrowError(/INVALID_URI/)
  expect(() => decodePeerInvite(`${PEER_INVITE_SCHEME}//abc?def`)).toThrowError(/INVALID_URI/)
  expect(() => decodePeerInvite(`${PEER_INVITE_SCHEME}//${Buffer.from('{"version":1}').toString('base64url')}/../x`))
    .toThrowError(/INVALID_URI/)
  expect(() => decodePeerInvite(`${PEER_INVITE_SCHEME}//ab/cd`)).toThrowError(/INVALID_URI/)
  expect(() => decodePeerInvite(`${PEER_INVITE_SCHEME}//%%%%%`)).toThrowError(/INVALID_PAYLOAD/)
})

it('rejects payloads with a wrong version, id, name, token, or endpoint', () => {
  const invalid = (value: unknown): PeerInvitePayload => value as PeerInvitePayload
  expect(() => decodePeerInvite(encodePeerInvite(invalid({ ...payload, version: 2 })))).toThrowError(/INVALID_PAYLOAD/)
  expect(() => decodePeerInvite(encodePeerInvite(invalid(null)))).toThrowError(/INVALID_PAYLOAD/)
  expect(() => decodePeerInvite(encodePeerInvite(invalid([])))).toThrowError(/INVALID_PAYLOAD/)
  expect(() => decodePeerInvite(encodePeerInvite(invalid({ ...payload, instanceId: 5 })))).toThrowError(/INVALID_PAYLOAD/)
  expect(() => decodePeerInvite(encodePeerInvite({ ...payload, instanceId: 'not-a-uuid' } as PeerInvitePayload))).toThrowError(/INVALID_PAYLOAD/)
  expect(() => decodePeerInvite(encodePeerInvite({ ...payload, displayName: '' } as PeerInvitePayload))).toThrowError(/INVALID_PAYLOAD/)
  expect(() => decodePeerInvite(encodePeerInvite({ ...payload, displayName: 'x'.repeat(65) } as PeerInvitePayload))).toThrowError(/INVALID_PAYLOAD/)
  expect(() => decodePeerInvite(encodePeerInvite({ ...payload, token: 'nope' } as PeerInvitePayload))).toThrowError(/INVALID_PAYLOAD/)
  expect(() => decodePeerInvite(encodePeerInvite({ ...payload, endpoint: { origin: 'http://build.example.org:8443' } } as PeerInvitePayload)))
    .toThrowError(/INVALID_PAYLOAD/)
})

it('accepts loopback HTTP origins and rejects paths, queries, and credentials', () => {
  expect(validateOrigin({ origin: 'http://127.0.0.1:42001' })).toBe('http://127.0.0.1:42001')
  expect(validateOrigin({ origin: 'http://[::1]:8080' })).toBe('http://[::1]:8080')
  expect(() => validateOrigin({ origin: 'https://example.org/path' })).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateOrigin({ origin: 'https://user:pw@example.org' })).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateOrigin({ origin: 'https://example.org?q=1' })).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateOrigin(null)).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateOrigin([])).toThrowError(/INVALID_PAYLOAD/)
  expect(() => validateOrigin({ host: 'example.org' })).toThrowError(/INVALID_PAYLOAD/)
})

it('validates instance ids and derives peer grant names in both directions', () => {
  expect(peerInstanceId(instanceId)).toBe(instanceId)
  expect(() => peerInstanceId(instanceId.toUpperCase())).toThrowError(/INVALID_PAYLOAD/)
  expect(() => peerInstanceId('x')).toThrowError(/INVALID_PAYLOAD/)
  expect(peerGrantName(instanceId)).toBe(`peer-${instanceId}`)
  expect(instanceIdOfGrantName(`peer-${instanceId}`)).toBe(instanceId)
  expect(instanceIdOfGrantName('peer-not-a-uuid')).toBeUndefined()
  expect(instanceIdOfGrantName('other-name')).toBeUndefined()
  expect(newPeerInstanceId()).toMatch(/^[0-9a-f-]{36}$/)
})

it('bounds display names to non-control characters and publishes the pairing constants', () => {
  expect(isDisplayName('a')).toBe(true)
  expect(isDisplayName('')).toBe(false)
  expect(isDisplayName('x'.repeat(65))).toBe(false)
  expect(isDisplayName('bad\u0007name')).toBe(false)
  expect(isDisplayName(7)).toBe(false)
  expect(PEER_CAPABILITY).toBe('harniverse.peer')
  expect(PEER_ENROLLMENT_KIND).toBe('peer')
  expect(DEFAULT_INVITE_TTL_MS).toBe(600_000)
})
