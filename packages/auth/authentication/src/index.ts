/** Inbound network authentication service definition. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Authentication behavior selected for one network-serving process. */
export type AuthenticationMode = 'authenticated' | 'bypass'

/** Opaque non-secret identity of one approved access grant. */
export type AuthenticationGrantId = Branded<'AuthenticationGrantId'>

/** Opaque identity of one pending device enrollment. */
export type AuthenticationEnrollmentId = Branded<'AuthenticationEnrollmentId'>

/** Opaque identity of one single-use possession challenge. */
export type AuthenticationChallengeId = Branded<'AuthenticationChallengeId'>

/** Effect class authorized for an authenticated remote principal. */
export type AuthenticationCapability =
  | 'harniverse.observe'
  | 'harniverse.operate'
  | 'harniverse.administer'
  | 'harniverse.authorize'

/** Complete capability vocabulary in stable least-to-most-sensitive order. */
export const ALL_AUTHENTICATION_CAPABILITIES: readonly AuthenticationCapability[] = [
  'harniverse.observe',
  'harniverse.operate',
  'harniverse.administer',
  'harniverse.authorize',
]

/**
 * Test an untrusted value against the closed capability vocabulary.
 * @param value - candidate capability.
 * @returns whether the value is a supported authentication capability.
 */
export function isAuthenticationCapability(value: unknown): value is AuthenticationCapability {
  return typeof value === 'string'
    && (ALL_AUTHENTICATION_CAPABILITIES as readonly string[]).includes(value)
}

/** Identity and effective capabilities attached to one accepted invocation. */
export type AuthenticationPrincipal =
  | {
    /** Local development admission with no remote credential. */
    readonly kind: 'bypass'
    readonly capabilities: readonly AuthenticationCapability[]
  }
  | {
    /** Short-lived access derived from an approved public-key Grant. */
    readonly kind: 'grant'
    readonly grantId: AuthenticationGrantId
    readonly grantRevision: number
    readonly capabilities: readonly AuthenticationCapability[]
    readonly expiresAt: string
  }

/** Network carrier whose admission is being authenticated. */
export type AuthenticationChannel = 'http-api' | 'websocket-mux' | 'websocket-host'

/**
 * Brand a provider-validated opaque Grant id.
 * @param value - opaque non-empty provider id.
 * @returns the branded Grant id.
 */
export function authenticationGrantId(value: string): AuthenticationGrantId {
  if (value.length === 0) throw new TypeError('authentication grant id must not be empty')
  return value as AuthenticationGrantId
}

/**
 * Brand a provider-validated enrollment id.
 * @param value - opaque non-empty provider id.
 * @returns the branded enrollment id.
 */
export function authenticationEnrollmentId(value: string): AuthenticationEnrollmentId {
  if (value.length === 0) throw new TypeError('authentication enrollment id must not be empty')
  return value as AuthenticationEnrollmentId
}

/**
 * Brand a provider-validated challenge id.
 * @param value - opaque non-empty challenge id.
 * @returns the branded challenge id.
 */
export function authenticationChallengeId(value: string): AuthenticationChallengeId {
  if (value.length === 0) throw new TypeError('authentication challenge id must not be empty')
  return value as AuthenticationChallengeId
}

/** Normalized network request facts needed by the authentication provider. */
export interface AuthenticationAttempt {
  /** Carrier requesting admission. */
  channel: AuthenticationChannel
  /** Raw Authorization header, when present. */
  authorization?: string
  /** Opaque browser-session value selected by the transport, when present. */
  browserSession?: string
  /** Direct socket peer address, when available. */
  peerAddress?: string
}

/** Admission decision for one network request. */
export type AuthenticationDecision =
  | { kind: 'accepted'; principal: AuthenticationPrincipal }
  | { kind: 'rejected'; reason: 'missing-credential' | 'invalid-credential' | 'authentication-unavailable' }
  | {
    kind: 'rejected'
    reason: 'rate-limited'
    /** Milliseconds before another attempt may be made. */
    retryAfterMs: number
  }

/** Current process admission state exposed to the browser login gate. */
export interface AuthenticationStatus {
  mode: AuthenticationMode
  sealed: boolean
}

/** Browser session secret issued after one token is verified. */
export interface BrowserAuthenticationSession {
  value: string
  expiresAt: string
  principal: AuthenticationPrincipal
}

