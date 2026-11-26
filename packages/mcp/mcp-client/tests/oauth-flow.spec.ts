/**
 * The explicit authorization flow: discovery through the endpoint's own
 * challenge, dynamic registration against a configured client id, the PKCE
 * authorization request, the issuer-bound code exchange, the committed
 * record, and the refusals a flow reports without quoting a code or token.
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { oauthFetch } from '@deepseek-ai/dsh-mcp-client/src/oauth-request.ts'
import { NEVER_ABORTED } from '@deepseek-ai/dsh-mcp-client/src/oauth-request.ts'
import { createOAuthSession } from '@deepseek-ai/dsh-mcp-client/src/oauth-session.ts'
import type { McpOAuthSession, McpOAuthSessionHooks } from '@deepseek-ai/dsh-mcp-client/src/oauth-session.ts'
import type { McpOAuthFlow } from '@deepseek-ai/dsh-mcp-client/src/oauth-flow.ts'
import { tokenExpiryOf } from '@deepseek-ai/dsh-mcp-client/src/oauth-flow.ts'
import type { McpOAuthCredentialStore } from '@deepseek-ai/dsh-mcp-client/src/oauth-store.ts'
import { OAuthFixture } from './oauth-fixture-server.ts'
import { authorize, consent, httpConfig, MemoryCredentials, optionsOf, readGrant, REDIRECT_URI, STATE } from './oauth-harness.ts'

const hooks: McpOAuthSessionHooks = { onWaiting: () => {}, onResume: () => {} }

/** The coded failure a promise rejects with, asserted to be the bridge's own. */
async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string; cause: unknown }> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason) as { code: string; message: string; cause: unknown }
  expect(error.code).toBe('MCP_OAUTH_FAILED')
  return error
}

