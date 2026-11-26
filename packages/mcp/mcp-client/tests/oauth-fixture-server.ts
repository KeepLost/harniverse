/**
 * Loopback OAuth 2.1 protected MCP server for specs: a bearer-guarded
 * Streamable HTTP MCP endpoint plus the authorization-server endpoints the
 * SDK discovers (protected-resource metadata, authorization-server metadata,
 * dynamic registration, authorization, token). Every request is recorded by
 * method and path; codes and tokens are deterministic counters.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

/** Knobs a spec turns before the fixture serves its first request. */
export interface OAuthFixtureOptions {
  /** Seconds an issued access token lives; omission issues a non-expiring token. */
  tokenTtlSeconds?: number
  /** Whether the resource owner grants consent on the authorization page. */
  consent?: 'grant' | 'deny'
  /** Failure the token endpoint answers to a refresh grant. */
  refreshFailure?: 'invalid_grant' | 'invalid_client' | 'server_error'
  /** Failure the token endpoint answers to an authorization-code grant. */
  exchangeFailure?: 'invalid_client' | 'unauthorized_client' | 'server_error'
  /** Client ids accepted without a dynamic registration. */
  allowedClientIds?: readonly string[]
  /** Redirect URIs accepted for an allowed (pre-registered) client id. */
  allowedRedirectUris?: readonly string[]
  /** Never register an access token issued by a refresh, so the endpoint keeps answering 401 to it. */
  rejectRefreshedTokens?: boolean
  /** Answer every authenticated endpoint request with 403 `insufficient_scope`. */
  insufficientScope?: boolean
  /** Answer the authorization-server metadata with a redirect instead of a document. */
  redirectMetadata?: boolean
  /** Paths whose request is never answered until the client gives up. */
  hangPaths?: readonly string[]
  /** Paths answered with a redirect instead of their document. */
  redirectPaths?: readonly string[]
  /** Resource the protected-resource metadata advertises; defaults to the fixture origin. */
  resource?: string
  /** `legacy` answers both metadata endpoints with 404, as a server without RFC 9728 or RFC 8414 support does. */
  metadata?: 'full' | 'legacy'
  /** Serve an unparsable authorization-server metadata document. */
  malformedMetadata?: boolean
  /** `response_types_supported` of the authorization-server metadata. */
  responseTypes?: readonly string[]
  /** Whether the unauthenticated endpoint challenge names a scope; default true. */
  challengeScope?: boolean
  /** Serve the endpoint without asking for a bearer token. */
  anonymous?: boolean
  /** Spell the issuer parameter the way the SDK spells a server without metadata, with a trailing slash. */
  issuerTrailingSlash?: boolean
  /** Echo the issuer parameter in the authorization redirect; default true. */
  issuerParameter?: boolean
  /** Omit `refresh_token` from a refresh response. */
  omitRefreshToken?: boolean
}

interface AuthorizationCode {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope: string
}

interface IssuedToken {
  refreshToken: string
  scope: string
}

const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource'
const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server'

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function oauthError(response: ServerResponse, status: number, error: string, description: string): void {
  json(response, status, { error, error_description: description })
}

function pkceMatches(challenge: string, verifier: string): boolean {
  return createHash('sha256').update(verifier).digest('base64url') === challenge
}

/** The knobs with every value clearable, as {@link OAuthFixture.configure} merges them. */
type FixtureKnobs = { [K in keyof OAuthFixtureOptions]?: OAuthFixtureOptions[K] | undefined }

/** The protected MCP server and its authorization server on one loopback port. */
export class OAuthFixture {
  private readonly server: Server
  private options: FixtureKnobs
  private readonly registered = new Map<string, readonly string[]>()
  private readonly codes = new Map<string, AuthorizationCode>()
  private readonly tokens = new Map<string, IssuedToken>()
  private readonly refreshTokens = new Map<string, IssuedToken>()
  private readonly listening: PromiseWithResolvers<void> = Promise.withResolvers()
  private codeCounter = 0
  private tokenCounter = 0
  private origin = ''
  private tokenHold: { grantType: string | undefined; gate: PromiseWithResolvers<unknown> } | undefined

  /** `METHOD path` of every request in arrival order. */
  readonly requests: string[] = []
  /** Headers of every request, aligned with {@link requests}. */
  readonly requestHeaders: IncomingHttpHeaders[] = []
  /** Query of every authorization request, in arrival order. */
  readonly authorizations: URLSearchParams[] = []
  /** `grant_type` of every token request, in arrival order. */
  readonly tokenGrants: string[] = []
  /** Bodies of every token request, in arrival order. */
  readonly tokenRequests: URLSearchParams[] = []
  /** Bodies the registration endpoint accepted. */
  readonly registrations: Array<Record<string, unknown>> = []