/** Browser login result without transport-specific cookie fields. */
export type BrowserAuthenticationDecision =
  | { kind: 'accepted'; session: BrowserAuthenticationSession }
  | Extract<AuthenticationDecision, { kind: 'rejected' }>

/** Exact Grant revision invalidated by one committed registry reload. */
export interface AuthenticationGrantRevision {
  grantId: AuthenticationGrantId
  grantRevision: number
}

/** Grant revisions invalidated by one committed registry reload. */
export interface AuthenticationRevocation {
  grants: AuthenticationGrantRevision[]
}

/** Public-key enrollment category available before browser plugin loading. */
export type AuthenticationEnrollmentKind = 'device' | 'temporary'

/** Request to enroll one browser-held P-256 key. */
export interface AuthenticationEnrollmentInput {
  name: string
  kind: AuthenticationEnrollmentKind
  /** Base64url DER SubjectPublicKeyInfo for an ECDSA P-256 key. */
  publicKey: string
}

/** Enrollment state returned to the requesting browser. */
export type AuthenticationEnrollmentStatus =
  | {
    state: 'pending'
    id: AuthenticationEnrollmentId
    approvalCode: string
    name: string
    kind: AuthenticationEnrollmentKind
    expiresAt: string
  }

  | {
    state: 'approved'
    id: AuthenticationEnrollmentId
    grantId: AuthenticationGrantId
    grantRevision: number
    capabilities: readonly AuthenticationCapability[]
    expiresAt: string
  }

/** Enrollment creation result with a stable overload response. */
export type AuthenticationEnrollmentDecision =
  | { kind: 'accepted'; value: Extract<AuthenticationEnrollmentStatus, { state: 'pending' }> }
  | { kind: 'rejected'; reason: 'authentication-unavailable' }
  | { kind: 'rejected'; reason: 'rate-limited'; retryAfterMs: number }

/** Owner-selected authorization and lifetime for a pending enrollment. */
export interface AuthenticationEnrollmentApproval {
  capabilities: readonly AuthenticationCapability[]
  expiresInMs?: number
  idleTimeoutMs?: number
}

/** Non-secret approved Grant metadata exposed to authorization management. */
export interface AuthenticationGrantSummary {
  id: AuthenticationGrantId
  name: string
  kind: 'device' | 'api-client' | 'temporary'
  revision: number
  capabilities: readonly AuthenticationCapability[]
  createdAt: string
  expiresAt?: string
  idleTimeoutMs?: number
  lastUsedAt?: string
}

/** Purpose bound into one signed possession challenge. */
export type AuthenticationChallengePurpose = 'access-token' | 'browser-session'

/** Challenge payload signed by the Grant's private key. */
export interface AuthenticationChallenge {
  id: AuthenticationChallengeId
  payload: string
  expiresAt: string
}

/** Proof submitted exactly once for a previously issued challenge. */
export interface AuthenticationChallengeProof {
  challengeId: AuthenticationChallengeId
  /** Base64url IEEE-P1363 ECDSA signature over the UTF-8 payload. */
  signature: string
}

/** Bearer Access Token returned only to non-browser clients. */
export interface AuthenticationAccessToken {
  value: string
  expiresAt: string
  principal: Extract<AuthenticationPrincipal, { kind: 'grant' }>
}

/** Stable rejection reasons for public enrollment and exchange routes. */
export type AuthenticationGrantDecision<T> =
  | { kind: 'accepted'; value: T }
  | { kind: 'rejected'; reason: 'invalid-grant' | 'invalid-proof' | 'expired' | 'authentication-unavailable' }

declare module '@deepseek-ai/cordis' {
  interface Context {
    authentication: InboundAuthentication
  }

  interface Events {
    /**
     * A committed Grant registry change invalidated Grant revisions.
     * @mode emit
     * @param revocation - revisions that must lose browser and socket admission.
     */
    'authentication/revoked'(revocation: AuthenticationRevocation): void

    /**
     * Credential freshness became unavailable; current sockets must close.
     * @mode emit
     */
    'authentication/unavailable'(): void

    /**
     * Credential freshness was reconciled after an unavailable interval.
     * @mode emit
     */
    'authentication/available'(): void
  }
}

/** Provider-neutral inbound network authentication service. */
export abstract class InboundAuthentication extends Service {
  constructor(ctx: Context) {
    super(ctx, 'authentication')
  }

  /** Active process authentication behavior. */
  abstract readonly mode: AuthenticationMode

