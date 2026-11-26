/**
 * One explicit authorization attempt against one authorization server. The
 * flow runs the SDK's discrete protocol functions — discovery, client
 * registration, the PKCE authorization request, and the code exchange — and
 * is driven step by step by the surface that owns the browser round trip. It
 * never redirects, registers, or exchanges on its own, and it inherits no
 * resource header or stored token: every request it makes carries only what
 * the authorization server expects.
 *
 * @module
 */

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthConfig, StreamableHttpConfig } from './config.ts'
import { McpLocalError } from './oauth-errors.ts'
import { oauthFailure, oauthFetch } from './oauth-request.ts'
import { serializedGrantWrite } from './oauth-store.ts'
import type { McpOAuthBinding, McpOAuthGrant, McpOAuthGrantStore } from './oauth-store.ts'

/** RFC 9207 metadata flag the SDK's metadata schema passes through untyped. */
const ISS_PARAMETER = 'authorization_response_iss_parameter_supported'

/** Client name offered to a dynamic registration. */
const CLIENT_NAME = 'Harniverse'

/** Milliseconds subtracted from a token's lifetime so a refresh never races the authorization server's clock. */
const REFRESH_SKEW_MS = 30_000

/** Everything the code exchange needs from the authorization request that preceded it. */
interface PendingAuthorization {
  readonly redirectUri: string
  readonly codeVerifier: string
  readonly client: ClientRegistration
  readonly discovery: OAuthServerInfo
  readonly resource: string | undefined
  readonly scope: string | undefined
}

/** Client information a token request authenticates with, and how it was obtained. */
interface ClientRegistration {
  readonly information: OAuthClientInformationMixed
  /** A dynamic registration is bound to one redirect URI and is replaced when the URI changes. */
  readonly registered: boolean
}

/** The endpoint's unauthenticated challenge: where its protected-resource metadata lives and which scope it asks for. */
interface OAuthChallenge {
  resourceMetadataUrl?: URL
  scope?: string
}

/** Dependencies a session supplies to each flow it creates. */
export interface McpOAuthFlowDeps {
  readonly config: StreamableHttpConfig
  readonly options: OAuthConfig
  readonly endpoint: URL
  readonly binding: McpOAuthBinding
  readonly grants: McpOAuthGrantStore
  /** Called once whenever the flow is disposed or settled. */
  readonly retire: () => void
}

/**
 * Epoch ms after which a token set must be refreshed. A short-lived token
 * keeps half of its lifetime instead of the full skew, so it is never due
 * the moment it is issued.
 * @param tokens - Token response of an exchange or a refresh.
 * @param now - The moment the token was issued; defaults to the current time.
 * @returns The refresh deadline, or `undefined` for a token without a lifetime.
 */
export function tokenExpiryOf(tokens: OAuthTokens, now: number = Date.now()): number | undefined {
  if (tokens.expires_in === undefined) return undefined
  const lifetime = tokens.expires_in * 1_000
  return now + lifetime - Math.min(REFRESH_SKEW_MS, lifetime / 2)
}

/**
 * Whether an authorization server's refusal invalidates the client
 * registration itself rather than only the grant being exchanged.
 * @param error - Failure of a token request.
 * @returns True for `invalid_client` and `unauthorized_client`.
 */
export function isClientRejection(error: unknown): boolean {
  return error instanceof OAuthError && (error.errorCode === 'invalid_client' || error.errorCode === 'unauthorized_client')
}

function resourceIndicatorOf(endpoint: URL, resourceMetadata: OAuthProtectedResourceMetadata | undefined): string | undefined {
  if (resourceMetadata === undefined) return undefined
  if (!checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(endpoint), configuredResource: resourceMetadata.resource })) {
    throw new McpLocalError('MCP OAuth: the server advertises a protected resource that does not cover its endpoint', 'MCP_OAUTH_FAILED')
  }
  return resourceMetadata.resource
}

