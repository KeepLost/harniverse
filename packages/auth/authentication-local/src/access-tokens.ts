/** Bounded process-memory Access Token ledger. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  AuthenticationAccessToken,
  AuthenticationCapability,
  AuthenticationGrantId,
  AuthenticationPrincipal,
} from '@deepseek-ai/dsh-authentication'
import { authenticationGrantDeadline, type AuthenticationGrant } from './grant-registry.ts'

interface AccessTokenSpec {
  ttlMs: number
  maxTokens: number
  maxTokensPerGrant: number
}

interface AccessTokenRecord {
  digest: Buffer
  principal: Extract<AuthenticationPrincipal, { kind: 'grant' }>
  expiresAt: number
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Issues and verifies short-lived bearer tokens without durable secret state. */
export class AccessTokenLedger {
  private readonly records = new Map<string, AccessTokenRecord>()

  constructor(private readonly spec: AccessTokenSpec) {}

  /**
   * Issue one Access Token whose authority is copied from the current Grant.
   * @param grant - current active Grant revision.
   * @returns the one-time bearer value, or `undefined` when other Grants consume global capacity.
   */
  issue(grant: AuthenticationGrant): AuthenticationAccessToken | undefined {
    return this.issueWith(grant, grant.capabilities, this.spec.ttlMs)
  }

  /**
   * Issue one unrenewable emergency token with reduced authority and lifetime.
   * @param grant - current authorizing Grant revision.
   * @param capabilities - explicit reduced capability subset.
   * @param ttlMs - requested positive lifetime.
   * @returns the one-time bearer value, or `undefined` when other Grants consume global capacity.
   */
  issueRestricted(
    grant: AuthenticationGrant,
    capabilities: readonly AuthenticationCapability[],
    ttlMs: number,
  ): AuthenticationAccessToken | undefined {
    return this.issueWith(grant, capabilities, Math.min(ttlMs, this.spec.ttlMs))
  }

  private issueWith(
    grant: AuthenticationGrant,
    capabilities: readonly AuthenticationCapability[],
    ttlMs: number,
  ): AuthenticationAccessToken | undefined {
    this.prune()
    const own = [...this.records]
      .filter(([, record]) => record.principal.grantId === grant.id && record.principal.grantRevision === grant.revision)
      .map(([id]) => id)
    if (own.length >= this.spec.maxTokensPerGrant) {
      const oldest = own[0]
      if (oldest !== undefined) this.records.delete(oldest)
    } else if (this.records.size >= this.spec.maxTokens) {
      return undefined
    }
    const id = randomBytes(12).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    const value = `dsha1_${id}_${secret}`
    const configuredExpiry = Date.now() + ttlMs
    const expiresAt = Math.min(configuredExpiry, authenticationGrantDeadline(grant))
    const principal: Extract<AuthenticationPrincipal, { kind: 'grant' }> = {
      kind: 'grant',
      grantId: grant.id,
      name: grant.name,
      grantRevision: grant.revision,
      capabilities: [...capabilities],
      expiresAt: new Date(expiresAt).toISOString(),
    }
    this.records.set(id, { digest: digest(secret), principal, expiresAt })
    return { value, expiresAt: principal.expiresAt, principal }
  }

  /**
   * Verify one bearer value and return its unexpired principal.
   * @param value - complete Access Token wire value.
   * @returns the admitted principal, or `undefined` for invalid or expired input.
   */
  authenticate(value: string): Extract<AuthenticationPrincipal, { kind: 'grant' }> | undefined {
    const match = /^dsha1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/.exec(value)
    if (match === null) return undefined
    const id = match[1]
    const secret = match[2]
    if (id === undefined || secret === undefined) return undefined
    const record = this.records.get(id)
    if (record === undefined) return undefined
    if (record.expiresAt <= Date.now()) {
      this.records.delete(id)
      return undefined
    }
    const actual = digest(secret)
    return timingSafeEqual(record.digest, actual) ? record.principal : undefined
  }

  /**
   * Remove all tokens issued by one exact Grant revision.
   * @param grantId - invalidated Grant id.
   * @param grantRevision - invalidated Grant revision.
   */
  revoke(grantId: AuthenticationGrantId, grantRevision: number): void {
    for (const [id, record] of this.records) {
      if (record.principal.grantId === grantId && record.principal.grantRevision === grantRevision) this.records.delete(id)
    }
  }

  /** Drop every token when durable Grant freshness is unavailable. */
  clear(): void {
    this.records.clear()
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, record] of this.records) if (record.expiresAt <= now) this.records.delete(id)
  }
}