  /**
   * Authenticate one HTTP or WebSocket admission attempt.
   * @param attempt - normalized headers, carrier, and direct peer.
   * @returns accepted principal or a stable rejection reason.
   */
  abstract authenticate(attempt: AuthenticationAttempt): Promise<AuthenticationDecision>

  /**
   * Read process-wide admission state for the browser login gate.
   * @returns the active mode and whether authenticated admission has no Grants.
   */
  abstract status(): Promise<AuthenticationStatus>

  /**
   * Exchange one signed challenge for an in-memory browser session.
   * @param proof - single-use proof made by the enrolled browser key.
   * @param peerAddress - direct socket peer used only for the access record.
   * @returns the issued session or a stable rejection reason.
   */
  abstract createBrowserSession(proof: AuthenticationChallengeProof, peerAddress?: string): Promise<BrowserAuthenticationDecision>

  /**
   * Submit one public-key enrollment request for later owner approval.
   * @param input - browser key and device metadata.
   * @param peerAddress - direct peer used for enrollment rate limiting.
   * @returns the pending enrollment or a stable overload response.
   */
  abstract requestEnrollment(
    input: AuthenticationEnrollmentInput,
    peerAddress?: string,
  ): Promise<AuthenticationEnrollmentDecision>

  /**
   * Read one enrollment request without exposing another request by name.
   * @param id - exact enrollment request id.
   * @returns pending or approved status, or `undefined` after removal.
   */
  abstract enrollmentStatus(id: AuthenticationEnrollmentId): Promise<AuthenticationEnrollmentStatus | undefined>

  /**
   * List enrollment requests awaiting an owner decision.
   * @returns pending enrollment requests visible to an authenticated owner.
   */
  abstract listPendingEnrollments(): Promise<readonly Extract<AuthenticationEnrollmentStatus, { state: 'pending' }>[]>

  /**
   * Approve one pending enrollment with an explicit capability and lifetime policy.
   * @param id - exact pending enrollment id.
   * @param approval - capabilities and optional lifetime restrictions.
   * @returns non-secret metadata for the committed Grant.
   */
  abstract approveEnrollment(
    id: AuthenticationEnrollmentId,
    approval: AuthenticationEnrollmentApproval,
  ): Promise<AuthenticationGrantSummary>

  /**
   * List approved Grants without exposing public keys.
   * @returns approved Grant metadata without public keys.
   */
  abstract listGrants(): Promise<readonly AuthenticationGrantSummary[]>

  /**
   * Revoke one approved Grant and its process-local credentials.
   * @param id - exact Grant id.
   */
  abstract revokeGrant(id: AuthenticationGrantId): Promise<void>

  /**
   * Issue one short-lived, single-use proof-of-possession challenge.
   * @param grantId - Grant expected to sign the challenge.
   * @param purpose - credential exchange purpose bound into the payload.
   * @returns the challenge or a stable rejection reason.
   */
  abstract createChallenge(
    grantId: AuthenticationGrantId,
    purpose: AuthenticationChallengePurpose,
  ): Promise<AuthenticationGrantDecision<AuthenticationChallenge>>

  /**
   * Exchange one signed access-token challenge for a short bearer token.
   * @param proof - single-use P-256 challenge proof.
   * @param peerAddress - direct peer recorded without credential material.
   * @returns the short Access Token or a stable rejection reason.
   */
  abstract exchangeAccessToken(
    proof: AuthenticationChallengeProof,
    peerAddress?: string,
  ): Promise<AuthenticationGrantDecision<AuthenticationAccessToken>>

  /**
   * Issue one short, nonrenewable bearer token from an owner Grant.
   * @param issuer - authenticated owner principal authorizing issuance.
   * @param capabilities - explicit reduced capabilities; authorize is forbidden.
   * @param ttlMs - requested positive lifetime bounded by Provider policy.
   * @returns the emergency Access Token or a stable rejection reason.
   */
  abstract issueEmergencyAccessToken(
    issuer: AuthenticationPrincipal,
    capabilities: readonly AuthenticationCapability[],
    ttlMs: number,
  ): Promise<AuthenticationGrantDecision<AuthenticationAccessToken>>

  /**
   * Revoke one opaque browser-session value, when present.
   * @param value - transport-selected browser-session value.
   */
  abstract revokeBrowserSession(value?: string): void
}

export default InboundAuthentication
