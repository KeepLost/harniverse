/** Accepting side of instance pairing: capability-gated identity readback and the paired-peer store. */

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  FULL_PEER_SURFACE,
  PEER_CHALLENGE_TTL_MS,
  PeerError,
  isDisplayName,
  peerHelloMessage,
  peerInstanceId,
  readInstanceIdentity,
  verifyPeerRequestProof,
  verifyPeerSignature,
} from '@deepseek-ai/dsh-peer-protocol'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { PeerDelegateRequest, PeerFollowupRequest, PeerHello, PeerHelloInput, PeerHelloRequest, PeerInstanceId, PeerRecord, PeerRequestProof, PeerRunResult, PeerSessionSummary } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerHostConfig } from './types.ts'
import { delegateToPeer, dropPeerSessions, followupPeerSession, listPeerSessions, validateDelegateRequest, validateFollowupRequest, validateSessionsRequest } from './delegate.ts'
import { findPeer, readPeerStore, writePeerStore } from './store.ts'

const { version: PEER_HOST_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Upper bound on simultaneously outstanding pairing challenges. */
const MAX_PENDING_CHALLENGES = 256

export type * from './types.ts'
export { findPeer, parsePeerRecord, peerStorePath, readPeerStore, writePeerStore } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { peerHost: PeerHost }
  interface Events {
    /**
     * Emitted after one peer's first `peer/hello` appended its record.
     * @mode emit
     * @param record - the committed paired-peer record.
     */
    'peer/paired'(record: PeerRecord): void
    /**
     * Emitted after one paired-peer record was removed from the store.
     * @mode emit
     * @param record - the removed record's final state.
     */
    'peer/removed'(record: PeerRecord): void
  }
}

/** Peer acceptance service; the store file is the authority and events are live-process observations. */
export class PeerHost extends TypertRemoteService {
  static Config: z<PeerHostConfig> = z.object({ dshHome: z.string() })

  /** Resolved Harness home holding the identity file and the peer store. */
  readonly home: string

  /** Outstanding single-use pairing challenges by nonce. */
  private readonly pendingChallenges = new Map<string, number>()

  constructor(ctx: Context, config: PeerHostConfig = {}) {
    super(ctx, 'peerHost', { namespace: 'peer' })
    this.home = resolveDshHome(config.dshHome)
  }

  /** Mint one single-use pairing challenge for the hello proof exchange.
   * @returns the nonce to sign and its lifetime boundary.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async challenge(): Promise<{ challenge: string }> {
    return await this.remote(() => {
      assertPairableWorld()
      const now = Date.now()
      for (const [nonce, expiresAt] of this.pendingChallenges) {
        if (expiresAt <= now) this.pendingChallenges.delete(nonce)
      }
      if (this.pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
        this.pendingChallenges.delete(this.pendingChallenges.keys().next().value as string)
      }
      const challenge = randomBytes(24).toString('base64url')
      this.pendingChallenges.set(challenge, now + PEER_CHALLENGE_TTL_MS)
      return { challenge }
    })
  }

  /** Run one Remote body, carrying the closed peer reasons onto the wire.
   * @param body - the Remote method's body.
   * @returns the body's result.
   */
  private async remote<T>(body: () => T | Promise<T>): Promise<T> {
    try {
      return await body()
    } catch (error) {
      if (error instanceof PeerError) throw new RemoteError('peer-failed', error.message, { reason: error.reason })
      throw error
    }
  }

  /** Answer one authenticated peer's identity readback and commit its pinned paired record.
   * @param request - the initiator's identity plus its challenge signature.
   * @returns this instance's identity and the approved surface.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async hello(request: PeerHelloRequest): Promise<PeerHello> {
    return await this.remote(async () => {
      assertPairableWorld()
      const input = validateHello(request)
      const self = await readInstanceIdentity(this.home)
      const peers = await readPeerStore(this.home)
      const now = new Date().toISOString()
      const existing = findPeer(peers, input.instanceId)
      if (existing?.status === 'revoked') throw new PeerError('HELLO_REJECTED', 'peer is revoked')
      const pinned = existing?.identityPublicKey
      const verifyingKey = pinned ?? request.proof.publicKey
      if (!this.consumeChallenge(request.challenge)) throw new PeerError('CHALLENGE_EXPIRED')
      if (pinned !== undefined && pinned !== request.proof.publicKey) throw new PeerError('IDENTITY_MISMATCH')
      if (!verifyPeerSignature(verifyingKey, peerHelloMessage(input.instanceId, request.challenge), request.proof.signature)) {
        throw new PeerError('INVALID_PROOF')
      }
      const record: PeerRecord = {
        instanceId: input.instanceId,
        displayName: input.displayName,
        platform: input.platform,
        arch: input.arch,
        version: input.version,
        surface: existing?.surface ?? { ...FULL_PEER_SURFACE },
        pairedVia: 'invitation',
        status: 'active',
        identityPublicKey: pinned ?? request.proof.publicKey,
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
      }
      await writePeerStore(this.home, [...peers.filter(peer => peer.instanceId !== input.instanceId), record])
      if (existing === undefined) this.ctx.emit('peer/paired', record)
      return {
        instanceId: self.instanceId,
        displayName: self.displayName,
        platform: self.platform,
        arch: self.arch,
        version: PEER_HOST_VERSION,
        surface: record.surface,
      }
    })
  }

  /** Remove one paired-peer record, end its delegated sessions, and report the removed record.
   * @param instanceId - exact instance id to remove.
   * @returns the removed record.
   * @throws a {@link PeerError} with `RECORD_NOT_FOUND` when no such peer is stored.
   */
  async removePeer(instanceId: PeerInstanceId): Promise<PeerRecord> {
    const peers = await readPeerStore(this.home)
    const existing = findPeer(peers, instanceId)
    if (existing === undefined) throw new PeerError('RECORD_NOT_FOUND')
    await writePeerStore(this.home, peers.filter(peer => peer.instanceId !== instanceId))
    await dropPeerSessions(this.ctx, this.home, instanceId)
    this.ctx.emit('peer/removed', existing)
    return existing
  }