function clientMetadataOf(redirectUri: string): OAuthClientMetadata {
  return {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

function metadataOf(metadata: AuthorizationServerMetadata | undefined): { metadata?: AuthorizationServerMetadata } {
  return metadata === undefined ? {} : { metadata }
}

/** The explicit authorization flow of one server, from discovery to the committed grant. */
export class McpOAuthFlow {
  private readonly controller = new AbortController()
  private pending: PendingAuthorization | undefined
  private exchanged: OAuthTokens | undefined

  /**
   * @param deps - Server configuration, grant storage, and the retirement hook.
   * @param send - Network implementation the protocol requests run through.
   */
  constructor(
    private readonly deps: McpOAuthFlowDeps,
    private readonly send: typeof fetch = fetch,
  ) {}

  /**
   * Discover the authorization server, obtain client information, and build
   * the PKCE authorization request.
   * @param input - Redirect URI the authorization server answers and the state that binds the answer to this attempt.
   * @returns The authorization page the user opens.
   * @throws {McpLocalError} with code `MCP_OAUTH_FAILED` when discovery, registration, or the request fails or is cancelled.
   */
  async begin(input: { redirectUri: string; state: string }): Promise<{ authorizationUrl: string }> {
    const request = this.request()
    const challenge = await this.challenge(request)
    const discovery = await discoverOAuthServerInfo(this.deps.endpoint, {
      ...challenge.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: challenge.resourceMetadataUrl },
      fetchFn: request,
    }).catch((error: unknown) => {
      throw oauthFailure(error, 'authorization server discovery')
    })
    const client = await this.clientInformation(request, discovery, input.redirectUri)
    const scope = this.deps.options.scope ?? challenge.scope ?? discovery.resourceMetadata?.scopes_supported?.join(' ')
    const resource = resourceIndicatorOf(this.deps.endpoint, discovery.resourceMetadata)
    const authorization = await startAuthorization(discovery.authorizationServerUrl, {
      ...metadataOf(discovery.authorizationServerMetadata),
      clientInformation: client.information,
      redirectUrl: input.redirectUri,
      ...scope === undefined ? {} : { scope },
      state: input.state,
      ...resource === undefined ? {} : { resource },
    }).catch((error: unknown) => {
      throw oauthFailure(error, 'authorization request')
    })
    this.pending = { redirectUri: input.redirectUri, codeVerifier: authorization.codeVerifier, client, discovery, resource, scope }
    return { authorizationUrl: authorization.authorizationUrl.href }
  }

  /**
   * Exchange the authorization code the callback received.
   * @param input - Code and the issuer the authorization server echoed.
   * @throws {McpLocalError} with code `MCP_OAUTH_FAILED` when the issuer does not match, the exchange fails, or the flow is cancelled.
   */
  async exchange(input: { code: string; iss: string | undefined }): Promise<void> {
    const pending = this.requirePending()
    this.assertIssuer(pending, input.iss)
    try {
      this.exchanged = await exchangeAuthorization(pending.discovery.authorizationServerUrl, {
        ...metadataOf(pending.discovery.authorizationServerMetadata),
        clientInformation: pending.client.information,
        authorizationCode: input.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        ...pending.resource === undefined ? {} : { resource: pending.resource },
        fetchFn: this.request(),
      })
    } catch (error) {
      // An authorization server that no longer knows a dynamically registered client invalidates the whole record.
      if (isClientRejection(error) && pending.client.registered) await this.deps.grants.clear()
      throw oauthFailure(error, 'authorization code exchange')
    }
  }

  /**
   * Store the exchanged tokens as the server's grant.
   * @throws when the exchange did not precede the commit or no credentials provider serves the composition.
   */
  async commit(): Promise<void> {
    const pending = this.requirePending()
    const tokens = this.exchanged
    if (tokens === undefined) throw new McpLocalError('MCP OAuth: no exchanged token is pending a commit', 'MCP_OAUTH_FAILED')
    const expiresAt = tokenExpiryOf(tokens)
    const scope = tokens.scope ?? pending.scope
    const grant: McpOAuthGrant = {
      version: 1,
      serverUrl: this.deps.binding.serverUrl,
      issuer: pending.discovery.authorizationServerUrl,
      ...metadataOf(pending.discovery.authorizationServerMetadata),
      clientInformation: pending.client.information,
      registered: pending.client.registered,
      redirectUri: pending.redirectUri,
      ...pending.resource === undefined ? {} : { resource: pending.resource },
      ...scope === undefined ? {} : { scope },
      tokens,
      ...expiresAt === undefined ? {} : { expiresAt },
      configured: {
        ...this.deps.options.clientId === undefined ? {} : { clientId: this.deps.options.clientId },
        ...this.deps.options.scope === undefined ? {} : { scope: this.deps.options.scope },
      },
    }
    // Behind any passive refresh of the same record, so the committed grant is never overwritten by it.
    await serializedGrantWrite(this.deps.grants.ref, () => this.deps.grants.write(grant))
    this.dispose()
  }

  /** Cancel every in-flight step, forget the verifier and the exchanged tokens, and retire the flow. */
  dispose(): void {
    this.controller.abort()
    this.pending = undefined
    this.exchanged = undefined
    this.deps.retire()
  }

  private request(): FetchLike {
    return oauthFetch({ signal: this.controller.signal, timeoutMs: this.deps.options.requestTimeoutMs, fetch: this.send })
  }

  /** Ask the endpoint itself, without any credential, where its authorization metadata lives and which scope it asks for. */
  private async challenge(request: FetchLike): Promise<OAuthChallenge> {
    try {
      const response = await request(this.deps.endpoint, { headers: { ...this.deps.config.headers, Accept: 'application/json, text/event-stream' } })
      const challenge = response.status === 401 || response.status === 403 ? extractWWWAuthenticateParams(response) : {}
      await response.body?.cancel()
      return challenge
    } catch {
      // The challenge only refines discovery: a server that cannot be asked here fails the discovery step with its own diagnostic.
      return {}
    }
  }

  private async clientInformation(request: FetchLike, discovery: OAuthServerInfo, redirectUri: string): Promise<ClientRegistration> {
    if (this.deps.options.clientId !== undefined) return { information: { client_id: this.deps.options.clientId }, registered: false }
    const stored = await this.storedRegistration(discovery, redirectUri)
    if (stored !== undefined) return stored
    const information = await registerClient(discovery.authorizationServerUrl, {
      ...metadataOf(discovery.authorizationServerMetadata),
      clientMetadata: clientMetadataOf(redirectUri),
      ...this.deps.options.scope === undefined ? {} : { scope: this.deps.options.scope },
      fetchFn: request,
    }).catch((error: unknown) => {
      throw oauthFailure(error, 'client registration')
    })
    return { information, registered: true }
  }

  /** The dynamically registered client a stored grant still holds for this authorization server and redirect URI. */
  private async storedRegistration(discovery: OAuthServerInfo, redirectUri: string): Promise<ClientRegistration | undefined> {
    try {
      const grant = await this.deps.grants.read(this.deps.binding)
      if (grant.registered && grant.redirectUri === redirectUri && grant.issuer === discovery.authorizationServerUrl) {
        return { information: grant.clientInformation, registered: true }
      }
    } catch {
      // A missing or differently bound grant holds no registration to reuse; the flow registers a new client.
    }
    return undefined
  }

  private assertIssuer(pending: PendingAuthorization, iss: string | undefined): void {
    const metadata = pending.discovery.authorizationServerMetadata
    const expected = metadata?.issuer ?? pending.discovery.authorizationServerUrl
    // RFC 9207: an issuer the server announced must be echoed; an unannounced one is judged only when it is present.
    const announced = metadata !== undefined && ISS_PARAMETER in metadata && metadata[ISS_PARAMETER] === true
    const mismatch = announced ? iss !== expected : iss !== undefined && iss !== expected
    if (mismatch) {
      throw new McpLocalError('MCP OAuth: the authorization response issuer does not match the authorization server', 'MCP_OAUTH_FAILED')
    }
  }

  private requirePending(): PendingAuthorization {
    if (this.pending === undefined) throw new McpLocalError('MCP OAuth: no authorization request is pending', 'MCP_OAUTH_FAILED')
    return this.pending
  }
}
