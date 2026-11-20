/** Cryptographic proofs binding Remote calls to the initiator's pinned identity key. */

import { createPublicKey, verify } from 'node:crypto'
import { PeerError } from './errors.ts'
import type { PeerInstanceId } from './types.ts'

/** How long one minted `peer/challenge` nonce stays redeemable. */
export const PEER_CHALLENGE_TTL_MS = 5 * 60_000

/** Accepted clock skew around a request proof's timestamp claim. */
export const PEER_PROOF_SKEW_MS = 90_000

/** How long one consumed request nonce stays replay-blocked: the full skew window either side of the claim. */
export const PEER_NONCE_TTL_MS = 2 * PEER_PROOF_SKEW_MS

/** How long one minted stream token stays redeemable at the event-stream route. */
export const PEER_STREAM_TOKEN_TTL_MS = 60_000

/** Heartbeat cadence the event stream maintains, in milliseconds. */
export const PEER_STREAM_HEARTBEAT_MS = 15_000

/**
 * Canonical hello message signed by the initiator's key.
 * @param instanceId - the asserted identity.
 * @param challenge - the nonce minted by `peer/challenge`.
 * @returns the exact string to sign.
 */
export function peerHelloMessage(instanceId: PeerInstanceId, challenge: string): string {
  return `dsh-peer-hello/1:${instanceId}:${challenge}`
}

/**
 * Canonical request message signed by the initiator's key.
 * @param instanceId - the caller's pinned identity.
 * @param timestamp - epoch-millisecond claim riding the proof.
 * @param nonce - the proof's single-use nonce, covered by the signature.
 * @returns the exact string to sign.
 */
export function peerRequestMessage(instanceId: PeerInstanceId, timestamp: number, nonce: string): string {
  return `dsh-peer-request/2:${instanceId}:${String(timestamp)}:${nonce}`
}

/**
 * Verify one detached P-256 signature against a base64url SPKI public key.
 * @param publicKey - base64url DER SubjectPublicKeyInfo.
 * @param message - the exact signed string.
 * @param signature - base64url IEEE-P1363 ECDSA/SHA-256 signature.
 * @returns whether the signature matches; malformed key or signature material is `false`.
 */
export function verifyPeerSignature(publicKey: string, message: string, signature: string): boolean {
  if (typeof publicKey !== 'string' || publicKey.length === 0 || publicKey.length > 512
    || typeof signature !== 'string' || signature.length === 0 || signature.length > 512) return false
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec') return false
    return verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

/**
 * Validate one request proof's shape, freshness, and signature against a pinned key.
 * @param proof - untrusted wire proof.
 * @param pinnedKey - the record's pinned base64url SPKI key.
 * @param nowMs - the verifier's clock, in epoch milliseconds.
 * @returns the proof's nonce when every check passes.
 * @throws a {@link PeerError} with `INVALID_PROOF` for any malformed, stale, or mismatched proof.
 */
export function verifyPeerRequestProof(proof: unknown, pinnedKey: string | undefined, nowMs: number): string {
  if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) throw new PeerError('INVALID_PROOF')
  const record = proof as Record<string, unknown>
  if (Object.keys(record).length !== 4 || typeof record.instanceId !== 'string'
    || typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)
    || typeof record.nonce !== 'string' || record.nonce.length === 0 || record.nonce.length > 128
    || typeof record.signature !== 'string') {
    throw new PeerError('INVALID_PROOF')
  }
  if (pinnedKey === undefined) throw new PeerError('INVALID_PROOF', 'no pinned key')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.instanceId)) {
    throw new PeerError('INVALID_PROOF')
  }
  if (Math.abs(nowMs - record.timestamp) > PEER_PROOF_SKEW_MS) throw new PeerError('INVALID_PROOF', 'stale timestamp')
  if (!verifyPeerSignature(pinnedKey, peerRequestMessage(record.instanceId, record.timestamp, record.nonce), record.signature)) {
    throw new PeerError('INVALID_PROOF')
  }
  return record.nonce
}
