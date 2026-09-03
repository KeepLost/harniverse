/**
 * Host RPC registry surface: the HTTP authorization gate other Client plugins
 * mount their routes behind, shared-channel interceptor dispatch, and the
 * per-principal idempotency ledger that makes a retried call replay instead of
 * running twice.
 */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  authenticationGrantId,
  type AuthenticationCapability,
  type AuthenticationDecision,
  type AuthenticationPrincipal,
  type InboundAuthentication,
} from '@deepseek-ai/dsh-authentication'
import { RpcId, RequestId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, apply, inject, type HostConnectionHandle } from '../src/index.ts'
import type { HostConnectionService } from '../src/rpc-host.ts'

const BYPASS_PRINCIPAL: AuthenticationPrincipal = {
  kind: 'bypass',
  capabilities: ALL_AUTHENTICATION_CAPABILITIES,
}

const OWNER_PRINCIPAL: AuthenticationPrincipal = {
  kind: 'grant',
  grantId: authenticationGrantId('owner-grant'),
  grantRevision: 1,
  capabilities: ALL_AUTHENTICATION_CAPABILITIES,
  name: 'workstation',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const OBSERVER_PRINCIPAL: AuthenticationPrincipal = {
  kind: 'grant',
  grantId: authenticationGrantId('observer-grant'),
  grantRevision: 1,
  capabilities: ['harniverse.observe'],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

/** A grant principal carrying no device name, so logs must render a placeholder. */
const ANONYMOUS_GRANT_PRINCIPAL: AuthenticationPrincipal = {
  kind: 'grant',
  grantId: authenticationGrantId('unnamed-grant'),
  grantRevision: 1,
  capabilities: ALL_AUTHENTICATION_CAPABILITIES,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[] = [],
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
    host: '127.0.0.1',
    protocol: 'http:',
  }
}

function provideAuthentication(
  ctx: Context,
  decision: AuthenticationDecision = { kind: 'accepted', principal: BYPASS_PRINCIPAL },
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
  } as unknown as InboundAuthentication)
}

interface RequestOptions {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: unknown
  /** Drop the socket peer address, as a closed or exotic socket does. */
  peerless?: boolean
}

function fakeRequest(options: RequestOptions = {}): IncomingMessage {
  const body = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]
  const request = Readable.from(body) as unknown as IncomingMessage
  Object.assign(request, {
    url: options.url ?? `${API_PATH}/session.list`,
    method: options.method ?? 'GET',
    headers: { host: '127.0.0.1:3080', ...options.headers },
    socket: options.peerless === true ? {} : { remoteAddress: '127.0.0.1' },
  })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(url: string, body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  return fakeRequest({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

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
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

interface Harness {
  ctx: Context
  routes: WebRoute[]
  connection: HostConnectionHandle
  service: HostConnectionService
  warnings: string[]
  infos: string[]
  dispose: () => Promise<void>
}

async function mounted(options: {
  trustedHosts?: string[]
  trustedOrigins?: string[]
  decision?: AuthenticationDecision
} = {}): Promise<Harness> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes) as WebServer)
  provideAuthentication(ctx, options.decision)
  ctx.provide('apiProxy', {} as unknown as ApiProxy)
  const fiber = ctx.plugin({ inject: [...inject], apply }, {
    ...options.trustedHosts === undefined ? {} : { trustedHosts: options.trustedHosts },
    ...options.trustedOrigins === undefined ? {} : { trustedOrigins: options.trustedOrigins },
  })
  await fiber.await()
  const warnings: string[] = []
  const infos: string[] = []
  ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  const service = ctx.get('connection') as HostConnectionService
  return {
    ctx,
    routes,
    connection: service,
    service,
    warnings,
    infos,
    dispose: () => fiber.dispose(),
  }
}