describe('OAuth authorization flow', () => {
  let fixture: OAuthFixture
  let store: MemoryCredentials
  const sessions: McpOAuthSession[] = []

  beforeEach(async () => {
    fixture = await OAuthFixture.start()
    store = new MemoryCredentials()
  })
  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose()
    await fixture.close()
  })

  function session(overrides: Partial<Parameters<typeof httpConfig>[1]> = {}): McpOAuthSession {
    const config = httpConfig(fixture, overrides)
    const created = createOAuthSession({ config, options: optionsOf(config), serverKey: 'web', store, hooks })
    sessions.push(created)
    return created
  }

  it('discovers through the endpoint challenge, registers a client, and builds a PKCE authorization request', async () => {
    const flow = session({ headers: { 'X-Api-Key': 'resource-key' } }).createFlow()
    const { authorizationUrl } = await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })
    const url = new URL(authorizationUrl)
    expect(`${url.origin}${url.pathname}`).toBe(`${fixture.baseUrl}/authorize`)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('state')).toBe(STATE)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('scope')).toBe('mcp:tools')
    expect(url.searchParams.get('resource')).toBe(`${fixture.baseUrl}/`)
    expect(fixture.registrations).toEqual([{
      client_name: 'Harniverse',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }])
    expect(url.searchParams.get('client_id')).toBe(`client-${createHash('sha256').update(REDIRECT_URI).digest('hex').slice(0, 8)}`)
    expect(fixture.requests.slice(0, 4)).toEqual([
      'GET /mcp', 'GET /.well-known/oauth-protected-resource/mcp', 'GET /.well-known/oauth-authorization-server', 'POST /register',
    ])
    // The challenge asks the endpoint with its resource header and no credential; the metadata and registration requests carry neither.
    expect(fixture.requestHeaders[0]!['x-api-key']).toBe('resource-key')
    expect(fixture.requestHeaders[0]!.authorization).toBeUndefined()
    for (const headers of fixture.requestHeaders.slice(1, 4)) {
      expect(headers['x-api-key']).toBeUndefined()
      expect(headers.authorization).toBeUndefined()
    }
  })

  it('uses a configured client id without registering, and the configured scope over the server suggestion', async () => {
    fixture.configure({ allowedClientIds: ['app-1'], allowedRedirectUris: [REDIRECT_URI] })
    const flow = session({ oauth: { clientId: 'app-1', scope: 'mcp:tools mcp:admin' } }).createFlow()
    const { authorizationUrl } = await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })
    expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe('app-1')
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('mcp:tools mcp:admin')
    expect(fixture.requests).not.toContain('POST /register')
    const callback = await consent(authorizationUrl)
    await flow.exchange({ code: callback.get('code')!, iss: callback.get('iss')! })
    await flow.commit()
    expect(readGrant(store)).toMatchObject({ registered: false, configured: { clientId: 'app-1', scope: 'mcp:tools mcp:admin' }, scope: 'mcp:tools mcp:admin' })
    expect(fixture.tokenRequests[0]!.get('client_id')).toBe('app-1')
  })

  it('stores one self-contained record whose token lifetime keeps a refresh margin', async () => {
    fixture.configure({ tokenTtlSeconds: 3600 })
    const before = Date.now()
    await authorize(session())
    const grant = readGrant(store)!
    expect(grant).toMatchObject({
      version: 1,
      serverUrl: fixture.url,
      issuer: fixture.baseUrl,
      registered: true,
      redirectUri: REDIRECT_URI,
      resource: `${fixture.baseUrl}/`,
      scope: 'mcp:tools',
      configured: {},
      tokens: { access_token: 'acc-1', token_type: 'Bearer', refresh_token: 'ref-1', scope: 'mcp:tools' },
    })
    expect(grant.clientInformation.client_id).toMatch(/^client-/)
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000 - 30_000)
    expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000 - 30_000)
    expect(Object.keys(grant.metadata ?? {}).length).toBeGreaterThan(0)
    // A one-second token keeps half its lifetime; an hour-long one keeps the full margin.
    expect(tokenExpiryOf({ access_token: 'a', token_type: 'Bearer', expires_in: 1 }, 1_000)).toBe(1_500)
    expect(tokenExpiryOf({ access_token: 'a', token_type: 'Bearer' }, 1_000)).toBeUndefined()
    expect(JSON.stringify(grant)).not.toContain('codeVerifier')
  })

  it('reuses a stored dynamic registration for the same redirect URI and replaces it when the URI moves', async () => {
    await authorize(session())
    await authorize(session())
    expect(fixture.registrations).toHaveLength(1)
    await authorize(session(), 'http://127.0.0.1:43000/mcp/oauth/callback/other')
    expect(fixture.registrations).toHaveLength(2)
    expect(readGrant(store)?.redirectUri).toBe('http://127.0.0.1:43000/mcp/oauth/callback/other')
  })

  it('refuses an issuer the authorization server did not announce and a commit without an exchange', async () => {
    const flow = session().createFlow()
    const { authorizationUrl } = await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })
    await expect(flow.commit()).rejects.toThrow('MCP OAuth: no exchanged token is pending a commit')
    const callback = await consent(authorizationUrl)
    const mismatch = 'MCP OAuth: the authorization response issuer does not match the authorization server'
    // The server announces the issuer parameter, so a foreign issuer and an absent one are both refused.
    expect((await failure(flow.exchange({ code: callback.get('code')!, iss: 'https://issuer.example' }))).message).toBe(mismatch)
    expect((await failure(flow.exchange({ code: callback.get('code')!, iss: undefined }))).message).toBe(mismatch)
    await flow.exchange({ code: callback.get('code')!, iss: callback.get('iss')! })
    await flow.commit()
    expect(readGrant(store)).toBeDefined()
  })

  it('drops a stored dynamic registration the authorization server no longer knows', async () => {
    await authorize(session())
    fixture.configure({ exchangeFailure: 'invalid_client' })
    const flow = session().createFlow()
    const { authorizationUrl } = await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })
    const callback = await consent(authorizationUrl)
    const code = callback.get('code')!
    const error = await failure(flow.exchange({ code, iss: callback.get('iss')! }))
    expect(error.message).toBe('MCP OAuth authorization code exchange was refused by the authorization server (invalid_client)')
    expect(error.message).not.toContain(code)
    expect(store.values.size).toBe(0)
  })

  it('fails a hung request at its deadline and a cancelled step without quoting the request', async () => {
    fixture.configure({ hangPaths: ['/register'] })
    const hung = session({ oauth: { requestTimeoutMs: 100 } }).createFlow()
    const error = await failure(hung.begin({ redirectUri: REDIRECT_URI, state: STATE }))
    expect(error.message).toBe('MCP OAuth request timed out after 100ms')

    const cancelled = session().createFlow()
    const pending = failure(cancelled.begin({ redirectUri: REDIRECT_URI, state: STATE }))
    cancelled.dispose()
    expect((await pending).message).toBe('MCP OAuth request was cancelled')
  })

  it('refuses a redirected token endpoint and a resource that does not cover the endpoint', async () => {
    fixture.configure({ redirectPaths: ['/token'] })
    const flow = session().createFlow()
    const { authorizationUrl } = await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })
    const callback = await consent(authorizationUrl)
    const error = await failure(flow.exchange({ code: callback.get('code')!, iss: callback.get('iss')! }))
    // A redirect is never followed, so the refusal is the network failure of the refused redirect itself.
    expect(error.message).toBe('MCP OAuth request failed')
    expect(fixture.requests.some(entry => entry.endsWith('/moved'))).toBe(false)

    fixture.configure({ resource: 'https://other.example/' })
    const uncovered = await failure(session().createFlow().begin({ redirectUri: REDIRECT_URI, state: STATE }))
    expect(uncovered.message).toBe('MCP OAuth: the server advertises a protected resource that does not cover its endpoint')
  })

  it('applies the transport rule and the per-request deadline to every OAuth request', async () => {
    const refused = await failure(oauthFetch({ signal: NEVER_ABORTED, timeoutMs: 1_000 })('http://mcp.example/mcp', {}))
    expect(refused.message).toBe('MCP OAuth requires HTTPS except for loopback HTTP')

    const never: AbortSignal = new AbortController().signal
    const aborted = new AbortController()
    aborted.abort()
    expect((await failure(oauthFetch({ signal: aborted.signal, timeoutMs: 1_000 })(fixture.url, {}))).message).toBe('MCP OAuth request was cancelled')

    const network = await failure(oauthFetch({ signal: never, timeoutMs: 100 })('https://127.0.0.1:9/mcp', {}))
    expect(['MCP OAuth request timed out after 100ms', 'MCP OAuth request failed']).toContain(network.message)
  })

  it('treats the server as its own authorization server when it publishes no metadata', async () => {
    fixture.configure({ metadata: 'legacy', challengeScope: false, issuerTrailingSlash: true })
    const flow = session().createFlow()
    const { authorizationUrl } = await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })
    const url = new URL(authorizationUrl)
    expect(`${url.origin}${url.pathname}`).toBe(`${fixture.baseUrl}/authorize`)
    expect(url.searchParams.has('scope')).toBe(false)
    expect(url.searchParams.has('resource')).toBe(false)
    expect(fixture.registrations).toHaveLength(1)
    const callback = await consent(authorizationUrl)
    await flow.exchange({ code: callback.get('code')!, iss: callback.get('iss')! })
    await flow.commit()
    expect(readGrant(store)).toMatchObject({ issuer: `${fixture.baseUrl}/` })
    expect(readGrant(store)).not.toHaveProperty('scope')
    expect(readGrant(store)?.metadata).toBeUndefined()
    expect(readGrant(store)?.resource).toBeUndefined()

    // Without an announced issuer parameter an absent one is accepted; a settled flow accepts nothing more.
    fixture.configure({ issuerParameter: false })
    const unannounced = session().createFlow()
    const second = await consent((await unannounced.begin({ redirectUri: REDIRECT_URI, state: STATE })).authorizationUrl)
    await unannounced.exchange({ code: second.get('code')!, iss: undefined })
    await unannounced.commit()
    unannounced.dispose()
    await expect(unannounced.exchange({ code: 'late', iss: undefined })).rejects.toThrow('MCP OAuth: no authorization request is pending')
  })

  it('registers a dynamic client with the configured scope', async () => {
    const { authorizationUrl } = await session({ oauth: { scope: 'mcp:tools mcp:admin' } }).createFlow().begin({ redirectUri: REDIRECT_URI, state: STATE })
    expect(fixture.registrations[0]!.scope).toBe('mcp:tools mcp:admin')
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('mcp:tools mcp:admin')
  })

  it('reads no challenge from an endpoint that serves anonymous requests', async () => {
    fixture.configure({ anonymous: true, challengeScope: false })
    const { authorizationUrl } = await session().createFlow().begin({ redirectUri: REDIRECT_URI, state: STATE })
    // The server's own metadata names the scope and the resource when its challenge does not.
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('mcp:tools')
    expect(new URL(authorizationUrl).searchParams.get('resource')).toBe(`${fixture.baseUrl}/`)
  })

  it('reports an unusable authorization server without quoting its document', async () => {
    fixture.configure({ responseTypes: ['token'] })
    const unsupported = await failure(session().createFlow().begin({ redirectUri: REDIRECT_URI, state: STATE }))
    expect(unsupported.message).toBe('MCP OAuth authorization request failed')

    fixture.configure({ responseTypes: ['code'], malformedMetadata: true })
    const malformed = await failure(session().createFlow().begin({ redirectUri: REDIRECT_URI, state: STATE }))
    expect(malformed.message).toBe('MCP OAuth authorization server discovery failed')
    expect(malformed.message).not.toContain('issuer')
  })

  it('drops a stored registration the authorization server is no longer authorized to serve', async () => {
    await authorize(session())
    fixture.configure({ exchangeFailure: 'unauthorized_client' })
    const flow = session().createFlow()
    const callback = await consent((await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })).authorizationUrl)
    const error = await failure(flow.exchange({ code: callback.get('code')!, iss: callback.get('iss')! }))
    expect(error.message).toBe('MCP OAuth authorization code exchange was refused by the authorization server (unauthorized_client)')
    expect(store.values.size).toBe(0)
  })

  it('needs a credentials provider before it commits', async () => {
    const config = httpConfig(fixture)
    const bare = createOAuthSession({ config, options: optionsOf(config), serverKey: 'web', store: undefined, hooks })
    sessions.push(bare)
    const flow: McpOAuthFlow = bare.createFlow()
    const { authorizationUrl } = await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })
    const callback = await consent(authorizationUrl)
    await flow.exchange({ code: callback.get('code')!, iss: callback.get('iss')! })
    await expect(flow.commit()).rejects.toThrow('MCP OAuth requires a credentials provider')
    await expect(bare.accessToken()).rejects.toMatchObject({ reason: 'missing' })
    const unavailable: McpOAuthCredentialStore = {
      resolve: async () => undefined,
      set: async () => { throw new Error('sealed') },
      unset: async () => { throw new Error('sealed') },
    }
    const sealed = createOAuthSession({ config, options: optionsOf(config), serverKey: 'web', store: unavailable, hooks })
    sessions.push(sealed)
    await expect(sealed.signOut()).rejects.toThrow('sealed')
  })
})
