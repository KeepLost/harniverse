/**
 * Browser authentication routes: the login, enrollment, challenge, exchange,
 * management, and logout surface mounted before the client plugin graph starts.
 * Every case drives the registered route through the real trust fence and the
 * Node-to-Fetch bridge, so status codes, cookies, and logged facts are the
 * assertions rather than handler internals.
 */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  authenticationEnrollmentId,
  authenticationGrantId,
  type AuthenticationAttempt,
  type AuthenticationDecision,
  type AuthenticationPrincipal,
  type InboundAuthentication,
} from '@deepseek-ai/dsh-authentication'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, inject } from '../src/index.ts'

const OWNER: Extract<AuthenticationPrincipal, { kind: 'grant' }> = {
  kind: 'grant',
  grantId: authenticationGrantId('owner-grant'),
  grantRevision: 1,
  capabilities: ALL_AUTHENTICATION_CAPABILITIES,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const OBSERVER: Extract<AuthenticationPrincipal, { kind: 'grant' }> = {
  ...OWNER,
  capabilities: ['harniverse.observe'],
}

const BYPASS: AuthenticationPrincipal = { kind: 'bypass', capabilities: ALL_AUTHENTICATION_CAPABILITIES }

const SESSION_VALUE = 'S'.repeat(43)

function fakeWebServer(
  routes: WebRoute[],
  protocol: 'http:' | 'https:',
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port' | 'host' | 'protocol'> {
  return {
    register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    registerUpgrade(route: WebUpgradeRoute) { return () => void route },
    tapIndex: () => () => {},
    port: 0,
    host: '127.0.0.1',
    protocol,
  }
}

function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: string; headers?: Record<string, string> } } {
  const state: { status?: number; body?: string; headers?: Record<string, string> } = {}
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
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

/** A trusted loopback request with an explicit method, body, and headers. */
function request(options: {
  method: string
  path: string
  body?: string
  headers?: Record<string, string>
  /** Model a socket with no resolvable peer, as a closed connection reports. */
  peerless?: boolean
}): IncomingMessage {
  const message = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]) as unknown as IncomingMessage
  Object.assign(message, {
    url: options.path,
    method: options.method,
    headers: { host: '127.0.0.1:3080', ...options.headers },
    socket: options.peerless === true ? {} : { remoteAddress: '127.0.0.1' },
  })
  return message
}

const jsonRequest = (method: string, path: string, body: unknown, headers: Record<string, string> = {}): IncomingMessage =>
  request({ method, path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })

interface Harness {
  ctx: Context
  call: (message: IncomingMessage) => Promise<{ status?: number; body?: string; headers?: Record<string, string> }>
  warnings: string[]
  infos: string[]
  dispose: () => Promise<void>
}

async function mounted(options: {
  decision?: AuthenticationDecision
  overrides?: Partial<InboundAuthentication>
  protocol?: 'http:' | 'https:'
} = {}): Promise<Harness> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', fakeWebServer(routes, options.protocol ?? 'http:') as WebServer)
  ctx.provide('authentication', {
    mode: 'authenticated',
    authenticate: () => Promise.resolve(options.decision ?? { kind: 'accepted', principal: OWNER }),
    status: () => Promise.resolve({ mode: 'authenticated', sealed: false }),
    createBrowserSession: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-grant' }),
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
    ...options.overrides,
  } as unknown as InboundAuthentication)
  ctx.provide('apiProxy', {} as unknown as ApiProxy)
  const warnings: string[] = []
  const infos: string[] = []
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  return {
    ctx,
    warnings,
    infos,
    async call(message) {
      const path = String(message.url).split('?', 1)[0] ?? ''
      const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === path)
      if (route === undefined) throw new Error(`no route registered for ${path}`)
      const { response, state } = fakeResponse()
      await route.handler(message, response)
      return state
    },
    dispose: () => fiber.dispose(),
  }
}

