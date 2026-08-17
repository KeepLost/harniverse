# 入站认证

[English](authentication.md) | 中文

[认证 Service Definition](../../packages/auth/authentication)为 HTTP API 与 WebSocket 规范化接入判断。已交付的[本地提供方](../../packages/auth/authentication-local)验证具名 Bearer 令牌或内存浏览器会话，并按载体与直连 peer 限制无效凭据尝试；connection 消费方则把 Host、Origin、Fetch Metadata 与 DNS 重绑定检查保留为独立防线。

每个已接受凭据都属于同一个 Harness 逻辑用户。凭据 revision 由稳定令牌 id、非机密管理名称与 generation 组成；它支持定向撤销浏览器会话和 WebSocket，但不会引入授权、scope、租户或每令牌 Harness session。

Authenticated 启动要求至少一个令牌。移除最后一个令牌会封存运行中的实例，直到新增令牌。显式 bypass 模式跳过凭据检查，但仍保留每主目录实例 lease 与强制访问记录，而且 connection 消费方只在回环 listener 上接受 bypass。WebServer 的全接口 listener 必须直接启用 TLS。

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
