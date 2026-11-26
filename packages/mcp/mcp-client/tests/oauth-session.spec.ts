/**
 * The passive OAuth session and its supervisor: grants read through the
 * credentials seam, the `waiting-authorization` rest state and its reasons,
 * single-flight refresh, bearer attachment and recovery on the endpoint, the
 * coded refusal a tool call receives, resume after an explicit authorization,
 * sign-out, and the passive probe.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { resolveReconnectPolicy, startConnection, startSharedConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { SharedConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import { McpAuthorizationRequired, McpLocalError } from '@deepseek-ai/dsh-mcp-client/src/oauth-errors.ts'
import { createOAuthSession } from '@deepseek-ai/dsh-mcp-client/src/oauth-session.ts'
import type { McpOAuthSession, McpOAuthSessionHooks } from '@deepseek-ai/dsh-mcp-client/src/oauth-session.ts'
import type { McpAuthorizationReason } from '@deepseek-ai/dsh-mcp-client/src/oauth-errors.ts'
import { mcpOAuthCredentialRef, mcpOAuthServerKey } from '@deepseek-ai/dsh-mcp-client/src/oauth-store.ts'
import { oauthFetch } from '@deepseek-ai/dsh-mcp-client/src/oauth-request.ts'
import { NEVER_ABORTED } from '@deepseek-ai/dsh-mcp-client/src/oauth-request.ts'
import { probeServer } from '@deepseek-ai/dsh-mcp-client/src/probe.ts'
import { OAuthFixture } from './oauth-fixture-server.ts'
import {
  authorize,
  consent,
  expireGrant,
  httpConfig,
  MemoryCredentials,
  optionsOf,
  readGrant,
  REDIRECT_URI,
  STATE,
  writeGrant,
} from './oauth-harness.ts'

const signal = new AbortController().signal

/** One `initialize` request exactly as the MCP transport sends it. */
function initialize(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spec', version: '0.0.0' } } }),
  }
}

async function registry(store: MemoryCredentials): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('credentials', store)
  return ctx
}

/** The coded failure a promise rejects with, asserted to be the bridge's own. */
async function refusal(promise: Promise<unknown>): Promise<McpLocalError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(McpLocalError)
  return error as McpLocalError
}

