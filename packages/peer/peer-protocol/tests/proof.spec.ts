/** Proof vocabulary: canonical messages, signature verification, and request-proof validation. */

import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PEER_PROOF_SKEW_MS,
  PeerError,
  peerHelloMessage,
  peerRequestMessage,
  verifyPeerRequestProof,
  verifyPeerSignature,
} from '../src/index.ts'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
const { privateKey: otherKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })

/** Sign one payload with the suite's P-256 key, mirroring the client's encoder. */
function signWith(key: typeof privateKey, payload: string): string {
  return sign('sha256', Buffer.from(payload, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
}

describe('canonical proof messages', () => {
  it('formats hello and request messages deterministically', () => {
    expect(peerHelloMessage('01234567-89ab-cdef-0123-456789abcdef', 'nonce-1'))
      .toBe('dsh-peer-hello/1:01234567-89ab-cdef-0123-456789abcdef:nonce-1')
    expect(peerRequestMessage('01234567-89ab-cdef-0123-456789abcdef', 1000))
      .toBe('dsh-peer-request/1:01234567-89ab-cdef-0123-456789abcdef:1000')
  })
})

describe('verifyPeerSignature', () => {
  it('accepts a valid P-256 signature over the exact message', () => {
    const message = peerHelloMessage('01234567-89ab-cdef-0123-456789abcdef', 'nonce-1')
    expect(verifyPeerSignature(publicKeyB64, message, signWith(privateKey, message))).toBe(true)
  })

  it('rejects a signature over a different message or made by another key', () => {
    const message = peerHelloMessage('01234567-89ab-cdef-0123-456789abcdef', 'nonce-1')
    expect(verifyPeerSignature(publicKeyB64, peerHelloMessage('01234567-89ab-cdef-0123-456789abcdef', 'nonce-2'), signWith(privateKey, message))).toBe(false)
    expect(verifyPeerSignature(publicKeyB64, message, signWith(otherKey, message))).toBe(false)
  })

  it('rejects malformed key or signature material', () => {
    const message = peerHelloMessage('01234567-89ab-cdef-0123-456789abcdef', 'nonce-1')
    const signature = signWith(privateKey, message)
    expect(verifyPeerSignature('', message, signature)).toBe(false)
    // The replacement must differ from the original character, or the mutation is a no-op
    // against a per-run random key and the signature still verifies.
    const replacement = ['A', 'B', 'C'].find(char => char !== publicKeyB64[40] && char !== publicKeyB64[41]) ?? 'D'
    expect(verifyPeerSignature(publicKeyB64.slice(0, 40) + replacement + publicKeyB64.slice(41), message, signature)).toBe(false)
    expect(verifyPeerSignature(publicKeyB64, message, '')).toBe(false)
    expect(verifyPeerSignature('a'.repeat(600), message, signature)).toBe(false)
    const ed25519 = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    expect(verifyPeerSignature(ed25519, message, signature)).toBe(false)
  })
})

describe('verifyPeerRequestProof', () => {
  const instanceId = '01234567-89ab-cdef-0123-456789abcdef'
  const now = 1_700_000_000_000

  /** Build one signed proof for the given timestamp. */
  function proof(timestamp: number, key: typeof privateKey = privateKey): { instanceId: string; timestamp: number; signature: string } {
    return { instanceId, timestamp, signature: signWith(key, peerRequestMessage(instanceId, timestamp)) }
  }

  it('accepts a fresh correctly signed proof', () => {
    expect(() => { verifyPeerRequestProof(proof(now), publicKeyB64, now) }).not.toThrow()
    expect(() => { verifyPeerRequestProof(proof(now + PEER_PROOF_SKEW_MS), publicKeyB64, now) }).not.toThrow()
    expect(() => { verifyPeerRequestProof(proof(now - PEER_PROOF_SKEW_MS), publicKeyB64, now) }).not.toThrow()
  })

  it('rejects stale timestamps, foreign keys, and signature mismatches', () => {
    const stale = now + PEER_PROOF_SKEW_MS + 1
    expect(() => { verifyPeerRequestProof(proof(stale), publicKeyB64, now) }).toThrowError(PeerError)
    expect(() => { verifyPeerRequestProof(proof(now, otherKey), publicKeyB64, now) }).toThrowError(/INVALID_PROOF/)
    const tampered = { ...proof(now), signature: signWith(otherKey, peerRequestMessage(instanceId, now)) }
    expect(() => { verifyPeerRequestProof(tampered, publicKeyB64, now) }).toThrowError(/INVALID_PROOF/)
  })

  it('rejects malformed shapes and missing pinned keys', () => {
    expect(() => { verifyPeerRequestProof(null, publicKeyB64, now) }).toThrowError(/INVALID_PROOF/)
    expect(() => { verifyPeerRequestProof({}, publicKeyB64, now) }).toThrowError(/INVALID_PROOF/)
    expect(() => { verifyPeerRequestProof({ instanceId, timestamp: now }, publicKeyB64, now) }).toThrowError(/INVALID_PROOF/)
    expect(() => { verifyPeerRequestProof({ ...proof(now), extra: 1 }, publicKeyB64, now) }).toThrowError(/INVALID_PROOF/)
    expect(() => { verifyPeerRequestProof({ ...proof(now), instanceId: 'not-a-uuid' }, publicKeyB64, now) }).toThrowError(/INVALID_PROOF/)
    expect(() => { verifyPeerRequestProof(proof(now), undefined, now) }).toThrowError(/no pinned key/)
  })
})
