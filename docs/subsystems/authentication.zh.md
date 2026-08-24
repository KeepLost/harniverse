# 入站认证

[English](authentication.md) | 中文

[认证 Service Definition](../../packages/auth/authentication)为 HTTP API 与 WebSocket 规范化 principal、capability、enrollment、持有证明交换与接入判断。已交付的[本地提供方](../../packages/auth/authentication-local)持久保存公钥 Grant，并将 challenge、短期 Access Token 和浏览器会话保留在进程内存。connection 消费方把 Host、Origin、Fetch Metadata 与 DNS 重绑定检查保留为独立防线。

每个 endpoint 要求四项正交 capability 之一：`harniverse.observe`、`harniverse.operate`、`harniverse.administer` 或 `harniverse.authorize`。Grant principal 携带准确的 Grant id 与 revision、capability 和过期时间。注册表变更会撤销匹配的 Access Token、浏览器会话和 WebSocket，而不影响其他 Grant。

Authenticated 启动允许空的 sealed 注册表，以便浏览器提交首个设备 enrollment 请求；本地 CLI 批准后创建首个 owner Grant。待处理 enrollment 受持久全局上限和每 peer 创建限制约束。设备与 API client 使用一次性 P-256 签名 challenge 换取短期凭据。临时设备必须有过期时间和空闲超时，应急 token 不能 authorize，且 `$DSH_HOME/auth/tokens.json` 会在不迁移的情况下被拒绝。显式 bypass 仍保留每主目录实例 lease 与强制访问记录并仅限回环；全接口 listener 必须直接启用 TLS。

来源：[`packages/auth/authentication/src/index.ts`](../../packages/auth/authentication/src/index.ts)

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

Source: [`packages/auth/authentication/src/index.ts:300`](../../packages/auth/authentication/src/index.ts)

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

Source: [`packages/auth/authentication/src/index.ts:295`](../../packages/auth/authentication/src/index.ts)

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

Source: [`packages/auth/authentication/src/index.ts:283`](../../packages/auth/authentication/src/index.ts)

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

Source: [`packages/auth/authentication/src/index.ts:289`](../../packages/auth/authentication/src/index.ts)
<!-- END GENERATED cordis-surface -->
