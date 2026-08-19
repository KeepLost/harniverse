# Inbound Authentication

English | [中文](authentication.zh.md)

The [authentication Service Definition](../../packages/auth/authentication) normalizes principals, capabilities, enrollment, proof-of-possession exchange, and admission for HTTP APIs and WebSockets. The shipped [local provider](../../packages/auth/authentication-local) persists public-key Grants and keeps challenges, short Access Tokens, and browser sessions in process memory. The connection consumer retains Host, Origin, Fetch Metadata, and DNS-rebinding checks as independent defenses.

Each endpoint requires one of four orthogonal capabilities: `harniverse.observe`, `harniverse.operate`, `harniverse.administer`, or `harniverse.authorize`. A Grant principal carries its exact Grant id and revision, capabilities, and expiry. Registry changes revoke matching Access Tokens, browser sessions, and WebSockets without invalidating unrelated Grants.

Authenticated startup permits an empty sealed registry so a browser can submit the first device enrollment request; local CLI approval creates the first owner Grant. Pending enrollment has a durable global bound and per-peer creation limit. Devices and API clients exchange a single-use P-256 signed challenge for a short credential. Temporary devices require expiry and idle timeout, emergency tokens cannot authorize, and `$DSH_HOME/auth/tokens.json` is rejected without migration. Explicit bypass retains the per-home instance lease and mandatory access records and remains loopback-only; all-interface listeners require direct TLS.

Source: [`packages/auth/authentication/src/index.ts`](../../packages/auth/authentication/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthentication--inboundauthentication-abstract-seam"></a>

### `ctx.authentication` — `InboundAuthentication` (abstract seam)

Provider-neutral inbound network authentication service.

```ts cordis-catalog
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
 * @returns the pending enrollment or a stable actionable rejection.
 */
abstract requestEnrollment( input: AuthenticationEnrollmentInput, peerAddress?: string, ): Promise<AuthenticationEnrollmentDecision>

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
abstract approveEnrollment( id: AuthenticationEnrollmentId, approval: AuthenticationEnrollmentApproval, ): Promise<AuthenticationGrantSummary>

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
abstract createChallenge( grantId: AuthenticationGrantId, purpose: AuthenticationChallengePurpose, ): Promise<AuthenticationGrantDecision<AuthenticationChallenge>>

/**
 * Exchange one signed access-token challenge for a short bearer token.
 * @param proof - single-use P-256 challenge proof.
 * @param peerAddress - direct peer recorded without credential material.
 * @returns the short Access Token or a stable rejection reason.
 */
abstract exchangeAccessToken( proof: AuthenticationChallengeProof, peerAddress?: string, ): Promise<AuthenticationGrantDecision<AuthenticationAccessToken>>

/**
 * Issue one short, nonrenewable bearer token from an owner Grant.
 * @param issuer - authenticated owner principal authorizing issuance.
 * @param capabilities - explicit reduced capabilities; authorize is forbidden.
 * @param ttlMs - requested positive lifetime bounded by Provider policy.
 * @returns the emergency Access Token or a stable rejection reason.
 */
abstract issueEmergencyAccessToken( issuer: AuthenticationPrincipal, capabilities: readonly AuthenticationCapability[], ttlMs: number, ): Promise<AuthenticationGrantDecision<AuthenticationAccessToken>>

/**
 * Revoke one opaque browser-session value, when present.
 * @param value - transport-selected browser-session value.
 */
abstract revokeBrowserSession(value?: string): void
```

Source: [`packages/auth/authentication/src/index.ts:260`](../../packages/auth/authentication/src/index.ts)

<a id="authentication-events"></a>

### `authentication/*` events

<a id="authenticationavailable--emit"></a>

#### `authentication/available` — emit

Credential freshness was reconciled after an unavailable interval.

```ts cordis-catalog
/**
 * Credential freshness was reconciled after an unavailable interval.
 * @mode emit
 */
'authentication/available'(): void
```

Source: [`packages/auth/authentication/src/index.ts:255`](../../packages/auth/authentication/src/index.ts)

<a id="authenticationrevoked--emit"></a>

#### `authentication/revoked` — emit

A committed Grant registry change invalidated Grant revisions.

```ts cordis-catalog
/**
 * A committed Grant registry change invalidated Grant revisions.
 * @mode emit
 * @param revocation - revisions that must lose browser and socket admission.
 */
'authentication/revoked'(revocation: AuthenticationRevocation): void
```

Source: [`packages/auth/authentication/src/index.ts:243`](../../packages/auth/authentication/src/index.ts)

<a id="authenticationunavailable--emit"></a>

#### `authentication/unavailable` — emit

Credential freshness became unavailable; current sockets must close.

```ts cordis-catalog
/**
 * Credential freshness became unavailable; current sockets must close.
 * @mode emit
 */
'authentication/unavailable'(): void
```

Source: [`packages/auth/authentication/src/index.ts:249`](../../packages/auth/authentication/src/index.ts)
<!-- END GENERATED cordis-surface -->