describe('browser authentication status', () => {
  it('reports an authenticated deployment without consulting a credential in bypass mode', async () => {
    const authenticate = vi.fn(() => Promise.resolve({ kind: 'accepted' as const, principal: BYPASS }))
    const harness = await mounted({
      overrides: {
        status: () => Promise.resolve({ mode: 'bypass', sealed: false }),
        authenticate,
      },
    })

    const state = await harness.call(request({ method: 'GET', path: '/auth/status' }))
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body ?? '{}')).toEqual({ mode: 'bypass', sealed: false, authenticated: true })
    // Bypass mode is the deployment's answer; no credential is evaluated.
    expect(authenticate).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('reports an unauthenticated browser without a usable credential', async () => {
    const harness = await mounted({ decision: { kind: 'rejected', reason: 'missing-credential' } })

    const state = await harness.call(request({ method: 'GET', path: '/auth/status' }))
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body ?? '{}')).toMatchObject({ authenticated: false, mode: 'authenticated' })
    await harness.dispose()
  })

  it('never lets a browser cache an authentication answer', async () => {
    const harness = await mounted()
    const state = await harness.call(request({ method: 'GET', path: '/auth/status' }))
    expect(state.headers?.['cache-control']).toBe('no-store')
    await harness.dispose()
  })

  it('rejects an unsupported method on a known path', async () => {
    const harness = await mounted()
    const state = await harness.call(request({ method: 'DELETE', path: '/auth/status' }))
    expect(state).toMatchObject({ status: 404, body: 'not found' })
    await harness.dispose()
  })
})

