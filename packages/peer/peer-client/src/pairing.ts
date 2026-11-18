/** Pairing orchestration: enroll, redeem the invitation, exchange, and verify `peer/hello`. */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { GrantAccess } from '@deepseek-ai/dsh-sdk-client'
import {
  PEER_ENROLLMENT_KIND,
  PeerError,
  ensureInstanceIdentity,
  peerGrantName,
} from '@deepseek-ai/dsh-peer-protocol'
import type { PeerErrorReason, PeerHello, PeerInvitePayload, PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import { ensurePeerIdentityKey } from './keys.ts'
import { findPeerTarget, readPeerTargets, writePeerTargets } from './targets.ts'
import type { PeerPairingResult } from './types.ts'

const { version: CLIENT_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Inputs of one pairing run; the caller owns transport establishment. */
export interface PairOptions {
  /** Decoded invitation payload from the pasted URI. */
  invite: PeerInvitePayload
  /** Absolute initiator Harness home holding the identity, key, and target store. */
  home: string
  /** Origin the invitation endpoint resolves to for this run: the direct origin, or `http://127.0.0.1:<forwardPort>` behind a tunnel. */
  origin: string
  /** Fetch implementation bound to the transport; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
  /** Request timeout applied to each pairing call. */
  timeoutMs?: number
  /** Transport recorded on the persisted target; defaults to a direct dial. */
  transport?: PeerTarget['transport']
}

/**
 * Run one complete pairing against the invitation's target.
 * @param options - invitation, home, transport, and limits.
 * @returns the verified readback, Grant id, and persisted target record.
 * @throws a {@link PeerError} with a closed reason at each failed stage.
 */
export async function pairWithPeer(options: PairOptions): Promise<PeerPairingResult> {
  const { invite, home } = options
  const timeout = options.timeoutMs ?? 30_000
  const fetchImpl = bounded(options.fetch ?? ((input, init) => globalThis.fetch(input, init)), timeout)
  const identity = await ensureInstanceIdentity(home)
  const key = await ensurePeerIdentityKey(home)
  const grantName = peerGrantName(identity.instanceId)

  const paired = findPeerTarget(await readPeerTargets(home), invite.instanceId)
  let grantId: string
  if (paired?.status === 'active') {
    grantId = paired.grantId
  } else {
    const enrollment = await postJson(fetchImpl, options.origin, '/auth/enrollment', {
      name: grantName,
      kind: PEER_ENROLLMENT_KIND,
      publicKey: key.publicKey,
    }, 'ENROLLMENT_REJECTED') as { id?: string; state?: string }
    if (typeof enrollment.id !== 'string' || enrollment.state !== 'pending') throw new PeerError('ENROLLMENT_REJECTED')
    const redemption = await postJson(fetchImpl, options.origin, '/auth/enrollment/redeem', {
      id: enrollment.id,
      invitation: invite.token,
    }, 'REDEEM_REJECTED') as { state?: string; grantId?: string }
    if (redemption.state !== 'approved' || typeof redemption.grantId !== 'string') throw new PeerError('REDEEM_REJECTED')
    grantId = redemption.grantId
  }

  const access = new GrantAccess({ origin: options.origin, grantId,
    signChallenge: payload => key.signChallenge(payload), fetch: fetchImpl })
  const hello = await peerHello(access, options.origin, {
    instanceId: identity.instanceId,
    displayName: identity.displayName,
    platform: identity.platform,
    arch: identity.arch,
    version: CLIENT_VERSION,
  })
  if (hello.instanceId !== invite.instanceId) throw new PeerError('IDENTITY_MISMATCH')

  const target: PeerTarget = {
    targetInstanceId: invite.instanceId,
    displayName: hello.displayName,
    endpoint: { origin: invite.endpoint.origin },
    transport: options.transport ?? { kind: 'direct' },
    grantName,
    grantId,
    ...(invite.tlsFingerprint !== undefined && { tlsFingerprint: invite.tlsFingerprint }),
    status: 'active',
    addedAt: paired?.addedAt ?? new Date().toISOString(),
  }
  await writePeerTargets(home, [...(await readPeerTargets(home)).filter(entry => entry.targetInstanceId !== invite.instanceId), target])
  return { hello, grantId, target }
}

/** Call `peer/hello` through the authenticated Connection RPC envelope.
 * @param access - the target's Grant-backed transport.
 * @param origin - exact target origin.
 * @param identity - the initiator's self-asserted identity.
 * @returns the target's validated readback.
 */
async function peerHello(access: GrantAccess, origin: string, identity: Record<string, string>): Promise<PeerHello> {
  const rpcId = randomUUID()
  const response = await access.fetch(`${origin}/api/peer/hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'peer/hello', payload: { args: { identity } } }),
  })
  if (!response.ok) throw new PeerError('HELLO_REJECTED', `HTTP ${String(response.status)}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new PeerError('HELLO_REJECTED', 'non-JSON response')
  }
  const record = body as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown } }
  if (record.type !== 'server-response' || record.rpcId !== rpcId || record.result?.ok !== true) {
    throw new PeerError('HELLO_REJECTED')
  }
  return validateHello(record.result.value)
}

