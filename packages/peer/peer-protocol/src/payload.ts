/** Invite payload codec and shared naming constants. */

import { randomUUID } from 'node:crypto'
import { PeerError } from './errors.ts'
import type { PeerInstanceId, PeerInvitePayload } from './types.ts'

/** Capability gating every `peer/*` Remote; paired peers carry exactly this one capability. */
export const PEER_CAPABILITY = 'harniverse.peer' as const

/** Enrollment kind a pairing initiator submits; redemption approves it as an API-client Grant. */
export const PEER_ENROLLMENT_KIND = 'peer' as const

/** URI scheme of one pasted pairing invitation. */
export const PEER_INVITE_SCHEME = 'dsh-peer:' as const

/** Default invitation lifetime for `peer invite` when no `--ttl` is given. */
export const DEFAULT_INVITE_TTL_MS = 10 * 60_000

/** The full pairing surface approved by the shipped invitation flow. */
export const FULL_PEER_SURFACE = { delegate: true, message: true, list: true } as const

/**
 * Validate and mint one home-anchored instance id.
 * @param value - candidate id string.
 * @returns the id unchanged when it is a canonical lowercase UUID.
 */
export function peerInstanceId(value: string): PeerInstanceId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new PeerError('INVALID_PAYLOAD', 'instance id must be a lowercase UUID')
  }
  return value
}

/** Mint one fresh instance id for a new home.
 * @returns a new canonical lowercase-UUID id.
 */

export function newPeerInstanceId(): PeerInstanceId {
  return randomUUID()
}

/**
 * Grant-name convention binding one paired peer to its registry entry.
 * @param instanceId - the peer's home-anchored identity.
 * @returns the registry-unique grant name for that peer.
 */
export function peerGrantName(instanceId: PeerInstanceId): string {
  return `peer-${instanceId}`
}

/**
 * Extract an instance id from a grant name minted by {@link peerGrantName}.
 * @param name - candidate grant name.
 * @returns the instance id, or `undefined` when the name is not a peer grant name.
 */
export function instanceIdOfGrantName(name: string): PeerInstanceId | undefined {
  if (!name.startsWith('peer-')) return undefined
  const candidate = name.slice('peer-'.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)
    ? candidate
    : undefined
}

/**
 * Encode one invitation payload as the single-paste `dsh-peer:` URI.
 * @param payload - complete invitation payload.
 * @returns the URI handed to the initiator.
 */
export function encodePeerInvite(payload: PeerInvitePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${PEER_INVITE_SCHEME}//${body}`
}

/**
 * Decode and validate one pasted invitation URI.
 * @param uri - the exact pasted string.
 * @returns the validated payload.
 * @throws a {@link PeerError} with a closed reason for malformed invitations.
 */
export function decodePeerInvite(uri: string): PeerInvitePayload {
  if (typeof uri !== 'string' || !uri.startsWith(`${PEER_INVITE_SCHEME}//`)) throw new PeerError('INVALID_URI')
  const body = uri.slice(PEER_INVITE_SCHEME.length + 2)
  if (body.length === 0 || body.length > 4096 || body.includes('/') || body.includes('?') || body.includes('#')) {
    throw new PeerError('INVALID_URI')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new PeerError('INVALID_PAYLOAD')
  }
  return validatePeerInvite(parsed)
}

/**
 * Validate one decoded invitation payload.
 * @param value - decoded JSON value.
 * @returns the validated payload.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` naming the violated shape.
 */
export function validatePeerInvite(value: unknown): PeerInvitePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new PeerError('INVALID_PAYLOAD')
  if (typeof record.instanceId !== 'string') throw new PeerError('INVALID_PAYLOAD')
  peerInstanceId(record.instanceId)
  if (!isDisplayName(record.displayName)) throw new PeerError('INVALID_PAYLOAD')
  const origin = validateOrigin(record.endpoint)
  if (typeof record.token !== 'string' || !/^dshi1_[A-Za-z0-9_-]{16,128}$/.test(record.token)) {
    throw new PeerError('INVALID_PAYLOAD')
  }
  if (record.tlsFingerprint !== undefined
    && (typeof record.tlsFingerprint !== 'string' || !/^[A-Za-z0-9+/]{43}$/.test(record.tlsFingerprint))) {
    throw new PeerError('INVALID_PAYLOAD')
  }
  return {
    version: 1,
    instanceId: record.instanceId,
    displayName: record.displayName,
    endpoint: { origin },
    token: record.token,
    ...(record.tlsFingerprint !== undefined && { tlsFingerprint: record.tlsFingerprint }),
  }
}

/**
 * Validate one display name against the shared bound.
 * @param value - candidate value.
 * @returns whether the name is 1-64 non-control characters.
 */
export function isDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Validate one peer endpoint origin: HTTPS, or loopback HTTP for tunneled transports.
 * @param value - candidate endpoint value.
 * @returns the validated origin string.
 * @throws a {@link PeerError} with `INVALID_PAYLOAD` for non-origin or non-HTTPS remote origins.
 */
export function validateOrigin(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_PAYLOAD')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record.origin !== 'string') throw new PeerError('INVALID_PAYLOAD')
  let parsed: URL
  try {
    parsed = new URL(record.origin)
  } catch {
    throw new PeerError('INVALID_PAYLOAD')
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new PeerError('INVALID_PAYLOAD')
  if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new PeerError('INVALID_PAYLOAD')
  }
  return parsed.origin
}