  /** Redeem one minted challenge exactly once.
   * @param challenge - the nonce presented by the hello proof.
   * @returns whether the nonce was outstanding and unexpired.
   */
  private consumeChallenge(challenge: string): boolean {
    const expiresAt = this.pendingChallenges.get(challenge)
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      if (expiresAt !== undefined) this.pendingChallenges.delete(challenge)
      return false
    }
    this.pendingChallenges.delete(challenge)
    return true
  }

  /** Resolve and authenticate the calling peer of one Remote request.
   * @param proof - untrusted request proof from the wire.
   * @returns the verified record.
   */
  private async authenticate(proof: PeerRequestProof): Promise<PeerRecord> {
    const peers = await readPeerStore(this.home)
    const record = findPeer(peers, proof.instanceId)
    if (record === undefined) throw new PeerError('RECORD_NOT_FOUND')
    if (record.status === 'revoked') throw new PeerError('HELLO_REJECTED', 'peer is revoked')
    verifyPeerRequestProof(proof, record.identityPublicKey, Date.now())
    return record
  }

  /** Start one delegated session for the calling peer and await its first settlement.
   * @param request - proof, prompt, and optional working directory, profile, and budget.
   * @returns the minted session and its first turn's terminal state.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async delegate(request: PeerDelegateRequest): Promise<PeerRunResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateDelegateRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.delegate) throw new PeerError('SURFACE_DENIED', 'delegate')
      return await delegateToPeer(this.ctx, this.home, record.instanceId, valid)
    })
  }

  /** Deliver the next turn into one session the calling peer owns.
   * @param request - proof, session id, prompt, and optional budget.
   * @returns the delivered turn's terminal state.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async followup(request: PeerFollowupRequest): Promise<PeerRunResult> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateFollowupRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.message) throw new PeerError('SURFACE_DENIED', 'message')
      return await followupPeerSession(this.ctx, this.home, record.instanceId, valid)
    })
  }

  /** Enumerate the calling peer's own delegated sessions.
   * @param request - proof of the calling peer.
   * @returns the caller's session summaries, newest activity first.
   */
  @Remote({ requiredCapability: 'harniverse.peer' })
  async sessions(request: { proof: PeerRequestProof }): Promise<{ sessions: PeerSessionSummary[] }> {
    return await this.remote(async () => {
      assertPairableWorld()
      const valid = validateSessionsRequest(request)
      const record = await this.authenticate(valid.proof)
      if (!record.surface.list) throw new PeerError('SURFACE_DENIED', 'list')
      return { sessions: await listPeerSessions(this.ctx, this.home, record.instanceId) }
    })
  }
}

/** Reject pairing inside a VM execution world; peers never serve from real-sandbox instances. */
function assertPairableWorld(): void {
  if (process.env.DSH_EXEC_WORLD === 'vm') throw new PeerError('PEER_UNAVAILABLE_VM')
}

/** Validate one hello request against the shared bounds.
 * @param value - untrusted wire value.
 * @returns the validated identity.
 */
function validateHello(value: unknown): PeerHelloInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PeerError('INVALID_HELLO')
  const envelope = value as Record<string, unknown>
  if (Object.keys(envelope).length !== 3 || typeof envelope.challenge !== 'string'
    || envelope.challenge.length === 0 || envelope.challenge.length > 128
    || typeof envelope.identity !== 'object' || envelope.identity === null || Array.isArray(envelope.identity)
    || typeof envelope.proof !== 'object' || envelope.proof === null || Array.isArray(envelope.proof)) {
    throw new PeerError('INVALID_HELLO')
  }
  const proof = envelope.proof as Record<string, unknown>
  if (Object.keys(proof).length !== 2 || typeof proof.publicKey !== 'string' || proof.publicKey.length === 0
    || typeof proof.signature !== 'string' || proof.signature.length === 0) {
    throw new PeerError('INVALID_HELLO')
  }
  const record = envelope.identity as Record<string, unknown>
  const keys = ['instanceId', 'displayName', 'platform', 'arch', 'version']
  if (keys.length !== Object.keys(record).length || keys.some(key => !(key in record))) throw new PeerError('INVALID_HELLO')
  if (typeof record.instanceId !== 'string') throw new PeerError('INVALID_HELLO')
  peerInstanceId(record.instanceId)
  if (!isDisplayName(record.displayName)) throw new PeerError('INVALID_HELLO')
  if (typeof record.platform !== 'string' || record.platform.length === 0 || record.platform.length > 32
    || typeof record.arch !== 'string' || record.arch.length === 0 || record.arch.length > 16
    || typeof record.version !== 'string' || record.version.length === 0 || record.version.length > 32) {
    throw new PeerError('INVALID_HELLO')
  }
  return record as unknown as PeerHelloInput
}

export default PeerHost