/** Validate one hello readback value.
 * @param value - untrusted wire value.
 * @returns the validated readback.
 */
function validateHello(value: unknown): PeerHello {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('HELLO_REJECTED')
  const record = value as Record<string, unknown>
  if (typeof record.instanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.instanceId)
    || typeof record.displayName !== 'string' || record.displayName.length === 0 || record.displayName.length > 64
    || typeof record.platform !== 'string' || typeof record.arch !== 'string' || typeof record.version !== 'string') {
    throw new PeerError('HELLO_REJECTED')
  }
  const surface = record.surface
  if (typeof surface !== 'object' || surface === null || Array.isArray(surface)) throw new PeerError('HELLO_REJECTED')
  const surfaceRecord = surface as Record<string, unknown>
  if (typeof surfaceRecord.delegate !== 'boolean' || typeof surfaceRecord.message !== 'boolean'
    || typeof surfaceRecord.list !== 'boolean') {
    throw new PeerError('HELLO_REJECTED')
  }
  return record as unknown as PeerHello
}

/** Post one JSON body and decode a JSON response, mapping rejection statuses to one closed reason.
 * @param fetchImpl - transport fetch.
 * @param origin - exact target origin.
 * @param path - absolute API path.
 * @param body - JSON request body value.
 * @param rejection - closed reason reported when the endpoint answers with a non-2xx status.
 * @returns the decoded response body.
 */
async function postJson(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  path: string,
  body: unknown,
  rejection: PeerErrorReason,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new PeerError('TRANSPORT_FAILED', failureName(error, 'request failed'))
  }
  if (!response.ok) throw new PeerError(rejection, `HTTP ${String(response.status)}`)
  try {
    return await response.json()
  } catch {
    throw new PeerError('TRANSPORT_FAILED', 'non-JSON response')
  }
}

/** Non-secret failure classification for a transport throw.
 * @param error - the thrown failure.
 * @param label - fixed label for non-Error throws.
 * @returns the error's constructor name, or the fixed label.
 */
/** Non-secret failure classification for a transport throw.
 * @param error - the thrown failure.
 * @param label - fixed label for non-Error throws.
 * @returns the error's constructor name, or the fixed label.
 */
function failureName(error: unknown, label: string): string {
  if (error instanceof Error) return error.name
  // fetch failures are Error instances; the label names the impossible.
  /* v8 ignore next */
  return label
}

/** Wrap one fetch with a per-call timeout.
 * @param fetchImpl - transport fetch.
 * @param timeoutMs - per-call timeout.
 * @returns the wrapped fetch.
 */
function bounded(fetchImpl: typeof globalThis.fetch, timeoutMs: number): typeof globalThis.fetch {
  return (input, init) => fetchImpl(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  })
}
