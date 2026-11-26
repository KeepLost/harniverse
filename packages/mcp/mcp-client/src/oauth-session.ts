/**
 * OAuth session of one connection to an OAuth-configured server: it reads the
 * server's grant through the credentials seam, refreshes the access token
 * single-flight, attaches the bearer to endpoint requests, classifies a
 * refused request into an authorization reason, and creates the explicit
 * authorization flows the management surface drives. It never opens a
 * browser, registers a client, or redirects on its own.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { extractWWWAuthenticateParams, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthConfig, StreamableHttpConfig } from './config.ts'
import { McpAuthorizationRequired, McpLocalError } from './oauth-errors.ts'
import type { McpAuthorizationReason } from './oauth-errors.ts'
import { McpOAuthFlow, tokenExpiryOf } from './oauth-flow.ts'
import { NEVER_ABORTED, oauthFailure, oauthFetch } from './oauth-request.ts'
import { McpOAuthGrantStore, serializedGrantWrite } from './oauth-store.ts'
import type { McpOAuthBinding, McpOAuthGrant } from './oauth-store.ts'
import type { McpOAuthCredentialStore } from './types.ts'

/** Authorization state of an OAuth-configured server, as status surfaces report it. */
export type McpOAuthAuthorizationState =
  | { readonly state: 'authorized'; readonly expiresAtMs?: number }
  | { readonly state: 'waiting-authorization'; readonly reason: McpAuthorizationReason }

/** OAuth capability of a shared connection whose server is configured with `oauth`. */
export interface McpConnectionOAuth {
  /** Deadline of one explicit authorization attempt in milliseconds. */
  readonly authorizationTimeoutMs: number
  /**
   * Read the current authorization state.
   * @returns The state a status row reports, or `undefined` until the first grant read settles; no token or identifier leaves the session.
   */
  status(): McpOAuthAuthorizationState | undefined
  /**
   * Start one explicit authorization flow.
   * @returns The flow the caller drives through discovery, exchange, and commit.
   */
  createFlow(): McpOAuthFlow
  /**
   * Delete the stored grant. A live generation is brought down into
   * `waiting-authorization` and no further request carries the grant.
   */
  signOut(): Promise<void>
  /**
   * Re-judge the stored grant after it changed: a connection waiting for
   * authorization connects again, and any other connection keeps its generation.
   */
  resume(): void
}

/** Whether a refresh failure means the grant can no longer be used without the user. */
function isInvalidGrant(error: unknown): error is OAuthError {
  return error instanceof OAuthError && error.errorCode === 'invalid_grant'
}

/** Whether an authorization server refused the client itself. */
function isClientRefusal(error: unknown): error is OAuthError {
  return error instanceof OAuthError && (error.errorCode === 'invalid_client' || error.errorCode === 'unauthorized_client' || error.errorCode === 'invalid_scope')
}

/** Events a supervisor subscribes to. */
export interface McpOAuthSessionHooks {
  /**
   * The session cannot authenticate until the user acts.
   * @param reason - Why the connection waits.
   */
  readonly onWaiting: (reason: McpAuthorizationReason) => void
  /** A resume asked the supervisor to re-judge the grant; a session nobody resumes, such as a probe, leaves it out. */
  readonly onResume?: () => void
}

/** Dependencies of one session. */
export interface McpOAuthSessionDeps {
  readonly config: StreamableHttpConfig
  readonly options: OAuthConfig
  /** Stable identity the grant reference is derived from. */
  readonly serverKey: string
  readonly store: McpOAuthCredentialStore | undefined
  readonly hooks: McpOAuthSessionHooks
  /** Network implementation endpoint requests run through. */
  readonly send?: typeof fetch
}

/** The OAuth session of one connection; see the module header. */
export class McpOAuthSession implements McpConnectionOAuth {
  private readonly endpoint: URL
  private readonly binding: McpOAuthBinding
  private readonly grants: McpOAuthGrantStore
  private readonly flows = new Set<McpOAuthFlow>()
  private readonly send: typeof fetch
  private waiting: McpAuthorizationReason | undefined
  private known = false
  private expiresAtMs: number | undefined