describe('OAuth session', () => {
  let fixture: OAuthFixture
  let store: MemoryCredentials
  const onWaiting = vi.fn<(reason: McpAuthorizationReason) => void>()
  const onResume = vi.fn()
  const hooks: McpOAuthSessionHooks = { onWaiting, onResume }

  beforeEach(async () => {
    fixture = await OAuthFixture.start()
    store = new MemoryCredentials()
    onWaiting.mockClear()
    onResume.mockClear()
  })
  afterEach(async () => {
    await fixture.close()
  })

  function session(overrides: Partial<Parameters<typeof httpConfig>[1]> = {}): McpOAuthSession {
    const config = httpConfig(fixture, overrides)
    return createOAuthSession({ config, options: optionsOf(config), serverKey: 'web', store, hooks })
  }

  it('reports a missing grant without touching the server', async () => {
    const active = session()
    expect(active.status()).toBeUndefined()
    const error = await refusal(active.accessToken())
    expect(error).toMatchObject({ code: 'MCP_AUTHORIZATION_REQUIRED', reason: 'missing', message: 'MCP OAuth requires authorization: missing' })
    expect(hooks.onWaiting).toHaveBeenCalledWith('missing')
    expect(active.status()).toEqual({ state: 'waiting-authorization', reason: 'missing' })
    expect(fixture.requests).toEqual([])
  })

  it('reads a stored grant only for the endpoint and options it was issued for', async () => {
    await authorize(session())
    const active = session()
    expect(await active.accessToken()).toBe('acc-1')
    expect(active.status()).toEqual({ state: 'authorized' })
    expect(active.waitingReason()).toBeUndefined()
    expect(active.authorizationTimeoutMs).toBe(600_000)
    expect(store.values.get(mcpOAuthCredentialRef('web'))).toContain('"serverUrl"')

    const moved = createOAuthSession({
      config: httpConfig(fixture, { url: `${fixture.url}/moved` }),
      options: optionsOf(httpConfig(fixture)),
      serverKey: 'web',
      store,
      hooks,
    })
    await expect(moved.accessToken()).rejects.toMatchObject({ code: 'MCP_AUTHORIZATION_REQUIRED', reason: 'binding' })
    await expect(session({ oauth: { clientId: 'another-client' } }).accessToken()).rejects.toMatchObject({ reason: 'binding' })
    await expect(session({ oauth: { scope: 'mcp:admin' } }).accessToken()).rejects.toMatchObject({ reason: 'binding' })
    expect(fixture.requests.filter(entry => entry.endsWith(' /moved'))).toEqual([])
  })

  it('treats an unreadable or foreign-version record as a binding mismatch', async () => {
    store.values.set(mcpOAuthCredentialRef('web'), 'not a grant')
    await expect(session().accessToken()).rejects.toMatchObject({ reason: 'binding' })
    store.values.set(mcpOAuthCredentialRef('web'), JSON.stringify({ version: 2 }))
    await expect(session().accessToken()).rejects.toMatchObject({ reason: 'binding' })
  })

  it('refreshes an expired token single-flight and serializes successive refreshes', async () => {
    await authorize(session())
    const active = session()
    expireGrant(store)
    const tokens = await Promise.all([active.accessToken(), active.accessToken(), active.accessToken()])
    expect(new Set(tokens)).toEqual(new Set(['acc-2']))
    expect(fixture.tokenGrants).toEqual(['authorization_code', 'refresh_token'])

    expireGrant(store)
    const again = await Promise.all([active.accessToken(), active.accessToken()])
    expect(new Set(again)).toEqual(new Set(['acc-3']))
    expect(fixture.tokenGrants).toEqual(['authorization_code', 'refresh_token', 'refresh_token'])
    expect(readGrant(store)?.expiresAt).toBeUndefined()
  })

  it('waits with reason expired when the grant cannot be refreshed', async () => {
    await authorize(session())
    const grant = readGrant(store)!
    writeGrant(store, { ...grant, expiresAt: Date.now() - 1, tokens: { access_token: grant.tokens.access_token, token_type: 'Bearer' } })
    await expect(session().accessToken()).rejects.toMatchObject({ code: 'MCP_AUTHORIZATION_REQUIRED', reason: 'expired' })
    expect(fixture.tokenGrants).toEqual(['authorization_code'])

    expireGrant(store)
    fixture.configure({ refreshFailure: 'invalid_grant' })
    const refused = session()
    await expect(refused.accessToken()).rejects.toMatchObject({ reason: 'expired' })
    expect(refused.status()).toEqual({ state: 'waiting-authorization', reason: 'expired' })
  })

  it('waits with reason rejected when the authorization server refuses the client', async () => {
    await authorize(session())
    expireGrant(store)
    fixture.configure({ refreshFailure: 'invalid_client' })
    await expect(session().accessToken()).rejects.toMatchObject({ code: 'MCP_AUTHORIZATION_REQUIRED', reason: 'rejected' })
  })

  it('keeps a transient refresh failure retryable and never quotes the upstream text', async () => {
    await authorize(session())
    expireGrant(store)
    fixture.configure({ refreshFailure: 'server_error' })
    const active = session()
    const error = await refusal(active.accessToken())
    expect(error.code).toBe('MCP_OAUTH_FAILED')
    expect(error.message).toBe('MCP OAuth token refresh was refused by the authorization server (server_error)')
    expect(error.message).not.toContain('ref-')
    expect(active.status()).toBeUndefined()
    expect(hooks.onWaiting).not.toHaveBeenCalled()

    fixture.configure({ refreshFailure: undefined })
    expect(await active.accessToken()).toBe('acc-2')
    expect(active.status()).toEqual({ state: 'authorized' })
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('commits an explicit grant behind a refresh that is still in flight, so the refresh cannot overwrite it', async () => {
    const passive = session()
    await authorize(passive)
    expireGrant(store)
    const explicit = session().createFlow()
    const callback = await consent((await explicit.begin({ redirectUri: REDIRECT_URI, state: STATE })).authorizationUrl)

    fixture.holdTokens('refresh_token')
    const refreshing = passive.accessToken()
    await vi.waitFor(() => { expect(fixture.tokenGrants).toContain('refresh_token') })
    const committed = (async () => {
      await explicit.exchange({ code: callback.get('code')!, iss: callback.get('iss')! })
      await explicit.commit()
    })()
    await vi.waitFor(() => { expect(fixture.tokenGrants).toEqual(['authorization_code', 'refresh_token', 'authorization_code']) })
    fixture.releaseTokens()
    // The exchange was never held, so it minted the earlier token; the held refresh minted the later one.
    await expect(refreshing).resolves.toBe('acc-3')
    await committed
    expect(readGrant(store)?.tokens.access_token).toBe('acc-2')
    expect(readGrant(store)?.expiresAt).toBeUndefined()
  })

  it('refuses to send the endpoint credential to another origin', async () => {
    await authorize(session())
    const error = await refusal(session().fetch(`${fixture.baseUrl.replace('127.0.0.1', 'localhost')}/mcp`, {}))
    expect(error.code).toBe('MCP_OAUTH_FAILED')
    expect(fixture.requests).toEqual([
      'GET /mcp', 'GET /.well-known/oauth-protected-resource/mcp', 'GET /.well-known/oauth-authorization-server',
      'POST /register', 'GET /authorize', 'POST /token',
    ])
  })

  it('answers one refused request with one refresh and one retry', async () => {
    await authorize(session())
    fixture.revokeAccessTokens()
    const response = await session().fetch(fixture.url, initialize())
    expect(response.status).toBe(200)
    expect(fixture.tokenGrants).toEqual(['authorization_code', 'refresh_token'])
    await response.body?.cancel()
  })

  it('waits with reason rejected when the endpoint keeps refusing a refreshed token', async () => {
    await authorize(session())
    fixture.configure({ rejectRefreshedTokens: true })
    fixture.revokeAccessTokens()
    const active = session()
    const response = await active.fetch(fixture.url, initialize())
    expect(response.status).toBe(401)
    await response.body?.cancel()
    expect(active.status()).toEqual({ state: 'waiting-authorization', reason: 'rejected' })
    expect(fixture.tokenGrants.filter(grant => grant === 'refresh_token')).toHaveLength(1)
  })

  it('waits with reason scope when the endpoint asks for a wider scope, before or after a refresh', async () => {
    await authorize(session())
    fixture.configure({ insufficientScope: true })
    const active = session()
    const response = await active.fetch(fixture.url, initialize())
    expect(response.status).toBe(403)
    await response.body?.cancel()
    expect(active.status()).toEqual({ state: 'waiting-authorization', reason: 'scope' })
    expect(fixture.tokenGrants).toEqual(['authorization_code'])

    await authorize(session())
    fixture.revokeAccessTokens()
    const refreshed = session()
    const retry = await refreshed.fetch(fixture.url, initialize())
    expect(retry.status).toBe(403)
    await retry.body?.cancel()
    expect(fixture.tokenGrants).toEqual(['authorization_code', 'authorization_code', 'refresh_token'])
    expect(refreshed.status()).toEqual({ state: 'waiting-authorization', reason: 'scope' })
  })

  it('signs out behind a refresh that is still in flight, so the refresh cannot restore the grant', async () => {
    await authorize(session())
    expireGrant(store)
    fixture.holdTokens()
    const active = session()
    const refreshing = active.accessToken()
    await vi.waitFor(() => { expect(fixture.tokenGrants).toContain('refresh_token') })

    const signingOut = active.signOut()
    fixture.releaseTokens()
    await expect(refreshing).resolves.toBe('acc-2')
    await signingOut
    expect(readGrant(store)).toBeUndefined()
    expect(active.status()).toEqual({ state: 'waiting-authorization', reason: 'missing' })
    await expect(active.accessToken()).rejects.toMatchObject({ reason: 'missing' })
  })

  it('refuses immediately once it waits, without another token request', async () => {
    await authorize(session())
    expireGrant(store)
    fixture.configure({ refreshFailure: 'invalid_grant' })
    const refused = session()
    await expect(refused.accessToken()).rejects.toMatchObject({ reason: 'expired' })
    await expect(refused.accessToken()).rejects.toMatchObject({ code: 'MCP_AUTHORIZATION_REQUIRED', reason: 'expired' })
    expect(fixture.tokenGrants).toEqual(['authorization_code', 'refresh_token'])
    expect((await refusal(refused.fetch(fixture.url, initialize()))).code).toBe('MCP_AUTHORIZATION_REQUIRED')
  })

  it('reports the refresh deadline of a token with a lifetime and refreshes a grant that carries no metadata', async () => {
    fixture.configure({ tokenTtlSeconds: 3600, metadata: 'legacy', issuerTrailingSlash: true })
    const before = Date.now()
    const active = session()
    await authorize(active)
    expect(await active.accessToken()).toBe('acc-1')
    const authorized = active.status()
    if (authorized?.state !== 'authorized') throw new Error('the session reads its grant as authorized')
    expect(typeof authorized.expiresAtMs).toBe('number')
    expect(readGrant(store)?.metadata).toBeUndefined()

    expireGrant(store)
    expect(await active.accessToken()).toBe('acc-2')
    expect(readGrant(store)?.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000 - 30_000)
    expect(fixture.tokenGrants).toEqual(['authorization_code', 'refresh_token'])
  })

  it('keeps the stored refresh token when the server does not rotate it', async () => {
    await authorize(session())
    expireGrant(store)
    fixture.configure({ omitRefreshToken: true })
    expect(await session().accessToken()).toBe('acc-2')
    expect(readGrant(store)?.tokens.refresh_token).toBe('ref-1')
    expireGrant(store)
    expect(await session().accessToken()).toBe('acc-3')
  })

  it('passes a caller signal through and leaves a transiently failed recovery to the caller', async () => {
    const callerSignal = new AbortController().signal
    const response = await oauthFetch({ signal: NEVER_ABORTED, timeoutMs: 5_000 })(fixture.url, { ...initialize(), signal: callerSignal })
    expect(response.status).toBe(401)
    await response.body?.cancel()

    await authorize(session())
    fixture.revokeAccessTokens()
    const noRefresh = readGrant(store)!
    writeGrant(store, { ...noRefresh, tokens: { access_token: noRefresh.tokens.access_token, token_type: 'Bearer' } })
    const expired = session()
    const refused = await expired.fetch(fixture.url, initialize())
    expect(refused.status).toBe(401)
    await refused.body?.cancel()
    expect(expired.status()).toEqual({ state: 'waiting-authorization', reason: 'expired' })

    await authorize(session())
    fixture.configure({ refreshFailure: 'server_error' })
    fixture.revokeAccessTokens()
    const transient = session()
    const error = await refusal(transient.fetch(fixture.url, initialize()))
    expect(error.code).toBe('MCP_OAUTH_FAILED')
    expect(transient.waitingReason()).toBeUndefined()
  })

  it('keys the grant reference by the identity a config carries', () => {
    const owner = { ...httpConfig(fixture), serverId: 'fleet-web' }
    expect(mcpOAuthServerKey(owner as never)).toBe('fleet-web')
    expect(mcpOAuthServerKey({ ...owner, serverId: 7 } as never)).toBe('web')
    expect(mcpOAuthServerKey(httpConfig(fixture))).toBe('web')
  })

  it('signs out, resumes, and reports the same state through status', async () => {
    const active = session()
    await active.signOut()
    expect(active.status()).toEqual({ state: 'waiting-authorization', reason: 'missing' })
    await authorize(active)
    expect(readGrant(store)?.registered).toBe(true)
    await active.signOut()
    expect(store.values.size).toBe(0)
    expect(active.status()).toEqual({ state: 'waiting-authorization', reason: 'missing' })
    active.resume()
    expect(hooks.onResume).toHaveBeenCalledTimes(1)
    expect(active.waitingReason()).toBeUndefined()
  })
})

describe('OAuth shared connection', () => {
  let fixture: OAuthFixture
  let store: MemoryCredentials
  let ctx: Context
  const connections: SharedConnection[] = []
  const policy = resolveReconnectPolicy({ enabled: true, initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 3 }, 'test')

  beforeEach(async () => {
    fixture = await OAuthFixture.start()
    store = new MemoryCredentials()
    ctx = await registry(store)
  })
  afterEach(async () => {
    for (const connection of connections.splice(0)) await connection.dispose()
    await ctx.fiber.dispose()
    await fixture.close()
  })

  function connect(overrides: Partial<Parameters<typeof httpConfig>[1]> = {}): SharedConnection {
    const connection = startSharedConnection(ctx, httpConfig(fixture, overrides), policy)
    connections.push(connection)
    return connection
  }

  it('waits for authorization at startup instead of connecting or retrying, and resumes after a commit', async () => {
    const connection = connect()
    const outcome = await connection.ready
    expect(outcome.error).toBeInstanceOf(McpAuthorizationRequired)
    expect(connection.status()).toEqual({
      state: 'waiting-authorization',
      failedAttempts: 0,
      maxAttempts: 3,
      lastErrorKind: 'McpAuthorizationRequired',
      authorization: { state: 'waiting-authorization', reason: 'missing' },
    })
    expect(fixture.requests).toEqual([])
    const error = await refusal(connection.callTool('ping', {}, {}))
    expect(error).toMatchObject({ code: 'MCP_AUTHORIZATION_REQUIRED', message: 'MCP OAuth requires authorization: missing' })
    await expect(connection.resources.request({ method: 'resources/list' }, { signal } as never)).rejects.toMatchObject({ code: 'MCP_AUTHORIZATION_REQUIRED' })

    const flow = connection.oauth!.createFlow()
    const { authorizationUrl } = await flow.begin({ redirectUri: REDIRECT_URI, state: STATE })
    expect(new URL(authorizationUrl).origin).toBe(fixture.baseUrl)
    const callback = await consent(authorizationUrl)
    await flow.exchange({ code: callback.get('code')!, iss: callback.get('iss')! })
    await flow.commit()
    connection.oauth!.resume()
    await vi.waitFor(() => { expect(connection.status().state).toBe('connected') })
    expect(connection.status().authorization).toEqual({ state: 'authorized' })
    expect(connection.toolNames()).toEqual(['mcp__web__ping'])
    expect(await connection.callTool('ping', {}, {})).toMatchObject({ content: [{ type: 'text', text: 'pong' }] })
  })

  it('connects with a stored grant and keeps resource headers off the authorization server', async () => {
    const bootstrapping = createOAuthSession({
      config: httpConfig(fixture, { headers: { 'X-Api-Key': 'resource-key' } }),
      options: optionsOf(httpConfig(fixture)),
      serverKey: 'web',
      store,
      hooks: { onWaiting: () => {}, onResume: () => {} },
    })
    await authorize(bootstrapping)
    bootstrapping.dispose()
    const oauthRequests = fixture.requests.length

    const connection = connect({ headers: { 'X-Api-Key': 'resource-key' } })
    await vi.waitFor(() => { expect(connection.status().state).toBe('connected') })
    expect(connection.oauth).toBeDefined()
    const endpointHeaders = fixture.requestHeaders.slice(oauthRequests)
    expect(endpointHeaders.length).toBeGreaterThan(0)
    for (const headers of endpointHeaders) {
      expect(headers.authorization).toBe('Bearer acc-1')
      expect(headers['x-api-key']).toBe('resource-key')
    }
    // The unauthenticated challenge asks the endpoint itself; every authorization-server request stays free of resource headers.
    const serverRequests = fixture.requests.slice(0, oauthRequests).flatMap((entry, index) => entry.endsWith(' /mcp') ? [] : [fixture.requestHeaders[index]!])
    expect(serverRequests.length).toBeGreaterThan(0)
    for (const headers of serverRequests) {
      expect(headers['x-api-key']).toBeUndefined()
      expect(headers.authorization).toBeUndefined()
    }
    await expect(connection.callTool('ping', {}, {})).resolves.toMatchObject({ content: [{ type: 'text', text: 'pong' }] })
  })

  it('stores a shared owner grant under its settings id and ignores a resume while connected', async () => {
    const config = { ...httpConfig(fixture), serverId: 'fleet-web' }
    await authorize(createOAuthSession({
      config,
      options: optionsOf(httpConfig(fixture)),
      serverKey: mcpOAuthServerKey(config),
      store,
      hooks: { onWaiting: () => {}, onResume: () => {} },
    }))
    expect([...store.values.keys()]).toEqual([mcpOAuthCredentialRef('fleet-web')])
    const connection = startSharedConnection(ctx, config, policy)
    connections.push(connection)
    await vi.waitFor(() => { expect(connection.status().state).toBe('connected') })
    const requests = fixture.requests.length
    connection.oauth!.resume()
    await connection.ready
    expect(connection.status().state).toBe('connected')
    expect(fixture.requests.length).toBe(requests)
  })

  it('never connects from a resume that lands after its connection was disposed', async () => {
    await authorize(createOAuthSession({
      config: httpConfig(fixture),
      options: optionsOf(httpConfig(fixture)),
      serverKey: 'web',
      store,
      hooks: { onWaiting: () => {}, onResume: () => {} },
    }))
    const connection = connect()
    await vi.waitFor(() => { expect(connection.status().state).toBe('connected') })
    await connection.dispose()
    const requests = fixture.requests.length

    connection.oauth!.resume()
    const leaked = await vi.waitFor(() => { expect(fixture.requests.length).toBeGreaterThan(requests) }, { timeout: 300, interval: 20 })
      .then(() => true, () => false)
    expect(leaked).toBe(false)
  })

  it('never connects once disposed while a token refresh is still pending', async () => {
    await authorize(createOAuthSession({
      config: httpConfig(fixture),
      options: optionsOf(httpConfig(fixture)),
      serverKey: 'web',
      store,
      hooks: { onWaiting: () => {}, onResume: () => {} },
    }))
    expireGrant(store)
    const realFetch = globalThis.fetch
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held!: () => void
    const tokenHeld = new Promise<void>((resolve) => { held = resolve })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init)
      if (new URL(input instanceof Request ? input.url : input.toString()).pathname === '/token') {
        held()
        await gate
      }
      return response
    })
    try {
      const connection = connect()
      await tokenHeld
      const endpointRequests = (): number => fixture.requests.filter(entry => entry.endsWith(' /mcp')).length
      const before = endpointRequests()
      const disposing = connection.dispose()
      release()
      await disposing
      const leaked = await vi.waitFor(() => { expect(endpointRequests()).toBe(before + 1) }, { timeout: 300, interval: 20 })
        .then(() => true, () => false)
      expect(leaked).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('brings a connected generation down on sign-out and keeps its inventory refusing calls', async () => {
    await authorize(createOAuthSession({
      config: httpConfig(fixture),
      options: optionsOf(httpConfig(fixture)),
      serverKey: 'web',
      store,
      hooks: { onWaiting: () => {}, onResume: () => {} },
    }))
    const connection = connect()
    await vi.waitFor(() => { expect(connection.status().state).toBe('connected') })
    await connection.oauth!.signOut()
    await vi.waitFor(() => { expect(connection.status().state).toBe('waiting-authorization') })
    expect(connection.toolNames()).toEqual(['mcp__web__ping'])
    const error = await refusal(connection.callTool('ping', {}, {}))
    expect(error.code).toBe('MCP_AUTHORIZATION_REQUIRED')
    expect(connection.status().failedAttempts).toBe(0)
  })

  it('leaves a transient refresh failure to the ordinary reconnect loop', async () => {
    const bootstrapping = createOAuthSession({
      config: httpConfig(fixture),
      options: optionsOf(httpConfig(fixture)),
      serverKey: 'web',
      store,
      hooks: { onWaiting: () => {}, onResume: () => {} },
    })
    await authorize(bootstrapping)
    bootstrapping.dispose()
    expireGrant(store)
    fixture.configure({ refreshFailure: 'server_error' })

    const connection = connect()
    const outcome = await connection.ready
    expect(outcome.error).toBeInstanceOf(McpLocalError)
    expect((outcome.error as McpLocalError).code).toBe('MCP_OAUTH_FAILED')
    expect(connection.status().state).toBe('reconnecting')
    expect(connection.status()).not.toHaveProperty('authorization')
    await connection.dispose()
    await vi.waitFor(() => { expect(fixture.tokenGrants.filter(grant => grant === 'refresh_token').length).toBeGreaterThan(0) })
    expect(connection.status().state).toBe('disposed')
  })

  it('refuses a tool call through the registry while the standalone bridge waits', async () => {
    const bootstrapping = createOAuthSession({
      config: httpConfig(fixture),
      options: optionsOf(httpConfig(fixture)),
      serverKey: 'web',
      store,
      hooks: { onWaiting: () => {}, onResume: () => {} },
    })
    await authorize(bootstrapping)
    bootstrapping.dispose()
    const connection = startConnection(ctx, httpConfig(fixture), policy)
    await vi.waitFor(() => { expect(connection.connected()).toBe(true) })
    expect(ctx.tools.get('mcp__web__ping')).toBeDefined()

    await connection.oauth!.signOut()
    await vi.waitFor(() => { expect(connection.oauth!.status()).toEqual({ state: 'waiting-authorization', reason: 'missing' }) })
    const result = await ctx.tools.execute({ signal, callId: CallId('oauth-denied'), name: 'mcp__web__ping', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('MCP OAuth requires authorization: missing')
    await connection.dispose()
  })

  it('rejects a standalone activation that treats a missing grant as fatal', async () => {
    const fatal = httpConfig(fixture, { failOnStartupError: true })
    const error: unknown = await apply(ctx, fatal).then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(McpAuthorizationRequired)
  })

  it('probes passively: the stored grant is used, and a missing grant is reported without a flow', async () => {
    const denied = await probeServer(httpConfig(fixture), { oauth: store })
    expect(denied).toMatchObject({ ok: false, stage: 'connect', message: 'MCP OAuth requires authorization: missing', cleanup: 'ok' })
    expect(fixture.requests).toEqual([])

    await authorize(createOAuthSession({
      config: httpConfig(fixture),
      options: optionsOf(httpConfig(fixture)),
      serverKey: 'web',
      store,
      hooks: { onWaiting: () => {}, onResume: () => {} },
    }))
    const granted = await probeServer(httpConfig(fixture), { oauth: store })
    expect(granted).toMatchObject({ ok: true, toolNames: ['ping'], truncated: false, cleanup: 'ok' })
    expect(fixture.oauthRequests().filter(entry => entry === 'POST /token')).toHaveLength(1)
    const withoutStore = await probeServer(httpConfig(fixture))
    expect(withoutStore).toMatchObject({ ok: false, message: 'MCP OAuth requires authorization: missing' })
  })
})
