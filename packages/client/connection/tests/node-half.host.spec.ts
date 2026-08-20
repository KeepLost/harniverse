/** Node half: registers the /api prefix route bridging to the api gateway. */
import { EventEmitter, once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  authenticationChallengeId,
  authenticationEnrollmentId,
  authenticationGrantId,
  type AuthenticationAttempt,
  type AuthenticationDecision,
  type AuthenticationPrincipal,
  type InboundAuthentication,
} from '@deepseek-ai/dsh-authentication'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH,
  apply,
  HOST_EVENTS_PATH,
  inject,
  MUX_EVENTS_PATH,
  type ConnectionRpcInvocation,
  type HostConnectionHandle,
} from '../src/index.ts'
import { browserSessionFromCookie } from '../src/inbound-auth.ts'

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
  host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1',
  protocol: 'http:' | 'https:' = 'http:',
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port' | 'host' | 'protocol'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
    host,
    protocol,
  }
}

const TEST_PRINCIPAL: AuthenticationPrincipal = {
  kind: 'bypass',
  capabilities: ALL_AUTHENTICATION_CAPABILITIES,
}

const OBSERVER_PRINCIPAL: AuthenticationPrincipal = {
  kind: 'grant',
  grantId: authenticationGrantId('observer-grant'),
  grantRevision: 1,
  capabilities: ['harniverse.observe'],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const GRANT_PRINCIPAL: Extract<AuthenticationPrincipal, { kind: 'grant' }> = {
  kind: 'grant',
  grantId: authenticationGrantId('owner-grant'),
  grantRevision: 1,
  capabilities: ALL_AUTHENTICATION_CAPABILITIES,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const AUTHORIZE_PRINCIPAL: Extract<AuthenticationPrincipal, { kind: 'grant' }> = {
  ...GRANT_PRINCIPAL,
  capabilities: ['harniverse.authorize'],
}

function provideAuthentication(
  ctx: Context,
  decision: AuthenticationDecision = { kind: 'accepted', principal: TEST_PRINCIPAL },
  overrides: Partial<InboundAuthentication> = {},
): void {
  ctx.provide('authentication', {
    mode: 'authenticated',
    authenticate: () => Promise.resolve(decision),
    status: () => Promise.resolve({ mode: 'authenticated', sealed: false }),
    createBrowserSession: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-credential' }),
    requestEnrollment: () => Promise.reject(new Error('not implemented')),
    enrollmentStatus: () => Promise.resolve(undefined),
    listPendingEnrollments: () => Promise.resolve([]),
    approveEnrollment: () => Promise.reject(new Error('not implemented')),
    listGrants: () => Promise.resolve([]),
    revokeGrant: () => Promise.resolve(),
    createChallenge: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-grant' }),
    exchangeAccessToken: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-grant' }),
    issueEmergencyAccessToken: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-grant' }),
    revokeBrowserSession: () => {},
    ...overrides,
  } as unknown as InboundAuthentication)
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return request
}

/** Raw POST for malformed-body and media-type boundary cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' } })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown; headers?: Record<string, string> } } {
  const state: { status?: number; body?: unknown; headers?: Record<string, string> } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number, headers?: Record<string, string>) {
      state.status = value
      if (headers !== undefined) state.headers = headers
      return this
    },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mounted(
  config?: { trustedHosts?: string[]; trustedOrigins?: string[] },
  decision: AuthenticationDecision = { kind: 'accepted', principal: TEST_PRINCIPAL },
  overrides: Partial<InboundAuthentication> = {},
  protocol: 'http:' | 'https:' = 'http:',
): Promise<{
  ctx: Context
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes, upgrades, '127.0.0.1', protocol) as WebServer)
  provideAuthentication(ctx, decision, overrides)
  ctx.provide('apiProxy', {} as unknown as ApiProxy)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return { ctx, routes, upgrades, dispose: () => fiber.dispose() }
}

describe('connection node half', () => {
  it('prefers one secure browser cookie and rejects duplicate selected values', () => {
    const legacy = 'L'.repeat(43)
    const secure = 'S'.repeat(43)
    expect(browserSessionFromCookie(`dsh_auth=${legacy}; __Host-dsh_auth=${secure}`)).toBe(secure)
    expect(browserSessionFromCookie(`__Host-dsh_auth=${secure}; __Host-dsh_auth=${legacy}`)).toBeUndefined()
  })

  it('fails loud when the carrier cap cannot hold the configured image batch', () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    ctx.provide('apiProxy', {} as ApiProxy)
    expect(() => { apply(ctx, { maxRequestBodyBytes: 1024 }) })
      .toThrow(/must be at least .* aggregate image limit/)
    expect(routes).toHaveLength(0)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    provideAuthentication(ctx)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('fails the load on a trustedOrigins entry that is not an exact origin', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    provideAuthentication(ctx)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedOrigins: ['https://ui.example.test/path'] })
    await expect(fiber).rejects.toThrow(/not an exact http\(s\) origin/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('registers API and browser-authentication routes plus one upgrade route per downlink', async () => {
    const { routes, upgrades, dispose } = await mounted()
    expect(routes).toHaveLength(12)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(upgrades.map(route => route.path)).toEqual([MUX_EVENTS_PATH, HOST_EVENTS_PATH])
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('requires WebSocket upgrade for network GETs to either event path', async () => {
    const { routes, dispose } = await mounted()
    for (const path of [MUX_EVENTS_PATH, HOST_EVENTS_PATH]) {
      const { response, state } = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, path), response)
      expect(state.status).toBe(426)
      expect(state.body).toBe('upgrade required')
    }
    await dispose()
  })

  it('rejects an untrusted WebSocket upgrade before protocol negotiation', async () => {
    const { upgrades, dispose } = await mounted()
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('rejects event WebSockets when the authenticated principal cannot observe', async () => {
    const { upgrades, dispose } = await mounted(undefined, { kind: 'accepted', principal: AUTHORIZE_PRINCIPAL })
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')

    await upgrades[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
    await ended

    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('parses browser cookies before invoking the authentication provider', async () => {
    const authenticate = vi.fn((_attempt: AuthenticationAttempt) =>
      Promise.resolve({ kind: 'accepted' as const, principal: TEST_PRINCIPAL }))
    const { routes, dispose } = await mounted(undefined, undefined, { authenticate })
    const route = routes.find(candidate => candidate.path === '/auth/status')!
    const response = fakeResponse()

    await route.handler(fakeRequest({
      host: '127.0.0.1:3080',
      cookie: 'other=x; dsh_auth=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }, '/auth/status'), response.response)

    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      browserSession: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }))
    expect(authenticate.mock.calls[0]?.[0]).not.toHaveProperty('cookie')
    await dispose()
  })

  it('accepts an explicitly configured cross-origin browser Origin after Host trust', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      trustedOrigins: ['https://ui.example.test'],
    })
    const route = routes.find(candidate => candidate.path === '/auth/status')!
    const response = fakeResponse()
    await route.handler(fakeRequest({
      host: 'harness.example:3080',
      origin: 'https://ui.example.test',
      'sec-fetch-site': 'cross-site',
    }, '/auth/status'), response.response)
    expect(response.state.status).toBe(200)
    expect(response.state.body).toContain('authenticated')
    await dispose()
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { ctx, routes, dispose } = await mounted()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    expect(warnings).toContain('client-connection: rejected untrusted /api request path="/api/session.list" host="harness.example" origin="http://harness.example" fetchSite="same-origin" peer="127.0.0.1"')
    await dispose()
  })

  it('logs an untrusted browser-auth request before returning forbidden', async () => {
    const { ctx, routes, dispose } = await mounted()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const route = routes.find(candidate => candidate.path === '/auth/enrollment')!
    const response = fakeResponse()

    await route.handler(fakeRequest({
      host: 'tailnet.example', origin: 'https://tailnet.example', 'sec-fetch-site': 'same-origin',
    }, '/auth/enrollment'), response.response)

    expect(response.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(warnings).toContain('client-connection: rejected untrusted browser request path="/auth/enrollment" host="tailnet.example" origin="https://tailnet.example" fetchSite="same-origin" peer="127.0.0.1"')
    await dispose()
  })

  it('logs the enrolling device and request markers without logging its public key', async () => {
    const infos: string[] = []
    const { ctx, routes, dispose } = await mounted({ trustedHosts: ['100.64.0.2'] }, undefined, {
      requestEnrollment: () => Promise.resolve({
        kind: 'accepted' as const,
        value: {
          state: 'pending' as const,
          id: authenticationEnrollmentId('enrollment-log-test'),
          approvalCode: '12345678',
          name: 'Tailscale Browser',
          kind: 'device' as const,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    })
    ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
    const route = routes.find(candidate => candidate.path === '/auth/enrollment')!
    const response = fakeResponse()
    await route.handler(fakePost({
      host: '100.64.0.2:3080',
      origin: 'https://100.64.0.2:3080',
      'sec-fetch-site': 'same-origin',
    }, '/auth/enrollment', {
      name: 'Tailscale Browser',
      kind: 'device',
      publicKey: 'public-key-must-not-appear-in-logs',
    }), response.response)
    expect(response.state.status).toBe(202)
    expect(infos).toEqual([
      expect.stringContaining('enrollment requested name="Tailscale Browser" kind="device" host="100.64.0.2:3080"'),
      expect.stringContaining('enrollment pending name="Tailscale Browser" enrollment="enrollment-log-test"'),
    ])
    expect(infos.join('\n')).not.toContain('public-key-must-not-appear-in-logs')
    await dispose()
  })

  it('rejects an unauthenticated loopback API request', async () => {
    const { routes, dispose } = await mounted(undefined, { kind: 'rejected', reason: 'missing-credential' })
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }), response)
    expect(state.status).toBe(401)
    expect(state.body).toBe('unauthorized')
    await dispose()
  })

  it('returns Retry-After for rate-limited API requests and WebSocket upgrades', async () => {
    const decision = { kind: 'rejected', reason: 'rate-limited', retryAfterMs: 2_500 } as const
    const { routes, upgrades, dispose } = await mounted(undefined, decision)
    const api = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }), api.response)
    expect(api.state).toMatchObject({
      status: 429,
      body: 'rate limited',
      headers: { 'retry-after': '3' },
    })

    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 429 Too Many Requests')
    expect(Buffer.concat(chunks).toString()).toContain('Retry-After: 3')
    await dispose()
  })

  it('issues an HttpOnly strict browser cookie without exposing the proof', async () => {
    const { routes, dispose } = await mounted(undefined, { kind: 'accepted', principal: TEST_PRINCIPAL }, {
      createBrowserSession: () => Promise.resolve({
        kind: 'accepted',
        session: {
          value: 'browser-session-secret',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          principal: TEST_PRINCIPAL,
        },
      }),
    })
    const route = routes.find(candidate => candidate.path === '/auth/exchange')!
    const { response, state } = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/auth/exchange', { challengeId: 'challenge-id', signature: 'proof' }), response)

    expect(state.status).toBe(200)
    expect(state.headers?.['set-cookie']).toContain('dsh_auth=browser-session-secret; Path=/; HttpOnly; SameSite=Strict')
    expect(state.headers?.['cache-control']).toBe('no-store')
    expect(state.body).not.toContain('proof')
    await dispose()
  })

  it('issues a no-store __Host- Secure cookie over HTTPS', async () => {
    const { routes, dispose } = await mounted(undefined, { kind: 'accepted', principal: TEST_PRINCIPAL }, {
      createBrowserSession: () => Promise.resolve({
        kind: 'accepted',
        session: {
          value: 'browser-session-secret',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          principal: TEST_PRINCIPAL,
        },
      }),
    }, 'https:')
    const route = routes.find(candidate => candidate.path === '/auth/exchange')!
    const { response, state } = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/auth/exchange', { challengeId: 'challenge-id', signature: 'proof' }), response)

    expect(state.status).toBe(200)
    expect(state.headers?.['set-cookie'])
      .toContain('__Host-dsh_auth=browser-session-secret; Path=/; HttpOnly; SameSite=Strict; Secure')
    expect(state.headers?.['cache-control']).toBe('no-store')
    await dispose()
  })

  it('returns Retry-After when browser exchange is rate limited', async () => {
    const { routes, dispose } = await mounted(undefined, { kind: 'accepted', principal: TEST_PRINCIPAL }, {
      createBrowserSession: () => Promise.resolve({
        kind: 'rejected', reason: 'rate-limited', retryAfterMs: 2_500,
      }),
    })
    const route = routes.find(candidate => candidate.path === '/auth/exchange')!
    const { response, state } = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/auth/exchange', { challengeId: 'challenge-id', signature: 'invalid' }), response)

    expect(state.status).toBe(429)
    expect(state.headers?.['retry-after']).toBe('3')
    expect(state.headers?.['cache-control']).toBe('no-store')
    await dispose()
  })

  it('marks malformed browser exchange responses as no-store', async () => {
    const { routes, dispose } = await mounted()
    const route = routes.find(candidate => candidate.path === '/auth/exchange')!
    const { response, state } = fakeResponse()
    await route.handler(fakeRawPost({ host: '127.0.0.1:3080' }, '/auth/exchange', '{}'), response)

    expect(state.status).toBe(415)
    expect(state.headers?.['cache-control']).toBe('no-store')
    await dispose()
  })

  it('exposes enrollment, challenge, and access-token exchange before browser plugins load', async () => {
    const requestEnrollment = vi.fn(() => Promise.resolve({
      kind: 'accepted' as const,
      value: {
        state: 'pending' as const,
        id: authenticationEnrollmentId('request-id'),
        approvalCode: 'a1b2c3d4',
        name: 'tablet',
        kind: 'device' as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }))
    const createChallenge = vi.fn(() => Promise.resolve({
      kind: 'accepted' as const,
      value: { id: authenticationChallengeId('challenge-id'), payload: '{}', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    }))
    const exchangeAccessToken = vi.fn(() => Promise.resolve({
      kind: 'accepted' as const,
      value: {
        value: 'short-access-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        principal: GRANT_PRINCIPAL,
      },
    }))
    const { routes, dispose } = await mounted(undefined, undefined, {
      requestEnrollment,
      createChallenge,
      exchangeAccessToken,
    })

    const enrollment = fakeResponse()
    await routes.find(route => route.path === '/auth/enrollment')!.handler(fakePost(
      { host: '127.0.0.1:3080' }, '/auth/enrollment', { name: 'tablet', kind: 'device', publicKey: 'spki' },
    ), enrollment.response)
    expect(enrollment.state.status).toBe(202)
    expect(requestEnrollment).toHaveBeenCalledWith(
      { name: 'tablet', kind: 'device', publicKey: 'spki' },
      '127.0.0.1',
    )

    const challenge = fakeResponse()
    await routes.find(route => route.path === '/auth/challenge')!.handler(fakePost(
      { host: '127.0.0.1:3080' }, '/auth/challenge', { grantId: 'grant-id', purpose: 'access-token' },
    ), challenge.response)
    expect(challenge.state.status).toBe(200)

    const token = fakeResponse()
    await routes.find(route => route.path === '/auth/token')!.handler(fakePost(
      { host: '127.0.0.1:3080' }, '/auth/token', { challengeId: 'challenge-id', signature: 'proof' },
    ), token.response)
    const tokenBody = JSON.parse(String(token.state.body)) as { accessToken: string; expiresAt: unknown }
    expect(tokenBody.accessToken).toBe('short-access-token')
    expect(typeof tokenBody.expiresAt).toBe('string')
    await dispose()
  })

  it('returns Retry-After when the enrollment Provider limits a peer', async () => {
    const requestEnrollment = vi.fn(() => Promise.resolve({
      kind: 'rejected' as const,
      reason: 'rate-limited' as const,
      retryAfterMs: 2_500,
    }))
    const { routes, dispose } = await mounted(undefined, undefined, { requestEnrollment })
    const result = fakeResponse()
    await routes.find(route => route.path === '/auth/enrollment')!.handler(fakePost(
      { host: '127.0.0.1:3080' },
      '/auth/enrollment',
      { name: 'tablet', kind: 'device', publicKey: 'spki' },
    ), result.response)

    expect(result.state).toMatchObject({ status: 429, body: 'rate limited' })
    expect(result.state.headers?.['retry-after']).toBe('3')
    expect(result.state.headers?.['cache-control']).toBe('no-store')
    await dispose()
  })

  it('returns actionable enrollment rejections and logs unexpected Provider failures', async () => {
    const conflict = await mounted(undefined, undefined, {
      requestEnrollment: () => Promise.resolve({ kind: 'rejected', reason: 'name-conflict' }),
    })
    const conflictResult = fakeResponse()
    await conflict.routes.find(route => route.path === '/auth/enrollment')!.handler(fakePost(
      { host: '127.0.0.1:3080' }, '/auth/enrollment', { name: 'tablet', kind: 'device', publicKey: 'spki' },
    ), conflictResult.response)
    expect(conflictResult.state).toMatchObject({
      status: 409,
      body: 'device name is already registered or awaiting approval; choose another name',
    })
    await conflict.dispose()

    const failure = new Error('registry write failed')
    const broken = await mounted(undefined, undefined, {
      requestEnrollment: () => Promise.reject(failure),
    })
    const warn = vi.spyOn(broken.ctx.logger, 'warn').mockImplementation(() => broken.ctx.logger)
    const failureResult = fakeResponse()
    await broken.routes.find(route => route.path === '/auth/enrollment')!.handler(fakePost(
      { host: '127.0.0.1:3080' }, '/auth/enrollment', { name: 'tablet', kind: 'device', publicKey: 'spki' },
    ), failureResult.response)
    expect(failureResult.state).toMatchObject({ status: 500, body: 'enrollment service failed; see server log' })
    expect(warn).toHaveBeenNthCalledWith(1, 'client-connection: enrollment request failed')
    expect(warn).toHaveBeenNthCalledWith(2, failure)
    await broken.dispose()
  })

  it('requires authorize capability before Grant management handlers run', async () => {
    const listPendingEnrollments = vi.fn(() => Promise.resolve([]))
    const observer = await mounted(undefined, { kind: 'accepted', principal: OBSERVER_PRINCIPAL }, { listPendingEnrollments })
    const denied = fakeResponse()
    await observer.routes.find(route => route.path === '/auth/manage/enrollments')!.handler(
      fakeRequest({ host: '127.0.0.1:3080' }, '/auth/manage/enrollments'), denied.response,
    )
    expect(denied.state.status).toBe(403)
    expect(listPendingEnrollments).not.toHaveBeenCalled()
    await observer.dispose()

    const owner = await mounted(undefined, { kind: 'accepted', principal: TEST_PRINCIPAL }, { listPendingEnrollments })
    const allowed = fakeResponse()
    await owner.routes.find(route => route.path === '/auth/manage/enrollments')!.handler(
      fakeRequest({ host: '127.0.0.1:3080' }, '/auth/manage/enrollments'), allowed.response,
    )
    expect(allowed.state.status).toBe(200)
    expect(listPendingEnrollments).toHaveBeenCalledOnce()
    await owner.dispose()
  })

  it('refuses authentication bypass on a non-loopback listener', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, upgrades, '0.0.0.0', 'https:') as WebServer)
    provideAuthentication(ctx)
    Object.defineProperty(ctx.authentication, 'mode', { value: 'bypass' })

    expect(() => { apply(ctx) }).toThrow(/bypass.*loopback/i)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('denies administrative methods to an observer on a declared trusted authority', async () => {
    const { routes, dispose } = await mounted(
      { trustedHosts: ['harness.example'] },
      { kind: 'accepted', principal: OBSERVER_PRINCIPAL },
    )
    // The privileged set: native dialogs plus the whole settings/credential
    // configuration plane, reads included, plus the one method that makes the
    // host fetch a caller-chosen URL. The same declared authority reaches
    // ordinary reads (carrier-level 404 from the empty proxy proves the fence
    // passed), but each privileged method stays loopback-only and 403s.
    for (const method of [
      'host.pickDirectory', 'host.listDirectory', 'host.createDirectory', 'host.openPath',
      'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
      'credentials.describe', 'credentials.set', 'credentials.unset',
      'llm.discoverModels',
      // A composition names the plugins a session runs: reading one is
      // reconnaissance, and copy/remove/openDocument manage the roster and
      // drive the host desktop.
      'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
    ]) {
      const denied = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ host: 'harness.example' }, `${API_PATH}/${method}`),
        denied.response,
      )
      expect(denied.state.status).toBe(403)
      expect(denied.state.body).toBe('forbidden')
    }
    const read = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: 'harness.example' }), read.response)
    expect(read.state.status).not.toBe(403)
    await dispose()
  })

  it('passes loopback and declared-authority requests through to the bridge', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }), loopback.response)
    expect(loopback.state.status).toBe(404)
    // An all-interfaces composition derives port-less LAN IP literals, which
    // pass markerless curl on any port.
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '192.168.1.5:3080' }), lan.response)
    expect(lan.state.status).toBe(404)
    // Declared public authority, same-origin browser shape.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080', origin: 'http://harness.example:3080', 'sec-fetch-site': 'same-origin',
    }), declared.response)
    expect(declared.state.status).toBe(404)
    await dispose()
  })

  it('provides a disposable dedicated RPC channel without requiring apiProxy', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    provideAuthentication(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(12)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/rpc', async (invocation) => {
      calls.push(invocation)
      return { ok: true, value: { accepted: true } }
    }, { authority: 'trusted-host', requiredCapability: 'harniverse.observe' })
    const route = routes.find(candidate => candidate.path === '/rpc')
    expect(route).toBeDefined()

    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-dedicated'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = fakeResponse()
    await route!.handler(fakePost({ host: '127.0.0.1:3080' }, '/rpc/goals/create', request), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toHaveLength(1)
    const dedicatedInvocation = calls[0] as ConnectionRpcInvocation
    expect(dedicatedInvocation).toMatchObject({
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
      principal: TEST_PRINCIPAL,
    })
    expect(dedicatedInvocation.signal).toBeInstanceOf(AbortSignal)

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })).toThrow(/duplicate route/)
    await remove()
    expect(routes.map(candidate => candidate.path)).toEqual([
      API_PATH,
      '/auth/status',
      '/auth/enrollment',
      '/auth/challenge',
      '/auth/exchange',
      '/auth/token',
      '/auth/manage/enrollments',
      '/auth/manage/enrollment/approve',
      '/auth/manage/grants',
      '/auth/manage/grant/revoke',
      '/auth/manage/token',
      '/auth/logout',
    ])
    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })

  it('dispatches claimed /api endpoints before the API Proxy fallback and withdraws the claim', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    provideAuthentication(ctx)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create' ? { requiredCapability: 'harniverse.operate' } : undefined,
      async (invocation) => {
        calls.push(invocation)
        return { ok: true, value: { accepted: true } }
      },
      { authority: 'trusted-host', requiredCapability: 'harniverse.operate' },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => ({ requiredCapability: 'harniverse.observe' }),
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host', requiredCapability: 'harniverse.observe' },
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => ({ requiredCapability: 'harniverse.observe' }),
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host', requiredCapability: 'harniverse.observe' },
    )).toThrow('invalid shared RPC channel')
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-shared'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), claimed.response)
    expect(JSON.parse(String(claimed.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toHaveLength(1)
    const sharedInvocation = calls[0] as ConnectionRpcInvocation
    expect(sharedInvocation).toMatchObject({
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
      principal: TEST_PRINCIPAL,
    })
    expect(sharedInvocation.signal).toBeInstanceOf(AbortSignal)

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/api/goals/create', request), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toHaveLength(1)

    const unclaimed = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:3080' }, '/api/session.list'), unclaimed.response)
    expect(unclaimed.state.status).toBe(404)

    await remove()
    const deniedFallback = vi.fn(async () => ({ ok: true as const, value: null }))
    const denyClaim = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'session.list' ? { denied: true } : undefined,
      deniedFallback,
      { authority: 'trusted-host', requiredCapability: 'harniverse.observe' },
    )
    const explicitlyDenied = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:3080' }, '/api/session.list'), explicitlyDenied.response)
    expect(explicitlyDenied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(deniedFallback).not.toHaveBeenCalled()
    await denyClaim()

    const withdrawn = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), withdrawn.response)
    expect(withdrawn.state.status).toBe(403)
    expect(calls).toHaveLength(1)

    const removeLoopback = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create' ? { requiredCapability: 'harniverse.operate' } : undefined,
      async () => ({ ok: true, value: null }),
      { authority: 'loopback', requiredCapability: 'harniverse.operate' },
    )
    const loopbackOnly = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/api/goals/create', request), loopbackOnly.response)
    expect(loopbackOnly.state.status).toBe(403)
    await removeLoopback()
    await fiber.dispose()
  })

  it('denies a claimed Typert endpoint before its handler when the principal lacks its capability', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    provideAuthentication(ctx, { kind: 'accepted', principal: OBSERVER_PRINCIPAL })
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const handler = vi.fn(async () => ({ ok: true as const, value: null }))
    const connection = ctx.get('connection') as HostConnectionHandle
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create' ? { requiredCapability: 'harniverse.operate' } : undefined,
      handler,
      { authority: 'trusted-host', requiredCapability: 'harniverse.operate' },
    )
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-denied'),
      method: 'goals/create',
      payload: { args: {} },
    }
    const denied = fakeResponse()

    await routes[0]!.handler(
      fakePost({ host: 'harness.example' }, '/api/goals/create', request),
      denied.response,
    )

    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(handler).not.toHaveBeenCalled()
    await remove()
    await fiber.dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    provideAuthentication(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const remove = connection.rpc.handle('/rpc', async ({ endpoint }) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true, value: null }
    }, {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })
    const route = routes.find(candidate => candidate.path === '/rpc')!

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/rpc/goals/create', {}), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const methodMismatch = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }), methodMismatch.response)
    expect(JSON.parse(String(methodMismatch.state.body))).toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'bad-request' } },
    })

    for (const [request, status] of [
      [fakeRequest({ host: 'harness.example' }, '/rpc/goals/create'), 404],
      [fakePost({ host: 'harness.example' }, '/outside/goals/create', {}), 403],
      [fakePost({ host: 'harness.example' }, '/rpc/goals//create', {}), 403],
      [fakeRawPost({ host: 'harness.example' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ host: 'harness.example', 'content-type': 'text/plain' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ host: 'harness.example', 'content-type': 'application/json; charset=utf-8' }, '/rpc/goals/create', '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = fakeResponse()
      await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', body), response.response)
      expect(JSON.parse(String(response.state.body))).toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'bad-request' } },
      })
    }

    const failed = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }), failed.response)
    expect(failed.state).toMatchObject({ status: 500, body: 'internal handler failure' })
    expect(failed.state.body).not.toContain('handler broke')

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
      requiredCapability: 'harniverse.observe',
    })).toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
      requiredCapability: 'harniverse.observe',
    })).toThrow('invalid or reserved RPC channel')

    const removeLoopback = connection.rpc.handle('/loopback', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
      requiredCapability: 'harniverse.observe',
    })
    const loopbackRoute = routes.find(candidate => candidate.path === '/loopback')!
    const publicResponse = fakeResponse()
    await loopbackRoute.handler(fakePost({ host: 'harness.example' }, '/loopback/read', {
      type: 'client-request', rpcId: 'rpc-public', method: 'read', payload: {},
    }), publicResponse.response)
    expect(publicResponse.state.status).toBe(403)
    await removeLoopback()
    await remove()
    await fiber.dispose()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve the registered prefix route from a real server and return its port. */
  async function serve(routes: WebRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void routes[0]!.handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: `${API_PATH}/${method}`, method: 'GET', headers: { host } },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('enforces principal capabilities independently of LAN or loopback authority over real HTTP', async () => {
    // The fence's input is a real IncomingMessage parsed by Node from the
    // wire, not a hand-assembled object: the Host header a LAN browser sends
    // is exactly what decides loopback-only here, so the boundary is asserted
    // against the parse the server actually performs.
    const { routes, dispose } = await mounted(
      { trustedHosts: ['harness.example'] },
      { kind: 'accepted', principal: OBSERVER_PRINCIPAL },
    )
    const { port, close } = await serve(routes)
    try {
      // Reads are as privileged as writes: describe returns the exposed
      // configuration, and credentials.describe probes arbitrary env-var names.
      for (const method of [
        'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
        'credentials.describe', 'credentials.set', 'credentials.unset',
        'host.pickDirectory', 'host.listDirectory', 'host.createDirectory', 'host.openPath',
        // Carries a draft credential and turns the host into a fetcher for a
        // URL the caller picked: an admission-only remote credential must not reach it.
        'llm.discoverModels',
        'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
      ]) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 403])
      }
      // The model catalog stays reachable for the same authority: a LAN
      // client's model picker needs it, and it carries no key or endpoint
      // state (404 is the empty proxy's carrier answer — the fence passed).
      // `agentPreset.list` joins the model catalog for the same reason: ids and
      // trust only, and a remote preset picker needs it.
      for (const method of ['llm.providers', 'llm.models', 'agentPreset.list']) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 404])
      }
      // Network location does not add a capability absent from the principal.
      expect(await call(port, 'settings.describe', `127.0.0.1:${String(port)}`)).toBe(403)
    } finally {
      await close()
      await dispose()
    }
  })
})