  /**
   * @param deps - Server configuration, grant storage, supervisor hooks, and network implementation.
   */
  constructor(private readonly deps: McpOAuthSessionDeps) {
    this.endpoint = new URL(deps.config.url)
    this.binding = {
      serverUrl: this.endpoint.href,
      ...deps.options.clientId === undefined ? {} : { clientId: deps.options.clientId },
      ...deps.options.scope === undefined ? {} : { scope: deps.options.scope },
    }
    this.grants = new McpOAuthGrantStore(deps.store, deps.serverKey)
    this.send = deps.send ?? fetch
  }

  /** @inheritdoc */
  get authorizationTimeoutMs(): number {
    return this.deps.options.authorizationTimeoutMs
  }

  /**
   * Why the session stopped attempting to authenticate.
   * @returns The reason set by the last definitive refusal, or `undefined` while the session can still authenticate.
   */
  waitingReason(): McpAuthorizationReason | undefined {
    return this.waiting
  }

  /** @inheritdoc */
  status(): McpOAuthAuthorizationState | undefined {
    if (this.waiting !== undefined) return { state: 'waiting-authorization', reason: this.waiting }
    if (!this.known) return undefined
    return { state: 'authorized', ...this.expiresAtMs === undefined ? {} : { expiresAtMs: this.expiresAtMs } }
  }

  /**
   * The fetch the MCP transport sends every endpoint request through: it
   * attaches the bearer, answers one refused request with a single refresh
   * and retry, and reports a definitive refusal as an authorization reason.
   */
  readonly fetch: FetchLike = async (input, init) => {
    const target = new URL(input)
    if (target.origin !== this.endpoint.origin) {
      throw new McpLocalError('MCP OAuth: the endpoint credential is never sent to another origin', 'MCP_OAUTH_FAILED')
    }
    const token = await this.accessToken()
    const response = await this.send(target, withBearer(init, token))
    if (response.status === 401) return this.recover(target, init, token, response)
    return this.noteScopeRefusal(response)
  }

  /**
   * Read the grant and make sure its access token is usable.
   * @returns The access token an endpoint request presents.
   * @throws {McpAuthorizationRequired} when the grant is missing, bound elsewhere, expired
   *   without a refresh token, or refused; the session then waits for authorization.
   * @throws {McpLocalError} with code `MCP_OAUTH_FAILED` for a transient refresh failure; the session keeps its state.
   */
  async accessToken(): Promise<string> {
    if (this.waiting !== undefined) throw new McpAuthorizationRequired(this.waiting)
    try {
      const grant = await this.serialized(() => this.grants.read(this.binding), false)
      this.known = true
      this.expiresAtMs = grant.expiresAt
      return grant.tokens.access_token
    } catch (error) {
      if (error instanceof McpAuthorizationRequired) this.enterWaiting(error.reason)
      throw error
    }
  }

  /** @inheritdoc */
  createFlow(): McpOAuthFlow {
    const flow = new McpOAuthFlow({
      config: this.deps.config,
      options: this.deps.options,
      endpoint: this.endpoint,
      binding: this.binding,
      grants: this.grants,
      retire: () => { this.flows.delete(flow) },
    }, this.send)
    this.flows.add(flow)
    return flow
  }

  /** @inheritdoc */
  async signOut(): Promise<void> {
    // Inside the grant's write chain: a refresh that is already in flight commits first and is then cleared with the rest.
    await serializedGrantWrite(this.grants.ref, () => this.grants.clear())
    this.known = false
    this.enterWaiting('missing')
  }

  /** @inheritdoc */
  resume(): void {
    this.waiting = undefined
    this.known = false
    this.deps.hooks.onResume?.()
  }

  /** Retire every flow this session created. */
  dispose(): void {
    for (const flow of [...this.flows]) flow.dispose()
  }

  /**
   * Refresh a grant unless it is still valid or `force` is set.
   * @param grant - The grant to refresh.
   * @param force - Refresh even a token that has not reached its deadline.
   * @returns The grant to present.
   * @throws {McpAuthorizationRequired} when no refresh token exists or the authorization server refused definitively.
   * @throws {McpLocalError} for a transient refresh failure.
   */
  private async ensureFresh(grant: McpOAuthGrant, force: boolean): Promise<McpOAuthGrant> {
    if (!force && (grant.expiresAt === undefined || grant.expiresAt > Date.now())) return grant
    const refreshToken = grant.tokens.refresh_token
    if (refreshToken === undefined) throw new McpAuthorizationRequired('expired')
    const tokens = await this.requestRefresh(grant, refreshToken)
    // The previous deadline belongs to the replaced token set and is never carried over.
    const { expiresAt: _replaced, ...retained } = grant
    const expiresAt = tokenExpiryOf(tokens)
    const next: McpOAuthGrant = { ...retained, tokens, ...expiresAt === undefined ? {} : { expiresAt } }
    await this.grants.write(next)
    return next
  }