/** Drive one registered route by exact path. */
async function callRoute(
  routes: WebRoute[],
  path: string,
  request: IncomingMessage,
): Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }> {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route ${path} is not registered`)
  const recorder = fakeResponse()
  await route.handler(request, recorder.response)
  return recorder.state
}

const envelope = (method: string, payload: unknown, id = 'rpc-1'): ClientRequest => ({
  type: 'client-request',
  rpcId: RpcId(id),
  method,
  payload,
})

describe('authorizeHttpRequest', () => {
  /** The gate client/hmr and client/modules mount their asset routes behind. */
  async function authorize(harness: Harness, options: {
    capability?: AuthenticationCapability
    request?: IncomingMessage
  } = {}): Promise<{ allowed: boolean; state: ReturnType<typeof fakeResponse>['state'] }> {
    const recorder = fakeResponse()
    const allowed = await harness.service.authorizeHttpRequest(
      options.request ?? fakeRequest(),
      recorder.response,
      options.capability ?? 'harniverse.observe',
    )
    return { allowed, state: recorder.state }
  }

  it('admits a trusted authenticated request carrying the capability', async () => {
    const harness = await mounted()
    const { allowed, state } = await authorize(harness)

    expect(allowed).toBe(true)
    expect(state.status).toBeUndefined()
    expect(harness.infos.join('\n')).toContain('connection accepted channel=http-api')
    await harness.dispose()
  })

  it('refuses an untrusted authority before authenticating', async () => {
    const harness = await mounted({ trustedHosts: ['harness.example'] })
    const { allowed, state } = await authorize(harness, {
      request: fakeRequest({ headers: { host: 'evil.example:3080' } }),
    })

    expect(allowed).toBe(false)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    expect(harness.warnings.join('\n')).toContain('rejected untrusted RPC request')
    await harness.dispose()
  })

  it('refuses a rejected credential with the transport denial', async () => {
    const harness = await mounted({
      decision: { kind: 'rejected', reason: 'invalid-credential' },
    })
    const { allowed, state } = await authorize(harness)

    expect(allowed).toBe(false)
    expect(state.status).toBe(401)
    expect(harness.warnings.join('\n')).toContain('authentication rejected channel=http-api reason="invalid-credential"')
    await harness.dispose()
  })

  it('refuses an authenticated principal lacking the capability', async () => {
    const harness = await mounted({
      decision: { kind: 'accepted', principal: OBSERVER_PRINCIPAL },
    })
    const { allowed, state } = await authorize(harness, { capability: 'harniverse.administer' })

    expect(allowed).toBe(false)
    expect(state.status).toBe(403)
    // A capability denial is not an authentication failure; nothing is logged
    // about the credential.
    expect(harness.warnings.join('\n')).not.toContain('authentication rejected')
    await harness.dispose()
  })

  it('names a device grant and a nameless grant in the acceptance log', async () => {
    const named = await mounted({ decision: { kind: 'accepted', principal: OWNER_PRINCIPAL } })
    await authorize(named)
    expect(named.infos.join('\n')).toContain('device="workstation" grant="owner-grant"')
    await named.dispose()

    const anonymous = await mounted({ decision: { kind: 'accepted', principal: ANONYMOUS_GRANT_PRINCIPAL } })
    await authorize(anonymous)
    expect(anonymous.infos.join('\n')).toContain('device="-" grant="unnamed-grant"')
    await anonymous.dispose()
  })

  it('renders a missing url and peer as placeholders', async () => {
    const harness = await mounted({ trustedHosts: ['harness.example'] })
    const request = fakeRequest({ peerless: true })
    Object.assign(request, { url: undefined, headers: { host: 'evil.example:3080' } })
    const { allowed } = await authorize(harness, { request })

    expect(allowed).toBe(false)
    const logged = harness.warnings.join('\n')
    expect(logged).toContain('path="-"')
    expect(logged).toContain('peer="-"')
    await harness.dispose()
  })
})

describe('dedicated RPC channels', () => {
  it('rejects a reserved or malformed channel name', async () => {
    const harness = await mounted()
    const handler = async (): Promise<{ ok: true; value: null }> => ({ ok: true, value: null })
    const options = { authority: 'trusted-host', requiredCapability: 'harniverse.observe' } as const

    expect(() => harness.connection.rpc.handle(API_PATH, handler, options)).toThrow(/invalid or reserved/)
    expect(() => harness.connection.rpc.handle('rpc', handler, options)).toThrow(/invalid or reserved/)
    expect(() => harness.connection.rpc.handle('/rpc/nested', handler, options)).toThrow(/invalid or reserved/)
    expect(() => harness.connection.rpc.handle('/rpc space', handler, options)).toThrow(/invalid or reserved/)
    await harness.dispose()
  })

  it('refuses an untrusted request on a dedicated channel', async () => {
    const harness = await mounted({ trustedHosts: ['harness.example'] })
    const remove = harness.connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })

    const state = await callRoute(harness.routes, '/rpc', fakePost('/rpc/probe', envelope('probe', {}), {
      host: 'evil.example:3080',
    }))
    expect(state.status).toBe(403)
    expect(harness.warnings.join('\n')).toContain('rejected untrusted RPC request')
    await remove()
    await harness.dispose()
  })

  it('refuses a rejected credential on a dedicated channel', async () => {
    const harness = await mounted({ decision: { kind: 'rejected', reason: 'missing-credential' } })
    const remove = harness.connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })

    const state = await callRoute(harness.routes, '/rpc', fakePost('/rpc/probe', envelope('probe', {})))
    expect(state.status).toBe(401)
    await remove()
    await harness.dispose()
  })

  it('refuses a principal lacking the channel capability', async () => {
    const harness = await mounted({ decision: { kind: 'accepted', principal: OBSERVER_PRINCIPAL } })
    const calls: unknown[] = []
    const remove = harness.connection.rpc.handle('/rpc', async (invocation) => {
      calls.push(invocation)
      return { ok: true, value: null }
    }, { authority: 'trusted-host', requiredCapability: 'harniverse.administer' })

    const state = await callRoute(harness.routes, '/rpc', fakePost('/rpc/probe', envelope('probe', {})))
    expect(state.status).toBe(403)
    expect(calls).toHaveLength(0)
    await remove()
    await harness.dispose()
  })

  it('refuses a traversal or empty endpoint segment', async () => {
    const harness = await mounted()
    const remove = harness.connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })

    for (const path of ['/rpc/..', '/rpc/.', '/rpc//probe', '/rpc/bad%20name', '/rpc']) {
      const state = await callRoute(harness.routes, '/rpc', fakePost(path, envelope('probe', {})))
      expect(state.status).toBe(403)
    }
    await remove()
    await harness.dispose()
  })

  it('resolves a traversal segment before matching the endpoint', async () => {
    const harness = await mounted()
    const calls: string[] = []
    const remove = harness.connection.rpc.handle('/rpc', async ({ endpoint }) => {
      calls.push(endpoint)
      return { ok: true, value: null }
    }, { authority: 'trusted-host', requiredCapability: 'harniverse.observe' })

    // URL parsing normalizes the path, so the handler sees the resolved
    // endpoint and the envelope method must agree with it.
    const state = await callRoute(harness.routes, '/rpc', fakePost('/rpc/a/../probe', envelope('probe', {})))
    expect(state.status).toBe(200)
    expect(calls).toEqual(['probe'])
    await remove()
    await harness.dispose()
  })

  it('keeps a loopback channel closed to a declared public authority', async () => {
    const harness = await mounted({ trustedHosts: ['harness.example'] })
    const remove = harness.connection.rpc.handle('/loopback', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
      requiredCapability: 'harniverse.observe',
    })

    const declared = await callRoute(harness.routes, '/loopback', fakePost('/loopback/probe', envelope('probe', {}), {
      host: 'harness.example:3080',
    }))
    expect(declared.status).toBe(403)
    const local = await callRoute(harness.routes, '/loopback', fakePost('/loopback/probe', envelope('probe', {})))
    expect(local.status).toBe(200)
    await remove()
    await harness.dispose()
  })
})

describe('RPC envelope admission', () => {
  async function channel(): Promise<{ harness: Harness; call: (path: string, body: unknown, headers?: Record<string, string>) => Promise<ReturnType<typeof fakeResponse>['state']>; failures: string[]; remove: () => Promise<void> }> {
    const harness = await mounted()
    const remove = harness.connection.rpc.handle('/rpc', async ({ endpoint, payload }) => {
      if (endpoint === 'explode') throw new Error('handler exploded')
      return { ok: true, value: { endpoint, payload } }
    }, { authority: 'trusted-host', requiredCapability: 'harniverse.observe' })
    return {
      harness,
      failures: harness.warnings,
      remove,
      call: (path, body, headers) => callRoute(harness.routes, '/rpc', fakePost(path, body, headers)),
    }
  }

  it('requires POST', async () => {
    const { harness, remove } = await channel()
    const state = await callRoute(harness.routes, '/rpc', fakeRequest({ url: '/rpc/probe' }))
    expect(state.status).toBe(404)
    await remove()
    await harness.dispose()
  })

  it('requires a JSON content type', async () => {
    const { harness, remove } = await channel()
    const request = fakeRequest({ method: 'POST', url: '/rpc/probe', headers: { 'content-type': 'text/plain' }, body: {} })
    const state = await callRoute(harness.routes, '/rpc', request)
    expect(state.status).toBe(415)
    await remove()
    await harness.dispose()
  })

  it('accepts a parameterized JSON content type', async () => {
    const { call, harness, remove } = await channel()
    const state = await call('/rpc/probe', envelope('probe', { a: 1 }), {
      'content-type': 'Application/JSON; charset=utf-8',
    })
    expect(state.status).toBe(200)
    await remove()
    await harness.dispose()
  })

  it('refuses a body that is not JSON', async () => {
    const { harness, remove } = await channel()
    const request = Readable.from([Buffer.from('{ not json')]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/rpc/probe',
      method: 'POST',
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const state = await callRoute(harness.routes, '/rpc', request)
    expect(state.status).toBe(400)
    expect(state.body).toBe('body is not JSON')
    await remove()
    await harness.dispose()
  })

  it('reports an invalid envelope against the sentinel rpc id', async () => {
    const { call, harness, remove } = await channel()
    const state = await call('/rpc/probe', { type: 'client-request' })
    expect(state.status).toBe(200)
    const body = JSON.parse(String(state.body))
    expect(body).toMatchObject({
      type: 'server-response',
      rpcId: 'invalid-request',
      result: { ok: false, error: { code: 'bad-request', message: 'invalid client-request message' } },
    })
    expect(serverResponseSchema.safeParse(body).success).toBe(true)
    await remove()
    await harness.dispose()
  })

  it('echoes a string rpc id and request id from an otherwise invalid envelope', async () => {
    const { call, harness, remove } = await channel()
    const state = await call('/rpc/probe', { rpcId: 'caller-supplied', requestId: 'req-9' })
    const body = JSON.parse(String(state.body))
    expect(body).toMatchObject({ rpcId: 'caller-supplied', requestId: 'req-9' })
    await remove()
    await harness.dispose()
  })

  it('ignores non-string identity fields on an invalid envelope', async () => {
    const { call, harness, remove } = await channel()
    const state = await call('/rpc/probe', { rpcId: 42, requestId: 42 })
    const body = JSON.parse(String(state.body))
    expect(body.rpcId).toBe('invalid-request')
    expect(body).not.toHaveProperty('requestId')
    await remove()
    await harness.dispose()
  })

  it('refuses a method that disagrees with its endpoint', async () => {
    const { call, harness, remove } = await channel()
    const state = await call('/rpc/probe', envelope('other', {}))
    const body = JSON.parse(String(state.body))
    expect(body.result.error).toMatchObject({
      code: 'bad-request',
      message: 'method "other" does not match endpoint "probe"',
    })
    await remove()
    await harness.dispose()
  })

  it('carries an optional request id into the reply', async () => {
    const { call, harness, remove } = await channel()
    const state = await call('/rpc/probe', {
      ...envelope('probe', { a: 1 }),
      requestId: RequestId('req-7'),
    })
    expect(JSON.parse(String(state.body))).toMatchObject({ requestId: 'req-7' })
    await remove()
    await harness.dispose()
  })

  it('reports a throwing handler as an opaque failure', async () => {
    const { call, failures, harness, remove } = await channel()
    const state = await call('/rpc/explode', envelope('explode', {}))
    expect(state.status).toBe(500)
    expect(state.body).toBe('internal handler failure')
    // The reason reaches the operator log, never the caller.
    expect(failures.join('\n')).toContain('RPC handler failed for explode')
    await remove()
    await harness.dispose()
  })
})

describe('idempotency ledger', () => {
  interface Ledger {
    harness: Harness
    calls: string[]
    call: (endpoint: string, payload: unknown, key?: string, id?: string) => Promise<ReturnType<typeof fakeResponse>['state']>
    remove: () => Promise<void>
  }

  async function ledger(options: { fail?: boolean } = {}): Promise<Ledger> {
    const harness = await mounted()
    const calls: string[] = []
    const remove = harness.connection.rpc.handle('/rpc', async ({ endpoint, payload }) => {
      calls.push(endpoint)
      if (options.fail === true) throw new Error('handler exploded')
      return { ok: true, value: { endpoint, payload, run: calls.length } }
    }, { authority: 'trusted-host', requiredCapability: 'harniverse.observe' })
    return {
      harness,
      calls,
      remove,
      call: (endpoint, payload, key, id) => callRoute(
        harness.routes,
        '/rpc',
        fakePost(`/rpc/${endpoint}`, envelope(endpoint, payload, id), key === undefined ? {} : { 'idempotency-key': key }),
      ),
    }
  }

  it('runs once and replays the recorded result for a repeated key', async () => {
    const { call, calls, harness, remove } = await ledger()
    const first = await call('create', { name: 'a' }, 'key-1', 'rpc-a')
    const second = await call('create', { name: 'a' }, 'key-1', 'rpc-b')

    expect(calls).toEqual(['create'])
    expect(JSON.parse(String(first.body))).toMatchObject({ rpcId: 'rpc-a', result: { ok: true, value: { run: 1 } } })
    // The replay carries the second caller's identity with the first result.
    expect(JSON.parse(String(second.body))).toMatchObject({ rpcId: 'rpc-b', result: { ok: true, value: { run: 1 } } })
    await remove()
    await harness.dispose()
  })

  it('replays a recorded result under the repeating caller request id', async () => {
    const { harness, remove } = await ledger()
    await callRoute(harness.routes, '/rpc', fakePost('/rpc/create', {
      ...envelope('create', { name: 'a' }, 'rpc-a'),
      requestId: RequestId('req-1'),
    }, { 'idempotency-key': 'key-1' }))
    const replay = await callRoute(harness.routes, '/rpc', fakePost('/rpc/create', {
      ...envelope('create', { name: 'a' }, 'rpc-b'),
      requestId: RequestId('req-2'),
    }, { 'idempotency-key': 'key-1' }))

    expect(JSON.parse(String(replay.body))).toMatchObject({ rpcId: 'rpc-b', requestId: 'req-2' })
    await remove()
    await harness.dispose()
  })

  it('refuses the same key with a different payload', async () => {
    const { call, calls, harness, remove } = await ledger()
    await call('create', { name: 'a' }, 'key-1')
    const reused = await call('create', { name: 'b' }, 'key-1')

    expect(calls).toEqual(['create'])
    expect(JSON.parse(String(reused.body)).result.error).toMatchObject({
      code: 'idempotency-key-reused',
      message: 'Idempotency-Key was already used with a different payload',
      details: { key: 'key-1' },
    })
    await remove()
    await harness.dispose()
  })

  it('scopes keys per endpoint', async () => {
    const { call, calls, harness, remove } = await ledger()
    await call('create', { name: 'a' }, 'shared')
    await call('update', { name: 'a' }, 'shared')

    expect(calls).toEqual(['create', 'update'])
    await remove()
    await harness.dispose()
  })

  it('ignores a blank key and reruns the handler', async () => {
    const { call, calls, harness, remove } = await ledger()
    await call('create', { name: 'a' }, '   ')
    await call('create', { name: 'a' }, '')

    expect(calls).toEqual(['create', 'create'])
    await remove()
    await harness.dispose()
  })

  it('does not record a failed run, so a retry runs again', async () => {
    const { call, calls, harness, remove } = await ledger({ fail: true })
    const first = await call('create', { name: 'a' }, 'key-1')
    const second = await call('create', { name: 'a' }, 'key-1')

    expect(first.status).toBe(500)
    expect(second.status).toBe(500)
    // Both attempts reached the handler: a 500 is never a recorded outcome.
    expect(calls).toEqual(['create', 'create'])
    await remove()
    await harness.dispose()
  })

  it('separates ledgers by authenticated identity', async () => {
    const owner = await mounted({ decision: { kind: 'accepted', principal: OWNER_PRINCIPAL } })
    const observer = await mounted({ decision: { kind: 'accepted', principal: OBSERVER_PRINCIPAL } })
    const calls: string[] = []
    // One handler instance owns the ledger, so two principals sharing it prove
    // the scope key carries the admitted identity.
    const handler = async (): Promise<{ ok: true; value: { run: number } }> => {
      calls.push('run')
      return { ok: true, value: { run: calls.length } }
    }
    const removeOwner = owner.connection.rpc.handle('/rpc', handler, {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })
    const removeObserver = observer.connection.rpc.handle('/rpc', handler, {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })

    await callRoute(owner.routes, '/rpc', fakePost('/rpc/create', envelope('create', {}), { 'idempotency-key': 'k' }))
    await callRoute(observer.routes, '/rpc', fakePost('/rpc/create', envelope('create', {}), { 'idempotency-key': 'k' }))
    expect(calls).toHaveLength(2)

    // The same principal repeating its own key still replays.
    await callRoute(owner.routes, '/rpc', fakePost('/rpc/create', envelope('create', {}), { 'idempotency-key': 'k' }))
    expect(calls).toHaveLength(2)

    await removeOwner()
    await removeObserver()
    await owner.dispose()
    await observer.dispose()
  })

  it('expires a recorded result after its retention window', async () => {
    vi.useFakeTimers()
    try {
      const { call, calls, harness, remove } = await ledger()
      await call('create', { name: 'a' }, 'key-1')
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1)
      await call('create', { name: 'a' }, 'key-1')

      expect(calls).toEqual(['create', 'create'])
      await remove()
      await harness.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the ledger by evicting the oldest recorded key', async () => {
    const { call, calls, harness, remove } = await ledger()
    for (let index = 0; index < 1024; index += 1) {
      await call('create', { index }, `key-${String(index)}`)
    }
    expect(calls).toHaveLength(1024)

    // One more admission evicts the oldest, so its key runs again while a
    // recent key still replays.
    await call('create', { index: 1024 }, 'key-1024')
    await call('create', { index: 0 }, 'key-0')
    expect(calls).toHaveLength(1026)
    await call('create', { index: 1023 }, 'key-1023')
    expect(calls).toHaveLength(1026)
    await remove()
    await harness.dispose()
  })
})

describe('shared /api interceptor', () => {
  it('rejects an interceptor on any channel but /api', async () => {
    const harness = await mounted()
    expect(() => harness.connection.rpc.intercept(
      '/rpc' as '/api',
      () => ({ requiredCapability: 'harniverse.observe' }),
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host', requiredCapability: 'harniverse.observe' },
    )).toThrow(/invalid shared RPC channel/)
    await harness.dispose()
  })

  it('refuses a second interceptor and accepts one after withdrawal', async () => {
    const harness = await mounted()
    const resolve = (): { requiredCapability: AuthenticationCapability } => ({ requiredCapability: 'harniverse.observe' })
    const handler = async (): Promise<{ ok: true; value: null }> => ({ ok: true, value: null })
    const options = { authority: 'trusted-host', requiredCapability: 'harniverse.observe' } as const
    const remove = harness.connection.rpc.intercept(API_PATH, resolve, handler, options)

    expect(() => harness.connection.rpc.intercept(API_PATH, resolve, handler, options))
      .toThrow(/already has an interceptor/)
    await remove()
    expect(() => harness.connection.rpc.intercept(API_PATH, resolve, handler, options)).not.toThrow()
    await harness.dispose()
  })

  it('refuses an endpoint the interceptor explicitly denies', async () => {
    const harness = await mounted()
    const calls: string[] = []
    const remove = harness.connection.rpc.intercept(
      API_PATH,
      endpoint => endpoint === 'denied' ? { denied: true } as const : undefined,
      async ({ endpoint }) => { calls.push(endpoint); return { ok: true, value: null } },
      { authority: 'trusted-host', requiredCapability: 'harniverse.observe' },
    )

    const state = await callRoute(harness.routes, API_PATH, fakePost(`${API_PATH}/denied`, envelope('denied', {})))
    expect(state.status).toBe(403)
    expect(calls).toHaveLength(0)
    await remove()
    await harness.dispose()
  })

  it('refuses a claimed endpoint whose capability the principal lacks', async () => {
    const harness = await mounted({ decision: { kind: 'accepted', principal: OBSERVER_PRINCIPAL } })
    const calls: string[] = []
    const remove = harness.connection.rpc.intercept(
      API_PATH,
      endpoint => endpoint === 'admin' ? { requiredCapability: 'harniverse.administer' } : undefined,
      async ({ endpoint }) => { calls.push(endpoint); return { ok: true, value: null } },
      { authority: 'trusted-host', requiredCapability: 'harniverse.administer' },
    )

    const state = await callRoute(harness.routes, API_PATH, fakePost(`${API_PATH}/admin`, envelope('admin', {})))
    expect(state.status).toBe(403)
    expect(calls).toHaveLength(0)
    await remove()
    await harness.dispose()
  })

  it('keeps a loopback interceptor closed to a declared public authority', async () => {
    const harness = await mounted({ trustedHosts: ['harness.example'] })
    const calls: string[] = []
    const remove = harness.connection.rpc.intercept(
      API_PATH,
      endpoint => endpoint === 'local' ? { requiredCapability: 'harniverse.observe' } : undefined,
      async ({ endpoint }) => { calls.push(endpoint); return { ok: true, value: null } },
      { authority: 'loopback', requiredCapability: 'harniverse.observe' },
    )

    const declared = await callRoute(harness.routes, API_PATH, fakePost(`${API_PATH}/local`, envelope('local', {}), {
      host: 'harness.example:3080',
      origin: 'http://harness.example:3080',
      'sec-fetch-site': 'same-origin',
    }))
    expect(declared.status).toBe(403)
    expect(calls).toHaveLength(0)

    const local = await callRoute(harness.routes, API_PATH, fakePost(`${API_PATH}/local`, envelope('local', {})))
    expect(local.status).toBe(200)
    expect(calls).toEqual(['local'])
    await remove()
    await harness.dispose()
  })

  it('refuses a path outside the shared channel', async () => {
    const harness = await mounted()
    const state = await callRoute(harness.routes, API_PATH, fakePost('/other/endpoint', envelope('endpoint', {})))
    expect(state.status).toBe(403)
    await harness.dispose()
  })

  it('refuses an unclaimed endpoint the legacy resolver does not know', async () => {
    const harness = await mounted()
    const state = await callRoute(harness.routes, API_PATH, fakePost(`${API_PATH}/unknown.endpoint`, envelope('unknown.endpoint', {})))
    expect(state.status).toBe(403)
    await harness.dispose()
  })

  it('reports a throwing interceptor handler as an opaque failure', async () => {
    const harness = await mounted()
    const remove = harness.connection.rpc.intercept(
      API_PATH,
      endpoint => endpoint === 'explode' ? { requiredCapability: 'harniverse.observe' } : undefined,
      async () => { throw new Error('interceptor exploded') },
      { authority: 'trusted-host', requiredCapability: 'harniverse.observe' },
    )

    const state = await callRoute(harness.routes, API_PATH, fakePost(`${API_PATH}/explode`, envelope('explode', {})))
    expect(state.status).toBe(500)
    expect(state.body).toBe('internal handler failure')
    expect(harness.warnings.join('\n')).toContain('RPC handler failed for explode')
    await remove()
    await harness.dispose()
  })
})

describe('log placeholders on a bodiless socket', () => {
  it('renders a missing url and peer on a dedicated channel denial', async () => {
    const harness = await mounted({ trustedHosts: ['harness.example'] })
    const remove = harness.connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })
    const request = fakePost('/rpc/probe', envelope('probe', {}), { host: 'evil.example:3080' })
    Object.assign(request, { url: undefined, socket: {} })

    await callRoute(harness.routes, '/rpc', request)
    expect(harness.warnings.join('\n')).toContain('path="-"')
    expect(harness.warnings.join('\n')).toContain('peer="-"')
    await remove()
    await harness.dispose()
  })

  it('renders placeholders when a dedicated channel rejects the credential', async () => {
    const harness = await mounted({ decision: { kind: 'rejected', reason: 'invalid-credential' } })
    const remove = harness.connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })
    const request = fakePost('/rpc/probe', envelope('probe', {}))
    Object.assign(request, { url: undefined, socket: {} })

    await callRoute(harness.routes, '/rpc', request)
    const logged = harness.warnings.join('\n')
    expect(logged).toContain('authentication rejected')
    expect(logged).toContain('path="-"')
    expect(logged).toContain('peer="-"')
    await remove()
    await harness.dispose()
  })

  it('renders placeholders when a dedicated channel accepts', async () => {
    const harness = await mounted()
    const remove = harness.connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
      requiredCapability: 'harniverse.observe',
    })
    const request = fakePost('/rpc/probe', envelope('probe', {}))
    Object.assign(request, { url: undefined, socket: {} })

    await callRoute(harness.routes, '/rpc', request)
    const logged = harness.infos.join('\n')
    expect(logged).toContain('connection accepted')
    expect(logged).toContain('path="-"')
    expect(logged).toContain('peer="-"')
    await remove()
    await harness.dispose()
  })

  it('renders placeholders when the authorization gate rejects the credential', async () => {
    const harness = await mounted({ decision: { kind: 'rejected', reason: 'invalid-credential' } })
    const request = fakeRequest({ peerless: true })
    Object.assign(request, { url: undefined })
    const recorder = fakeResponse()

    await harness.service.authorizeHttpRequest(request, recorder.response, 'harniverse.observe')
    const logged = harness.warnings.join('\n')
    expect(logged).toContain('authentication rejected')
    expect(logged).toContain('path="-"')
    expect(logged).toContain('peer="-"')
    await harness.dispose()
  })

  it('renders placeholders when the authorization gate admits', async () => {
    const harness = await mounted()
    const request = fakeRequest({ peerless: true })
    Object.assign(request, { url: undefined })
    const recorder = fakeResponse()

    expect(await harness.service.authorizeHttpRequest(request, recorder.response, 'harniverse.observe')).toBe(true)
    const logged = harness.infos.join('\n')
    expect(logged).toContain('connection accepted')
    expect(logged).toContain('path="-"')
    expect(logged).toContain('peer="-"')
    await harness.dispose()
  })
})
