/** Bounded process-memory signed-challenge ledger. */
import { createPublicKey, randomBytes, verify } from 'node:crypto'
import {
  authenticationChallengeId,
  type AuthenticationChallenge,
  type AuthenticationChallengeId,
  type AuthenticationChallengeProof,
  type AuthenticationChallengePurpose,
  type AuthenticationGrantId,
} from '@deepseek-ai/dsh-authentication'
import type { AuthenticationGrant } from './grant-registry.ts'

interface ChallengeSpec {
  ttlMs: number
  maxChallenges: number
  maxChallengesPerGrant: number
}

interface ChallengeRecord {
  grantId: AuthenticationGrantId
  grantRevision: number
  purpose: AuthenticationChallengePurpose
  publicKey: string
  payload: string
  expiresAt: number
}

/** Accepted proof metadata needed to issue its requested credential. */
export interface AcceptedChallenge {
  kind: 'accepted'
  grantId: AuthenticationGrantId
  grantRevision: number
  purpose: AuthenticationChallengePurpose
}

/** Result of consuming one challenge. */
export type ConsumedChallenge = AcceptedChallenge | { kind: 'rejected'; reason: 'invalid-proof' | 'expired' }

/** Issues and consumes single-use ECDSA possession challenges. */
export class ChallengeLedger {
  private readonly records = new Map<AuthenticationChallengeId, ChallengeRecord>()

  constructor(private readonly spec: ChallengeSpec) {}

  /**
   * Issue one challenge bound to the current Grant revision.
   * @param instanceId - stable Provider instance identity bound into the payload.
   * @param grant - current Grant revision and public key.
   * @param purpose - credential exchange purpose.
   * @returns the signed payload input, or `undefined` when other Grants consume global capacity.
   */
  issue(instanceId: string, grant: AuthenticationGrant, purpose: AuthenticationChallengePurpose): AuthenticationChallenge | undefined {
    this.prune()
    const own = [...this.records]
      .filter(([, record]) => record.grantId === grant.id && record.grantRevision === grant.revision)
      .map(([id]) => id)
    // Free one per-Grant slot by evicting this Grant's oldest challenges. The
    // bound is a validated positive integer, so the slice is non-empty exactly
    // when the bound is reached.
    const excess = own.length - this.spec.maxChallengesPerGrant + 1
    if (excess > 0) {
      for (const id of own.slice(0, excess)) this.records.delete(id)
    } else if (this.records.size >= this.spec.maxChallenges) {
      return undefined
    }
    const id = authenticationChallengeId(randomBytes(12).toString('base64url'))
    const issuedAt = new Date().toISOString()
    const expiresAt = Date.now() + this.spec.ttlMs
    const payload = JSON.stringify({
      version: 1,
      instanceId,
      challengeId: id,
      grantId: grant.id,
      grantRevision: grant.revision,
      purpose,
      nonce: randomBytes(32).toString('base64url'),
      issuedAt,
      expiresAt: new Date(expiresAt).toISOString(),
    })
    this.records.set(id, {
      grantId: grant.id,
      grantRevision: grant.revision,
      purpose,
      publicKey: grant.publicKey,
      payload,
      expiresAt,
    })
    return { id, payload, expiresAt: new Date(expiresAt).toISOString() }
  }

  /**
   * Consume and verify one challenge; every presented id is single-use.
   * @param proof - challenge id and IEEE-P1363 signature.
   * @returns accepted Grant metadata or a stable rejection reason.
   */
  consume(proof: AuthenticationChallengeProof): ConsumedChallenge {
    const record = this.records.get(proof.challengeId)
    this.records.delete(proof.challengeId)
    if (record === undefined) return { kind: 'rejected', reason: 'invalid-proof' }
    if (record.expiresAt <= Date.now()) return { kind: 'rejected', reason: 'expired' }
    let valid = false
    try {
      valid = /^[A-Za-z0-9_-]{86}$/.test(proof.signature) && verify(
        'sha256',
        Buffer.from(record.payload),
        {
          key: createPublicKey({ key: Buffer.from(record.publicKey, 'base64url'), format: 'der', type: 'spki' }),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(proof.signature, 'base64url'),
      )
    } catch {
      valid = false
    }
    if (!valid) return { kind: 'rejected', reason: 'invalid-proof' }
    return {
      kind: 'accepted',
      grantId: record.grantId,
      grantRevision: record.grantRevision,
      purpose: record.purpose,
    }
  }

  /**
   * Remove challenges tied to an invalidated Grant revision.
   * @param grantId - invalidated Grant id.
   * @param grantRevision - invalidated Grant revision.
   */
  revoke(grantId: AuthenticationGrantId, grantRevision: number): void {
    for (const [id, record] of this.records) {
      if (record.grantId === grantId && record.grantRevision === grantRevision) this.records.delete(id)
    }
  }

  /** Drop every outstanding challenge when global Grant admission seals. */
  clear(): void {
    this.records.clear()
  }

  /**
   * Remove one issued challenge when its mandatory audit record fails.
   * @param id - exact unpublished challenge id.
   */
  discard(id: AuthenticationChallengeId): void {
    this.records.delete(id)
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, record] of this.records) if (record.expiresAt <= now) this.records.delete(id)
  }
}
