# Inbound Authentication

English | [中文](authentication.zh.md)

The [authentication Service Definition](../../packages/auth/authentication) normalizes admission for HTTP APIs and WebSockets. The shipped [local provider](../../packages/auth/authentication-local) verifies named Bearer tokens or in-memory browser sessions and rate limits invalid credentials by carrier and direct peer, while the connection consumer retains Host, Origin, Fetch Metadata, and DNS-rebinding checks as independent defenses.

Every accepted credential belongs to one logical Harness user. A credential revision combines a stable token id, a non-secret management name, and a generation; it supports targeted browser-session and WebSocket revocation without introducing authorization, scopes, tenants, or per-token Harness sessions.

Authenticated startup requires at least one token. Removing the final token seals the running instance until a token is added. Explicit bypass mode skips credential checks but retains the per-home instance lease and mandatory access records, and the connection consumer accepts bypass only on a loopback listener. The WebServer requires direct TLS for an all-interfaces listener.

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
```

Source: [`packages/auth/authentication/src/index.ts:124`](../../packages/auth/authentication/src/index.ts)

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

Source: [`packages/auth/authentication/src/index.ts:119`](../../packages/auth/authentication/src/index.ts)

<a id="authenticationrevoked--emit"></a>

#### `authentication/revoked` — emit

A committed token registry change invalidated credential revisions.

```ts cordis-catalog
/**
 * A committed token registry change invalidated credential revisions.
 * @mode emit
 * @param revocation - revisions that must lose browser and socket admission.
 */
'authentication/revoked'(revocation: AuthenticationRevocation): void
```

Source: [`packages/auth/authentication/src/index.ts:107`](../../packages/auth/authentication/src/index.ts)

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

Source: [`packages/auth/authentication/src/index.ts:113`](../../packages/auth/authentication/src/index.ts)
<!-- END GENERATED cordis-surface -->