describe('browser enrollment', () => {
  it('requires a JSON content type', async () => {
    const harness = await mounted()
    const state = await harness.call(request({
      method: 'POST',
      path: '/auth/enrollment',
      body: 'name=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }))
    expect(state).toMatchObject({ status: 415, body: 'content type must be application/json' })
    await harness.dispose()
  })

  it('rejects a body that is not JSON', async () => {
    const harness = await mounted()
    const state = await harness.call(request({
      method: 'POST',
      path: '/auth/enrollment',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    }))
    expect(state).toMatchObject({ status: 400, body: 'body is not JSON' })
    await harness.dispose()
  })

  it('accepts a JSON content type carrying parameters', async () => {
    const harness = await mounted({
      overrides: {
        requestEnrollment: () => Promise.resolve({
          kind: 'accepted' as const,
          value: {
            state: 'pending' as const,
            id: authenticationEnrollmentId('enrollment-1'),
            approvalCode: '12345678',
            name: 'Browser',
            kind: 'device' as const,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      },
    })
    const state = await harness.call(request({
      method: 'POST',
      path: '/auth/enrollment',
      body: JSON.stringify({ name: 'Browser', kind: 'device', publicKey: 'key' }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }))
    expect(state.status).toBe(202)
    await harness.dispose()
  })

  it.each([
    ['a non-object body', []],
    ['a missing field', { name: 'Browser', kind: 'device' }],
    ['an extra field', { name: 'Browser', kind: 'device', publicKey: 'key', extra: 1 }],
    ['a non-string name', { name: 1, kind: 'device', publicKey: 'key' }],
    ['an unknown kind', { name: 'Browser', kind: 'other', publicKey: 'key' }],
    ['a non-string public key', { name: 'Browser', kind: 'device', publicKey: 1 }],
  ])('rejects %s', async (_label, body) => {
    const harness = await mounted()
    const state = await harness.call(jsonRequest('POST', '/auth/enrollment', body))
    expect(state).toMatchObject({ status: 400, body: 'invalid enrollment request' })
    await harness.dispose()
  })

  it.each([
    ['rate-limited', 429, 'rate limited'],
    ['authentication-unavailable', 503, 'authentication unavailable'],
    ['invalid-name', 400, 'device name must contain 1-64 letters, numbers, spaces, dots, underscores, or hyphens'],
    ['invalid-public-key', 400, 'browser generated an invalid device key; use a current browser and retry'],
    ['name-conflict', 409, 'device name is already registered or awaiting approval; choose another name'],
  ])('maps the %s rejection to %i', async (reason, status, body) => {
    const harness = await mounted({
      overrides: {
        requestEnrollment: () => Promise.resolve({ kind: 'rejected' as const, reason, retryAfterMs: 2_500 }),
      } as Partial<InboundAuthentication>,
    })

    const state = await harness.call(jsonRequest('POST', '/auth/enrollment', {
      name: 'Browser', kind: 'device', publicKey: 'key',
    }))
    expect(state).toMatchObject({ status, body })
    if (reason === 'rate-limited') expect(state.headers?.['retry-after']).toBe('3')
    expect(harness.warnings.join('\n')).toContain(`reason=${JSON.stringify(reason)}`)
    await harness.dispose()
  })

  it('reports a failing enrollment service without leaking its error to the browser', async () => {
    const harness = await mounted({
      overrides: {
        requestEnrollment: () => Promise.reject(new Error('registry unavailable')),
      },
    })

    const state = await harness.call(jsonRequest('POST', '/auth/enrollment', {
      name: 'Browser', kind: 'device', publicKey: 'key',
    }))
    expect(state).toMatchObject({ status: 500, body: 'enrollment service failed; see server log' })
    expect(state.body).not.toContain('registry unavailable')
    expect(harness.warnings.join('\n')).toContain('enrollment request failed')
    await harness.dispose()
  })

  it.each([
    ['no id', '/auth/enrollment'],
    ['two ids', '/auth/enrollment?id=a&id=b'],
    ['an empty id', '/auth/enrollment?id='],
  ])('rejects an enrollment status read with %s', async (_label, path) => {
    const harness = await mounted()
    const state = await harness.call(request({ method: 'GET', path }))
    expect(state).toMatchObject({ status: 400, body: 'invalid enrollment id' })
    await harness.dispose()
  })

  it('reports an unknown enrollment as not found', async () => {
    const harness = await mounted()
    const state = await harness.call(request({ method: 'GET', path: '/auth/enrollment?id=missing' }))
    expect(state).toMatchObject({ status: 404, body: 'not found' })
    await harness.dispose()
  })

  it('returns a known enrollment status', async () => {
    const harness = await mounted({
      overrides: {
        enrollmentStatus: () => Promise.resolve({ state: 'approved' as const, id: authenticationEnrollmentId('e-1') }),
      } as unknown as Partial<InboundAuthentication>,
    })
    const state = await harness.call(request({ method: 'GET', path: '/auth/enrollment?id=e-1' }))
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body ?? '{}')).toMatchObject({ state: 'approved' })
    await harness.dispose()
  })
})

describe('browser challenge', () => {
  it.each([
    ['a non-object body', 'null'],
    ['a missing purpose', JSON.stringify({ grantId: 'g-1' })],
    ['an extra field', JSON.stringify({ grantId: 'g-1', purpose: 'access-token', extra: 1 })],
    ['a non-string grant', JSON.stringify({ grantId: 1, purpose: 'access-token' })],
    ['an unknown purpose', JSON.stringify({ grantId: 'g-1', purpose: 'other' })],
  ])('rejects %s', async (_label, body) => {
    const harness = await mounted()
    const state = await harness.call(request({
      method: 'POST',
      path: '/auth/challenge',
      body,
      headers: { 'content-type': 'application/json' },
    }))
    expect(state).toMatchObject({ status: 400, body: 'invalid challenge request' })
    await harness.dispose()
  })

  it('issues a challenge for a usable grant', async () => {
    const harness = await mounted({
      overrides: {
        createChallenge: () => Promise.resolve({
          kind: 'accepted' as const,
          value: { challengeId: 'c-1', nonce: 'n-1', expiresAt: new Date().toISOString() },
        }),
      } as unknown as Partial<InboundAuthentication>,
    })

    const state = await harness.call(jsonRequest('POST', '/auth/challenge', { grantId: 'g-1', purpose: 'browser-session' }))
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body ?? '{}')).toMatchObject({ challengeId: 'c-1' })
    await harness.dispose()
  })

  it.each([
    ['invalid-grant', 401],
    ['invalid-proof', 401],
    ['expired', 401],
    ['authentication-unavailable', 503],
  ])('maps the %s challenge rejection to %i', async (reason, status) => {
    const harness = await mounted({
      overrides: {
        createChallenge: () => Promise.resolve({ kind: 'rejected' as const, reason }),
      } as Partial<InboundAuthentication>,
    })
    const state = await harness.call(jsonRequest('POST', '/auth/challenge', { grantId: 'g-1', purpose: 'access-token' }))
    expect(state).toMatchObject({ status, body: 'unauthorized' })
    await harness.dispose()
  })
})

describe('browser session exchange', () => {
  const proof = { challengeId: 'c-1', signature: 'sig' }

  it.each([
    ['a non-object proof', '[]'],
    ['a missing signature', JSON.stringify({ challengeId: 'c-1' })],
    ['an extra field', JSON.stringify({ challengeId: 'c-1', signature: 'sig', extra: 1 })],
    ['a non-string challenge id', JSON.stringify({ challengeId: 1, signature: 'sig' })],
  ])('rejects %s', async (_label, body) => {
    const harness = await mounted()
    const state = await harness.call(request({
      method: 'POST',
      path: '/auth/exchange',
      body,
      headers: { 'content-type': 'application/json' },
    }))
    expect(state).toMatchObject({ status: 400, body: 'invalid challenge proof' })
    await harness.dispose()
  })

  it('sets a host-locked secure cookie over HTTPS', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    const harness = await mounted({
      protocol: 'https:',
      overrides: {
        createBrowserSession: () => Promise.resolve({
          kind: 'accepted' as const,
          session: { value: SESSION_VALUE, expiresAt, principal: OWNER },
        }),
      },
    })

    const state = await harness.call(jsonRequest('POST', '/auth/exchange', proof))
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body ?? '{}')).toEqual({ authenticated: true, expiresAt })
    const cookie = state.headers?.['set-cookie'] ?? ''
    expect(cookie).toContain(`__Host-dsh_auth=${SESSION_VALUE}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Secure')
    expect(harness.infos.join('\n')).toContain('browser authentication accepted')
    // A device grant is identified by name and grant, never by its secret.
    expect(harness.infos.join('\n')).not.toContain(SESSION_VALUE)
    await harness.dispose()
  })

  it('uses the insecure cookie name and reports a bypass principal over HTTP', async () => {
    const harness = await mounted({
      overrides: {
        createBrowserSession: () => Promise.resolve({
          kind: 'accepted' as const,
          session: { value: SESSION_VALUE, expiresAt: new Date(Date.now() + 1_000).toISOString(), principal: BYPASS },
        }),
      },
    })

    const state = await harness.call(jsonRequest('POST', '/auth/exchange', proof))
    const cookie = state.headers?.['set-cookie'] ?? ''
    expect(cookie).toContain(`dsh_auth=${SESSION_VALUE}`)
    expect(cookie).not.toContain('Secure')
    expect(harness.infos.join('\n')).toContain('principal=bypass')
    await harness.dispose()
  })

  it('floors an already-expired session to a zero cookie lifetime', async () => {
    const harness = await mounted({
      overrides: {
        createBrowserSession: () => Promise.resolve({
          kind: 'accepted' as const,
          session: { value: SESSION_VALUE, expiresAt: new Date(Date.now() - 60_000).toISOString(), principal: OWNER },
        }),
      },
    })

    const state = await harness.call(jsonRequest('POST', '/auth/exchange', proof))
    expect(state.headers?.['set-cookie']).toContain('Max-Age=0')
    await harness.dispose()
  })

  it.each([
    ['invalid-grant', 401, 'unauthorized'],
    ['invalid-proof', 401, 'unauthorized'],
    ['expired', 401, 'unauthorized'],
    ['authentication-unavailable', 503, 'unauthorized'],
    ['rate-limited', 429, 'rate limited'],
  ])('maps the %s exchange rejection to %i', async (reason, status, body) => {
    const harness = await mounted({
      overrides: {
        createBrowserSession: () => Promise.resolve({ kind: 'rejected' as const, reason, retryAfterMs: 1_200 }),
      } as Partial<InboundAuthentication>,
    })

    const state = await harness.call(jsonRequest('POST', '/auth/exchange', proof))
    expect(state).toMatchObject({ status, body })
    if (reason === 'rate-limited') expect(state.headers?.['retry-after']).toBe('2')
    expect(harness.warnings.join('\n')).toContain('browser authentication rejected')
    await harness.dispose()
  })

  it('issues an access token for a proven challenge', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const harness = await mounted({
      overrides: {
        exchangeAccessToken: () => Promise.resolve({
          kind: 'accepted' as const,
          value: { value: 'token-value', expiresAt },
        }),
      } as unknown as Partial<InboundAuthentication>,
    })

    const state = await harness.call(jsonRequest('POST', '/auth/token', proof))
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body ?? '{}')).toEqual({ accessToken: 'token-value', expiresAt })
    await harness.dispose()
  })

  it('maps a rejected access-token exchange to its status', async () => {
    const harness = await mounted({
      overrides: {
        exchangeAccessToken: () => Promise.resolve({ kind: 'rejected' as const, reason: 'expired' }),
      },
    })
    const state = await harness.call(jsonRequest('POST', '/auth/token', proof))
    expect(state).toMatchObject({ status: 401, body: 'unauthorized' })
    await harness.dispose()
  })
})

describe('authorized management', () => {
  const managePaths = [
    ['GET', '/auth/manage/enrollments'],
    ['GET', '/auth/manage/grants'],
    ['POST', '/auth/manage/enrollment/approve'],
    ['POST', '/auth/manage/grant/revoke'],
    ['POST', '/auth/manage/token'],
  ] as const

  it.each(managePaths)('refuses %s %s without the authorize capability', async (method, path) => {
    const harness = await mounted({ decision: { kind: 'accepted', principal: OBSERVER } })
    const state = await harness.call(method === 'GET'
      ? request({ method, path })
      : jsonRequest(method, path, {}))
    expect(state).toMatchObject({ status: 403, body: 'forbidden' })
    await harness.dispose()
  })

  it.each(managePaths)('refuses %s %s for an unauthenticated caller', async (method, path) => {
    const harness = await mounted({ decision: { kind: 'rejected', reason: 'missing-credential' } })
    const state = await harness.call(method === 'GET'
      ? request({ method, path })
      : jsonRequest(method, path, {}))
    expect(state).toMatchObject({ status: 401, body: 'unauthorized' })
    await harness.dispose()
  })

  it('rate-limits management the same way as any other credential use', async () => {
    const harness = await mounted({
      decision: { kind: 'rejected', reason: 'rate-limited', retryAfterMs: 5_000 },
    })
    const state = await harness.call(request({ method: 'GET', path: '/auth/manage/grants' }))
    expect(state).toMatchObject({ status: 429, body: 'rate limited' })
    await harness.dispose()
  })

  it('reads the management credential from the browser cookie and Authorization header', async () => {
    const authenticate = vi.fn((_attempt: AuthenticationAttempt) => Promise.resolve({ kind: 'accepted' as const, principal: OWNER }))
    const harness = await mounted({ overrides: { authenticate } })

    await harness.call(request({
      method: 'GET',
      path: '/auth/manage/grants',
      headers: { cookie: `dsh_auth=${SESSION_VALUE}`, authorization: 'Bearer token-value' },
    }))

    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'http-api',
      browserSession: SESSION_VALUE,
      authorization: 'Bearer token-value',
      peerAddress: '127.0.0.1',
    }))
    await harness.dispose()
  })

  it('lists pending enrollments and grants for an authorized owner', async () => {
    const harness = await mounted({
      overrides: {
        listPendingEnrollments: () => Promise.resolve([{ id: authenticationEnrollmentId('e-1'), name: 'Browser' }]),
        listGrants: () => Promise.resolve([{ grantId: authenticationGrantId('g-1'), name: 'Browser' }]),
      } as unknown as Partial<InboundAuthentication>,
    })

    const enrollments = await harness.call(request({ method: 'GET', path: '/auth/manage/enrollments' }))
    expect(JSON.parse(enrollments.body ?? '[]')).toEqual([{ id: 'e-1', name: 'Browser' }])
    const grants = await harness.call(request({ method: 'GET', path: '/auth/manage/grants' }))
    expect(JSON.parse(grants.body ?? '[]')).toEqual([{ grantId: 'g-1', name: 'Browser' }])
    await harness.dispose()
  })

  describe('enrollment approval', () => {
    it('approves an enrollment with an explicit capability set and lifetimes', async () => {
      const approveEnrollment = vi.fn(() => Promise.resolve({
        grantId: authenticationGrantId('g-new'),
        capabilities: ['harniverse.observe'],
      }))
      const harness = await mounted({ overrides: { approveEnrollment } as unknown as Partial<InboundAuthentication> })

      const state = await harness.call(jsonRequest('POST', '/auth/manage/enrollment/approve', {
        id: 'e-1',
        capabilities: ['harniverse.observe'],
        expiresInMs: 60_000,
        idleTimeoutMs: 30_000,
      }))

      expect(state.status).toBe(200)
      expect(approveEnrollment).toHaveBeenCalledWith('e-1', {
        capabilities: ['harniverse.observe'],
        expiresInMs: 60_000,
        idleTimeoutMs: 30_000,
      })
      await harness.dispose()
    })

    it('omits absent lifetimes so the provider applies its own defaults', async () => {
      const approveEnrollment = vi.fn(() => Promise.resolve({ grantId: authenticationGrantId('g-new') }))
      const harness = await mounted({ overrides: { approveEnrollment } as unknown as Partial<InboundAuthentication> })

      await harness.call(jsonRequest('POST', '/auth/manage/enrollment/approve', {
        id: 'e-1',
        capabilities: [],
      }))

      expect(approveEnrollment).toHaveBeenCalledWith('e-1', { capabilities: [] })
      await harness.dispose()
    })

    it.each([
      ['a non-object body', 'null'],
      ['an unknown field', JSON.stringify({ id: 'e-1', capabilities: [], extra: 1 })],
      ['a non-string id', JSON.stringify({ id: 1, capabilities: [] })],
      ['non-array capabilities', JSON.stringify({ id: 'e-1', capabilities: 'all' })],
      ['an unknown capability', JSON.stringify({ id: 'e-1', capabilities: ['harniverse.everything'] })],
      ['a fractional lifetime', JSON.stringify({ id: 'e-1', capabilities: [], expiresInMs: 1.5 })],
      ['a non-positive lifetime', JSON.stringify({ id: 'e-1', capabilities: [], expiresInMs: 0 })],
      ['a fractional idle timeout', JSON.stringify({ id: 'e-1', capabilities: [], idleTimeoutMs: 1.5 })],
      ['a non-positive idle timeout', JSON.stringify({ id: 'e-1', capabilities: [], idleTimeoutMs: 0 })],
    ])('rejects %s', async (_label, body) => {
      const harness = await mounted()
      const state = await harness.call(request({
        method: 'POST',
        path: '/auth/manage/enrollment/approve',
        body,
        headers: { 'content-type': 'application/json' },
      }))
      expect(state).toMatchObject({ status: 400, body: 'invalid approval request' })
      await harness.dispose()
    })

    it('reports a refused approval as a request failure', async () => {
      const harness = await mounted({
        overrides: {
          approveEnrollment: () => Promise.reject(new Error('enrollment expired')),
        },
      })

      const state = await harness.call(jsonRequest('POST', '/auth/manage/enrollment/approve', {
        id: 'e-1', capabilities: [],
      }))
      expect(state).toMatchObject({ status: 400, body: 'approval failed' })
      await harness.dispose()
    })
  })

  describe('grant revocation', () => {
    it('revokes a grant by id', async () => {
      const revokeGrant = vi.fn(() => Promise.resolve())
      const harness = await mounted({ overrides: { revokeGrant } })

      const state = await harness.call(jsonRequest('POST', '/auth/manage/grant/revoke', { grantId: 'g-1' }))
      expect(state.status).toBe(200)
      expect(JSON.parse(state.body ?? '{}')).toEqual({ revoked: true })
      expect(revokeGrant).toHaveBeenCalledWith('g-1')
      await harness.dispose()
    })

    it.each([
      ['a non-object body', 'null'],
      ['an extra field', JSON.stringify({ grantId: 'g-1', extra: 1 })],
      ['a non-string grant id', JSON.stringify({ grantId: 1 })],
    ])('rejects %s', async (_label, body) => {
      const harness = await mounted()
      const state = await harness.call(request({
        method: 'POST',
        path: '/auth/manage/grant/revoke',
        body,
        headers: { 'content-type': 'application/json' },
      }))
      expect(state).toMatchObject({ status: 400, body: 'invalid revocation request' })
      await harness.dispose()
    })

    it('reports an unknown grant as not found', async () => {
      const harness = await mounted({
        overrides: {
          revokeGrant: () => Promise.reject(new Error('unknown grant')),
        },
      })
      const state = await harness.call(jsonRequest('POST', '/auth/manage/grant/revoke', { grantId: 'g-missing' }))
      expect(state).toMatchObject({ status: 404, body: 'revocation failed' })
      await harness.dispose()
    })
  })

  describe('emergency access token', () => {
    it('issues a token on behalf of the authorizing principal', async () => {
      const expiresAt = new Date(Date.now() + 60_000).toISOString()
      const issueEmergencyAccessToken = vi.fn(() => Promise.resolve({
        kind: 'accepted' as const,
        value: { value: 'emergency-token', expiresAt },
      }))
      const harness = await mounted({
        overrides: { issueEmergencyAccessToken } as unknown as Partial<InboundAuthentication>,
      })

      const state = await harness.call(jsonRequest('POST', '/auth/manage/token', {
        capabilities: ['harniverse.operate'],
        ttlMs: 60_000,
      }))

      expect(state.status).toBe(200)
      expect(JSON.parse(state.body ?? '{}')).toEqual({ accessToken: 'emergency-token', expiresAt })
      // The issuing authority is the authenticated manager, not the request body.
      expect(issueEmergencyAccessToken).toHaveBeenCalledWith(OWNER, ['harniverse.operate'], 60_000)
      await harness.dispose()
    })

    it.each([
      ['a non-object body', 'null'],
      ['an unknown field', JSON.stringify({ capabilities: [], ttlMs: 1, extra: 1 })],
    ])('rejects %s before reading its values', async (_label, body) => {
      const harness = await mounted()
      const state = await harness.call(request({
        method: 'POST',
        path: '/auth/manage/token',
        body,
        headers: { 'content-type': 'application/json' },
      }))
      expect(state).toMatchObject({ status: 400, body: 'invalid token request' })
      await harness.dispose()
    })

    it.each([
      ['non-array capabilities', { capabilities: 'all', ttlMs: 1_000 }],
      ['an unknown capability', { capabilities: ['harniverse.everything'], ttlMs: 1_000 }],
      ['a fractional ttl', { capabilities: [], ttlMs: 1.5 }],
      ['a non-positive ttl', { capabilities: [], ttlMs: 0 }],
      ['a missing ttl', { capabilities: [] }],
    ])('rejects %s', async (_label, body) => {
      const harness = await mounted()
      const state = await harness.call(jsonRequest('POST', '/auth/manage/token', body))
      expect(state).toMatchObject({ status: 400, body: 'invalid token request' })
      await harness.dispose()
    })

    it.each([
      ['invalid-grant', 401],
      ['authentication-unavailable', 503],
    ])('maps the %s issuance rejection to %i', async (reason, status) => {
      const harness = await mounted({
        overrides: {
          issueEmergencyAccessToken: () => Promise.resolve({ kind: 'rejected' as const, reason }),
        } as Partial<InboundAuthentication>,
      })
      const state = await harness.call(jsonRequest('POST', '/auth/manage/token', {
        capabilities: [], ttlMs: 1_000,
      }))
      expect(state).toMatchObject({ status, body: 'token issuance rejected' })
      await harness.dispose()
    })
  })
})

describe('body admission across every writing route', () => {
  const writingPaths = [
    '/auth/enrollment',
    '/auth/challenge',
    '/auth/exchange',
    '/auth/token',
    '/auth/manage/enrollment/approve',
    '/auth/manage/grant/revoke',
    '/auth/manage/token',
  ]

  it.each(writingPaths)('refuses a non-JSON content type on %s', async (path) => {
    const harness = await mounted()
    const state = await harness.call(request({
      method: 'POST',
      path,
      body: 'name=x',
      headers: { 'content-type': 'text/plain' },
    }))
    expect(state).toMatchObject({ status: 415, body: 'content type must be application/json' })
    await harness.dispose()
  })

  it.each(writingPaths)('refuses a malformed JSON body on %s', async (path) => {
    const harness = await mounted()
    const state = await harness.call(request({
      method: 'POST',
      path,
      body: '{',
      headers: { 'content-type': 'application/json' },
    }))
    expect(state).toMatchObject({ status: 400, body: 'body is not JSON' })
    await harness.dispose()
  })
})

describe('requests without a resolvable peer', () => {
  it('records an absent peer as a placeholder in enrollment logs', async () => {
    const harness = await mounted({
      overrides: {
        requestEnrollment: () => Promise.resolve({
          kind: 'accepted' as const,
          value: {
            state: 'pending' as const,
            id: authenticationEnrollmentId('e-peerless'),
            approvalCode: '12345678',
            name: 'Browser',
            kind: 'device' as const,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      },
    })

    const state = await harness.call(request({
      method: 'POST',
      path: '/auth/enrollment',
      body: JSON.stringify({ name: 'Browser', kind: 'device', publicKey: 'key' }),
      headers: { 'content-type': 'application/json' },
      peerless: true,
    }))

    expect(state.status).toBe(202)
    expect(harness.infos.join('\n')).toContain('peer="-"')
    await harness.dispose()
  })

  it('records an absent peer when an enrollment is rejected', async () => {
    const harness = await mounted({
      overrides: {
        requestEnrollment: () => Promise.resolve({ kind: 'rejected' as const, reason: 'name-conflict' }),
      },
    })

    await harness.call(request({
      method: 'POST',
      path: '/auth/enrollment',
      body: JSON.stringify({ name: 'Browser', kind: 'device', publicKey: 'key' }),
      headers: { 'content-type': 'application/json' },
      peerless: true,
    }))

    expect(harness.warnings.join('\n')).toContain('peer="-"')
    await harness.dispose()
  })

  it('omits the peer from the authentication attempt entirely', async () => {
    const authenticate = vi.fn((_attempt: AuthenticationAttempt) => Promise.resolve({ kind: 'accepted' as const, principal: OWNER }))
    const harness = await mounted({ overrides: { authenticate } })

    await harness.call(request({ method: 'GET', path: '/auth/manage/grants', peerless: true }))

    expect(authenticate.mock.calls[0]?.[0]).not.toHaveProperty('peerAddress')
    await harness.dispose()
  })

  it('records an absent peer when an untrusted request is refused', async () => {
    const harness = await mounted()

    const state = await harness.call(request({
      method: 'GET',
      path: '/auth/status',
      headers: { host: 'untrusted.example', origin: 'https://untrusted.example', 'sec-fetch-site': 'same-origin' },
      peerless: true,
    }))

    expect(state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(harness.warnings.join('\n')).toContain('peer="-"')
    await harness.dispose()
  })
})

describe('browser logout', () => {
  it('revokes the cookie session and clears the cookie', async () => {
    const revokeBrowserSession = vi.fn()
    const harness = await mounted({ overrides: { revokeBrowserSession } as unknown as Partial<InboundAuthentication> })

    const state = await harness.call(request({
      method: 'POST',
      path: '/auth/logout',
      headers: { cookie: `dsh_auth=${SESSION_VALUE}` },
    }))

    expect(state.status).toBe(204)
    expect(state.body).toBeUndefined()
    expect(revokeBrowserSession).toHaveBeenCalledWith(SESSION_VALUE)
    expect(state.headers?.['set-cookie']).toContain('dsh_auth=; Path=/')
    expect(state.headers?.['set-cookie']).toContain('Max-Age=0')
    await harness.dispose()
  })

  it('is idempotent without a cookie', async () => {
    const revokeBrowserSession = vi.fn()
    const harness = await mounted({ overrides: { revokeBrowserSession } as unknown as Partial<InboundAuthentication> })

    const state = await harness.call(request({ method: 'POST', path: '/auth/logout' }))
    expect(state.status).toBe(204)
    expect(revokeBrowserSession).toHaveBeenCalledWith(undefined)
    await harness.dispose()
  })
})