  /**
   * Send one refresh-token grant.
   * @param grant - Grant whose refresh token is presented.
   * @param refreshToken - The stored refresh token.
   * @returns The rotated token set.
   * @throws {McpAuthorizationRequired} with reason `expired` or `rejected` for a definitive refusal.
   * @throws {McpLocalError} with code `MCP_OAUTH_FAILED` for a transient failure.
   */
  private async requestRefresh(grant: McpOAuthGrant, refreshToken: string): Promise<OAuthTokens & { refresh_token: string }> {
    try {
      // The SDK documents that a refresh response without a new refresh token keeps the presented one.
      return await refreshAuthorization(grant.issuer, {
        ...grant.metadata === undefined ? {} : { metadata: grant.metadata },
        clientInformation: grant.clientInformation,
        refreshToken,
        ...grant.resource === undefined ? {} : { resource: grant.resource },
        fetchFn: oauthFetch({ signal: NEVER_ABORTED, timeoutMs: this.deps.options.requestTimeoutMs, fetch: this.send }),
      }) as OAuthTokens & { refresh_token: string }
    } catch (error) {
      if (isInvalidGrant(error)) throw new McpAuthorizationRequired('expired', { cause: error })
      if (isClientRefusal(error)) throw new McpAuthorizationRequired('rejected', { cause: error })
      throw oauthFailure(error, 'token refresh')
    }
  }

  /**
   * Read the grant inside the write chain of its reference, so a caller
   * queued behind an earlier refresh reads what that refresh stored, and
   * make its access token usable.
   */
  private serialized(read: () => Promise<McpOAuthGrant>, force: boolean): Promise<McpOAuthGrant> {
    return serializedGrantWrite(this.grants.ref, async () => this.ensureFresh(await read(), force))
  }

  /** Answer a refused endpoint request with one refresh and one retry. */
  private async recover(target: URL, init: RequestInit | undefined, presented: string, refused: Response): Promise<Response> {
    await refused.body?.cancel()
    let grant: McpOAuthGrant
    try {
      // The presented token is still the stored one when nobody refreshed it yet; otherwise the newer token is retried as it is.
      grant = await serializedGrantWrite(this.grants.ref, async () => {
        const current = await this.grants.read(this.binding)
        return this.ensureFresh(current, current.tokens.access_token === presented)
      })
      this.expiresAtMs = grant.expiresAt
    } catch (error) {
      if (error instanceof McpAuthorizationRequired) {
        this.enterWaiting(error.reason)
        return refused
      }
      throw error
    }
    const retry = await this.send(target, withBearer(init, grant.tokens.access_token))
    if (retry.status !== 401) return this.noteScopeRefusal(retry)
    await retry.body?.cancel()
    this.enterWaiting('rejected')
    return retry
  }

  /** Record a scope refusal only the endpoint can state; every other response passes through untouched. */
  private noteScopeRefusal(response: Response): Response {
    if (response.status === 403 && extractWWWAuthenticateParams(response).error === 'insufficient_scope') this.enterWaiting('scope')
    return response
  }

  private enterWaiting(reason: McpAuthorizationReason): void {
    if (this.waiting !== undefined) return
    this.waiting = reason
    this.expiresAtMs = undefined
    this.deps.hooks.onWaiting(reason)
  }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return { ...init, headers }
}

/**
 * Read the credentials seam face of a composition.
 * @param ctx - Context the connection or probe runs in.
 * @returns The face, or `undefined` where no credentials provider serves the composition.
 */
export function credentialsStoreOf(ctx: Context): McpOAuthCredentialStore | undefined {
  return ctx.get('credentials') as McpOAuthCredentialStore | undefined
}

/**
 * Create the OAuth session of one connection or probe.
 * @param deps - Server configuration, grant storage, supervisor hooks, and network implementation.
 * @returns The session.
 */
export function createOAuthSession(deps: McpOAuthSessionDeps): McpOAuthSession {
  return new McpOAuthSession(deps)
}