  private constructor(options: OAuthFixtureOptions) {
    this.options = options
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error))
      })
    })
    this.server.listen(0, '127.0.0.1', () => {
      this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
      this.listening.resolve()
    })
  }

  /** Origin every endpoint of the fixture shares. */
  get baseUrl(): string {
    return this.origin
  }

  /** The MCP endpoint URL a client connects to. */
  get url(): string {
    return `${this.origin}/mcp`
  }

  /** Listen on a free loopback port and resolve once the socket is bound. */
  static async start(options: OAuthFixtureOptions = {}): Promise<OAuthFixture> {
    const fixture = new OAuthFixture(options)
    await fixture.listening.promise
    return fixture
  }

  /** Stop the listener and wait until its sockets are closed. */
  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }

  /** Keep every later token request of the given grant type unanswered until {@link releaseTokens} is called; every type when omitted. */
  holdTokens(grantType?: string): void {
    this.tokenHold = { grantType, gate: Promise.withResolvers<unknown>() }
  }

  /** Answer every token request held so far. */
  releaseTokens(): void {
    this.tokenHold?.gate.resolve(undefined)
    this.tokenHold = undefined
  }

  /** Invalidate every access and refresh token issued so far. */
  revokeTokens(): void {
    this.tokens.clear()
    this.refreshTokens.clear()
  }

  /** Invalidate every access token while each refresh token stays valid. */
  revokeAccessTokens(): void {
    this.tokens.clear()
  }

  /** Change the knobs later requests are served with; an `undefined` value clears one. */
  configure(options: FixtureKnobs): void {
    this.options = { ...this.options, ...options }
  }

  /** Requests that did not target the MCP endpoint. */
  oauthRequests(): string[] {
    return this.requests.filter(entry => !entry.endsWith(' /mcp'))
  }

  private challenge(response: ServerResponse, status: number, params: Record<string, string> = {}): void {
    const fields = [`resource_metadata="${this.origin}${RESOURCE_METADATA_PATH}/mcp"`, ...this.options.challengeScope === false ? [] : ['scope="mcp:tools"']]
    response.writeHead(status, { 'www-authenticate': ['Bearer', ...fields, ...Object.entries(params).map(([key, value]) => `${key}="${value}"`)].join(' ') })
    response.end()
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin)
    this.requests.push(`${request.method} ${url.pathname}`)
    this.requestHeaders.push({ ...request.headers })
    // A hung path answers nothing: the client's own deadline or abort has to end the request.
    if (this.options.hangPaths?.includes(url.pathname)) return
    if (this.options.redirectPaths?.includes(url.pathname)) {
      response.writeHead(302, { location: `${this.origin}/moved` })
      response.end()
      return
    }
    if ((url.pathname === `${RESOURCE_METADATA_PATH}/mcp` || url.pathname === RESOURCE_METADATA_PATH) && this.options.metadata === 'legacy') {
      json(response, 404, { error: 'not_found' })
      return
    }
    if (url.pathname === `${RESOURCE_METADATA_PATH}/mcp` || url.pathname === RESOURCE_METADATA_PATH) {
      json(response, 200, {
        resource: this.options.resource ?? `${this.origin}/`,
        authorization_servers: [this.origin],
        scopes_supported: ['mcp:tools'],
        bearer_methods_supported: ['HEADER'],
      })
      return
    }
    if (url.pathname === AUTHORIZATION_SERVER_METADATA_PATH && this.options.redirectMetadata === true) {
      response.writeHead(302, { location: `${this.origin}/moved-metadata` })
      response.end()
      return
    }
    if (url.pathname === AUTHORIZATION_SERVER_METADATA_PATH && this.options.malformedMetadata === true) {
      json(response, 200, { issuer: this.origin })
      return
    }
    if (url.pathname === AUTHORIZATION_SERVER_METADATA_PATH && this.options.metadata === 'legacy') {
      json(response, 404, { error: 'not_found' })
      return
    }
    if (url.pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
      json(response, 200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: this.options.responseTypes ?? ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      })
      return
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as { redirect_uris?: string[] }
      this.registrations.push(body)
      const clientId = `client-${createHash('sha256').update((body.redirect_uris ?? []).join(' ')).digest('hex').slice(0, 8)}`
      this.registered.set(clientId, body.redirect_uris ?? [])
      json(response, 201, { ...body, client_id: clientId, token_endpoint_auth_method: 'none' })
      return
    }
    if (url.pathname === '/authorize' && request.method === 'GET') {
      this.authorize(url.searchParams, response)
      return
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(await readBody(request))
      this.tokenRequests.push(form)
      this.tokenGrants.push(form.get('grant_type') ?? '')
      const hold = this.tokenHold
      if (hold !== undefined && (hold.grantType === undefined || hold.grantType === form.get('grant_type'))) await hold.gate.promise
      this.token(form, response)
      return
    }
    if (url.pathname === '/mcp') {
      await this.resource(request, response)
      return
    }
    json(response, 404, { error: 'not_found' })
  }

  private authorize(params: URLSearchParams, response: ServerResponse): void {
    this.authorizations.push(params)
    const clientId = params.get('client_id') ?? ''
    const redirectUri = params.get('redirect_uri') ?? ''
    const allowed = this.registered.get(clientId)
      ?? (this.options.allowedClientIds?.includes(clientId) ? this.options.allowedRedirectUris : undefined)
    const state = params.get('state') ?? ''
    const target = new URL(redirectUri === '' ? this.origin : redirectUri)
    const refused = allowed === undefined ? 'unauthorized_client' : allowed.includes(redirectUri) ? undefined : 'invalid_request'
    const error = refused ?? (this.options.consent === 'deny' ? 'access_denied' : undefined)
    if (error !== undefined) {
      target.search = new URLSearchParams({ error, state }).toString()
    } else {
      this.codeCounter += 1
      const code = `code-${this.codeCounter}`
      this.codes.set(code, { clientId, redirectUri, codeChallenge: params.get('code_challenge') ?? '', scope: params.get('scope') ?? '' })
      const iss = this.options.issuerTrailingSlash === true ? `${this.origin}/` : this.origin
      target.search = new URLSearchParams(this.options.issuerParameter === false ? { code, state } : { code, state, iss }).toString()
    }
    response.writeHead(302, { location: target.href })
    response.end()
  }

  private isAcceptedClient(clientId: string): boolean {
    return this.registered.has(clientId) || this.options.allowedClientIds?.includes(clientId) === true
  }

  private token(form: URLSearchParams, response: ServerResponse): void {
    const grantType = form.get('grant_type') ?? ''
    const clientId = form.get('client_id') ?? ''
    const unavailable = grantType === 'refresh_token' ? 'refreshFailure' : 'authorization_code' === grantType ? 'exchangeFailure' : undefined
    if (unavailable !== undefined && this.options[unavailable] === 'server_error') {
      oauthError(response, 500, 'server_error', 'token service unavailable')
      return
    }
    if (unavailable === undefined) {
      oauthError(response, 400, 'unsupported_grant_type', `${grantType} is not supported`)
      return
    }
    const rejectedClient = this.options[unavailable] === 'invalid_client' || this.options[unavailable] === 'unauthorized_client' || !this.isAcceptedClient(clientId)
    if (rejectedClient) {
      oauthError(response, 401, this.options[unavailable] === 'unauthorized_client' ? 'unauthorized_client' : 'invalid_client', 'client refused')
      return
    }
    const granted = grantType === 'refresh_token' ? this.refresh(form) : this.exchange(form, clientId)
    if (granted === undefined) oauthError(response, 400, 'invalid_grant', 'the presented grant is invalid')
    else json(response, 200, granted)
  }

  private refresh(form: URLSearchParams): Record<string, unknown> | undefined {
    const presented = form.get('refresh_token') ?? ''
    const issued = this.refreshTokens.get(presented)
    if (issued === undefined || this.options.refreshFailure === 'invalid_grant') return undefined
    // A server that does not rotate keeps the presented refresh token valid.
    if (this.options.omitRefreshToken !== true) this.refreshTokens.delete(presented)
    return this.issue(issued.scope, true)
  }

  private exchange(form: URLSearchParams, clientId: string): Record<string, unknown> | undefined {
    const presented = form.get('code') ?? ''
    const code = this.codes.get(presented)
    if (code === undefined || code.clientId !== clientId || code.redirectUri !== form.get('redirect_uri')
      || !pkceMatches(code.codeChallenge, form.get('code_verifier') ?? '')) {
      return undefined
    }
    this.codes.delete(presented)
    return this.issue(form.get('scope') ?? code.scope)
  }

  private issue(scope: string, refreshed = false): Record<string, unknown> {
    this.tokenCounter += 1
    const refreshToken = `ref-${this.tokenCounter}`
    if (!refreshed || this.options.rejectRefreshedTokens !== true) this.tokens.set(`acc-${this.tokenCounter}`, { refreshToken, scope })
    this.refreshTokens.set(refreshToken, { refreshToken, scope })
    return {
      access_token: `acc-${this.tokenCounter}`,
      token_type: 'Bearer',
      ...refreshed && this.options.omitRefreshToken === true ? {} : { refresh_token: refreshToken },
      ...scope === '' ? {} : { scope },
      ...this.options.tokenTtlSeconds === undefined ? {} : { expires_in: this.options.tokenTtlSeconds },
    }
  }

  private async resource(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const anonymous = this.options.anonymous === true
    const presented = request.headers.authorization
    const bearer = presented?.startsWith('Bearer ') === true ? presented.slice('Bearer '.length) : undefined
    if (!anonymous && (bearer === undefined || !this.tokens.has(bearer))) {
      this.challenge(response, 401, bearer === undefined ? {} : { error: 'invalid_token' })
      return
    }
    if (this.options.insufficientScope === true) {
      this.challenge(response, 403, { error: 'insufficient_scope', scope: 'admin' })
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const server = new McpServer({ name: 'oauth-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.registerTool('ping', { description: 'Replies pong.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    const transport = new StreamableHTTPServerTransport({})
    response.on('close', () => { void transport.close(); void server.close() })
    // The SDK types its optional transport callbacks without `| undefined`; the SDK built the object.
    await server.connect(transport as Transport)
    await transport.handleRequest(request, response)
  }
}
