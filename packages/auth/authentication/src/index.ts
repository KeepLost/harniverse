/** Inbound network authentication service definition. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Authentication behavior selected for one network-serving process. */
export type AuthenticationMode = 'authenticated' | 'bypass'

/** A user-chosen non-secret label for one access token. */
export type AuthenticationTokenName = Branded<'AuthenticationTokenName'>

/** Opaque non-secret lookup identity for one access token. */
export type AuthenticationTokenId = Branded<'AuthenticationTokenId'>

/** Network carrier whose admission is being authenticated. */
export type AuthenticationChannel = 'http-api' | 'websocket-mux' | 'websocket-host'

/**
 * Validate and brand one token name.
 * @param value - untrusted token management name.
 * @returns the validated token name.
 */
export function authenticationTokenName(value: string): AuthenticationTokenName {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new TypeError('authentication token name must match ^[a-z0-9][a-z0-9._-]{0,63}$')
  }
  return value as AuthenticationTokenName
}

/**
 * Brand a provider-validated opaque token id.
 * @param value - opaque non-empty provider id.
 * @returns the branded token id.
 */
export function authenticationTokenId(value: string): AuthenticationTokenId {
  if (value.length === 0) throw new TypeError('authentication token id must not be empty')
  return value as AuthenticationTokenId
}

/** Normalized network request facts needed by the authentication provider. */
export interface AuthenticationAttempt {
  /** Carrier requesting admission. */
  channel: AuthenticationChannel
  /** Raw Authorization header, when present. */
  authorization?: string
  /** Raw Cookie header, when present. */
  cookie?: string
  /** Direct socket peer address, when available. */
  peerAddress?: string
}

/** Credential revision that authenticated one accepted connection. */
export interface AuthenticationCredential {
  /** Stable token identity used for targeted revocation. */
  tokenId: AuthenticationTokenId
  /** Non-secret token label used in access records. */
  tokenName: AuthenticationTokenName
  /** Positive generation that increases monotonically for one token id. */
  generation: number
}

/** Admission decision for one network request. */
export type AuthenticationDecision =
  | { kind: 'accepted'; credential?: AuthenticationCredential }
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
  credential: AuthenticationCredential
}

/** Browser login result without transport-specific cookie fields. */
export type BrowserAuthenticationDecision =
  | { kind: 'accepted'; session: BrowserAuthenticationSession }
  | Extract<AuthenticationDecision, { kind: 'rejected' }>

/** Token revisions invalidated by one committed registry reload. */
export interface AuthenticationRevocation {
  /** Invalidated credential revisions. */
  credentials: AuthenticationCredential[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    authentication: InboundAuthentication
  }

  interface Events {
    /**
     * A committed token registry change invalidated credential revisions.
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
   * @returns accepted credential revision or a stable rejection reason.
   */
  abstract authenticate(attempt: AuthenticationAttempt): Promise<AuthenticationDecision>

  /**
   * Read process-wide admission state for the browser login gate.
   * @returns the active mode and whether authenticated admission has no tokens.
   */
  abstract status(): Promise<AuthenticationStatus>

  /**
   * Verify one token and issue an in-memory browser session.
   * @param token - raw token value supplied by the browser login form.
   * @param peerAddress - direct socket peer used only for the access record.
   * @returns the issued session or a stable rejection reason.
   */
  abstract createBrowserSession(token: string, peerAddress?: string): Promise<BrowserAuthenticationDecision>

  /**
   * Revoke the browser session named by a raw Cookie header, when present.
   * @param cookie - raw Cookie header from the logout request.
   */
  abstract revokeBrowserSession(cookie?: string): void
}

export default InboundAuthentication
