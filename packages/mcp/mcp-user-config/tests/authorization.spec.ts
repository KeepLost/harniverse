/**
 * Explicit MCP OAuth authorization owned by the management Remote: the
 * attempt phases and their fleet notifications, the public callback route and
 * its single-use constant-time state check, redirect-origin validation, the
 * bounded lifetime of an attempt, sign-out, and the OAuth fields of a status
 * row. Flows, the web listener, and the origin trust fence are doubles; the
 * callback is driven through the registered route handler.
 */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { McpLocalError } from '@deepseek-ai/dsh-mcp-client'
import type { McpConnectionsService, McpOAuthAuthorizationState, SharedConnection } from '@deepseek-ai/dsh-mcp-client'
import { McpManagementService } from '../src/management.ts'
import type { McpFleetEntry, UserMcpServerConfig } from '../src/index.ts'
import type { McpManagementAttempt, McpManagementStatusRow } from '../src/types.ts'

type Mock<F extends (...args: never[]) => unknown> = ReturnType<typeof vi.fn<F>>

/** One flow double the capability double hands out. */
interface FlowDouble {
  begin: Mock<(input: { redirectUri: string; state: string }) => Promise<{ authorizationUrl: string }>>
  exchange: Mock<(input: { code: string; iss: string | undefined }) => Promise<void>>
  commit: Mock<() => Promise<void>>
  dispose: ReturnType<typeof vi.fn>
}

/** The OAuth capability double a handle carries. */
interface OAuthDouble {
  authorizationTimeoutMs: number
  status: () => McpOAuthAuthorizationState | undefined
  createFlow: () => FlowDouble
  signOut: () => Promise<void>
  resume: () => void
  readonly flows: FlowDouble[]
}

function entry(overrides: Partial<UserMcpServerConfig> = {}): UserMcpServerConfig {
  return {
    id: 'alpha',
    enabled: true,
    transport: 'streamable-http',
    serverName: 'alpha',
    url: 'https://mcp.example/mcp',
    oauth: true,
    args: [],
    env: {},
    cwd: '',
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    ...overrides,
  }
}

function flowDouble(overrides: Partial<FlowDouble> = {}): FlowDouble {
  return {
    begin: vi.fn(async () => ({ authorizationUrl: 'https://as.example/authorize?client_id=app' })),
    exchange: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    dispose: vi.fn(),
    ...overrides,
  }
}

/** A server entry that carries no `oauth` field at all. */
function plainEntry(): UserMcpServerConfig {
  const plain = entry()
  delete plain.oauth
  return plain
}

function fakeOAuth(status: McpOAuthAuthorizationState | undefined = { state: 'waiting-authorization', reason: 'missing' }): OAuthDouble {
  const flows: FlowDouble[] = []
  return {
    flows,
    authorizationTimeoutMs: 600_000,
    status: vi.fn(() => status),
    createFlow: vi.fn((): FlowDouble => {
      const flow = flowDouble()
      flows.push(flow)
      return flow
    }),
    signOut: vi.fn(async () => {}),
    resume: vi.fn(),
  }
}

function fakeHandle(oauth?: OAuthDouble): SharedConnection {
  return {
    serverName: 'alpha',
    ready: Promise.resolve({}),
    connected: () => false,
    status: () => ({ state: 'waiting-authorization', failedAttempts: 0, maxAttempts: 10, ...oauth === undefined ? {} : { authorization: oauth.status() } }),
    toolDescriptors: () => [],
    toolNames: () => [],
    resourceUris: () => [],
    resourceTemplates: () => [],
    instructions: () => '',
    callTool: () => Promise.resolve({}),
    resources: { request: () => Promise.resolve({}) },
    subscribe: () => () => {},
    dispose: () => Promise.resolve(),
    ...oauth === undefined ? {} : { oauth },
  } as unknown as SharedConnection
}

function registryOf(live: Record<string, SharedConnection>): McpConnectionsService & { notify: (serverId: string) => void } {
  const listeners = new Set<(serverId: string) => void>()
  return {
    get: id => live[id],
    register: () => () => {},
    subscribe: (listener: (serverId: string) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify: (serverId) => { for (const listener of listeners) listener(serverId) },
  }
}

/** One callback route the listener double keeps. */
interface CallbackRoute {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/** A web listener double on a fixed origin whose route table the spec reads. */
function fakeListener(options: { host?: string; protocol?: string; port?: number } = {}): { listener: object; routes: CallbackRoute[] } {
  const routes: CallbackRoute[] = []
  return {
    routes,
    listener: {
      protocol: options.protocol ?? 'http:',
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 3080,
      register(route: CallbackRoute): () => void {
        if (routes.some(candidate => candidate.path === route.path)) throw new Error('duplicate route')
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
  }
}

function fakeRequest(url: string, method: string, host: string): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method, headers: { host }, socket: { remoteAddress: '127.0.0.1' } })
  return request
}

function fakeResponse(): { response: ServerResponse; status?: number; body?: string; headers?: Record<string, string> } {
  const state: { status?: number; body?: string; headers?: Record<string, string> } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      if (headers !== undefined) state.headers = headers
      return this
    },
    end(value?: string) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      return this
    },
  }) as unknown as ServerResponse
  return Object.assign(state, { response })
}

/** One callback answer as the route handler wrote it; a status is absent until the handler replied. */
interface Answer {
  status: number | undefined
  body: string | undefined
  headers: Record<string, string> | undefined
}

interface Bench {
  ctx: Context
  service: McpManagementService
  oauth: OAuthDouble
  routes: CallbackRoute[]
  live: Record<string, SharedConnection>
  registry: ReturnType<typeof registryOf>
  changed: ReturnType<typeof vi.fn>
  warnings: string[]
  row: () => McpManagementStatusRow
  attempt: () => McpManagementAttempt | undefined
  flow: () => FlowDouble
  state: () => string
  callback: (query: string, options?: { method?: string; host?: string }) => Promise<Answer>
  /** Send one raw request-target to the callback route. */
  raw: (target: string) => Promise<{ status: number | undefined; body: string | undefined }>
  /** The callback's status and body only, for the pages every refusal shares. */
  answer: (query: string, options?: { method?: string; host?: string }) => Promise<{ status: number | undefined; body: string | undefined }>
}

async function bench(options: {
  oauth?: OAuthDouble
  handle?: boolean
  web?: false | { host?: string; protocol?: string; port?: number }
  trusted?: readonly string[]
  entries?: readonly McpFleetEntry[]
} = {}): Promise<Bench> {
  const ctx = new Context()
  const changed = vi.fn()
  ctx.on('mcpManagement/fleet-changed', changed)
  const web = options.web === false ? { listener: undefined, routes: [] as CallbackRoute[] } : fakeListener(options.web)
  if (web.listener !== undefined) ctx.provide('webServer', web.listener)
  const trusted = new Set(options.trusted ?? [])
  ctx.provide('connection', { isTrustedWebOrigin: (origin: string) => trusted.has(origin) })
  const oauth = options.oauth ?? fakeOAuth()
  const live: Record<string, SharedConnection> = {}
  if (options.handle !== false) live.alpha = fakeHandle(oauth)
  const registry = registryOf(live)
  const service = new McpManagementService(ctx, {
    registry,
    entries: () => options.entries ?? [{ entry: entry(), registered: false }],
    restartOwner: async () => {},
    probeEntry: async () => { throw new Error('unreachable') },
  })
  const warnings: string[] = []
  ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
  const callback = async (query: string, init: { method?: string; host?: string } = {}): Promise<Answer> => {
    const route = web.routes.find(candidate => candidate.path === CALLBACK_PATH)
    if (route === undefined) throw new Error('the callback route is not registered')
    const recorder = fakeResponse()
    await route.handler(fakeRequest(`${CALLBACK_PATH}${query}`, init.method ?? 'GET', init.host ?? '127.0.0.1:3080'), recorder.response)
    return { status: recorder.status, body: recorder.body, headers: recorder.headers }
  }
  return {
    ctx,
    service,
    oauth,
    routes: web.routes,
    live,
    registry,
    changed,
    warnings,
    row: () => service.status().find(candidate => candidate.id === 'alpha')!,
    attempt: () => service.status().find(candidate => candidate.id === 'alpha')?.attempt,
    flow: () => oauth.flows.at(-1)!,
    state: () => oauth.flows.at(-1)!.begin.mock.calls[0]![0].state,
    callback,
    answer: async (query, init = {}) => {
      const { status, body } = await callback(query, init)
      return { status, body }
    },
    raw: async (target) => {
      const route = web.routes.find(candidate => candidate.path === CALLBACK_PATH)
      if (route === undefined) throw new Error('the callback route is not registered')
      const recorder = fakeResponse()
      await route.handler(fakeRequest(target, 'GET', '127.0.0.1:3080'), recorder.response)
      return { status: recorder.status, body: recorder.body }
    },
  }
}

const CALLBACK_PATH = `/mcp/oauth/callback/${createHash('sha256').update('alpha').digest('hex')}`
const RECEIVED = 'Authorization received. You can close this page and check the connection in Harniverse.'
const INCOMPLETE = 'Authorization was not completed. Return to Harniverse to try again.'
/** Send one callback and assert it answered the generic incomplete page with the given status. */
async function refusedPage(b: Bench, query: string, options: { method?: string; host?: string } = {}, status = 400): Promise<void> {
  const answer = await b.answer(query, options)
  expect(answer.status).toBe(status)
  expect(answer.body).toContain(INCOMPLETE)
}

describe('McpManagementService OAuth status rows', () => {
  it('reports authorization and attempt only for an OAuth-configured server', async () => {
    const b = await bench({ oauth: fakeOAuth({ state: 'authorized', expiresAtMs: 5_000 }) })
    expect(b.row().authorization).toEqual({ state: 'authorized', expiresAtMs: 5_000 })
    expect(b.row().attempt).toBeUndefined()
    const { attempt } = await b.service.startAuthorization('alpha')
    expect(b.row()).toMatchObject({
      state: 'waiting-authorization',
      authorization: { state: 'authorized', expiresAtMs: 5_000 },
      attempt,
    })
    expect(attempt).toMatchObject({ id: attempt.id, phase: 'waiting-browser' })
    expect(JSON.stringify(b.row())).not.toContain('authorizationUrl')
  })

  it('reports the waiting reason of a connection that has no grant', async () => {
    const b = await bench({ oauth: fakeOAuth({ state: 'waiting-authorization', reason: 'expired' }) })
    expect(b.row().authorization).toEqual({ state: 'waiting-authorization', reason: 'expired' })
    const pending = await bench({ oauth: fakeOAuth({ state: 'authorized' }) })
    expect(pending.row().authorization).toEqual({ state: 'authorized' })
  })

  it('leaves both fields absent without a live OAuth connection', async () => {
    const b = await bench({ handle: false })
    expect(b.row()).toMatchObject({ state: 'stopped' })
    expect(b.row().authorization).toBeUndefined()
    expect(b.row().attempt).toBeUndefined()
  })
})

describe('McpManagementService startAuthorization', () => {
  it('validates the server, its OAuth configuration, its live connection, and the web listener', async () => {
    const b = await bench({ handle: false })
    await expect(b.service.startAuthorization('ghost')).rejects.toThrow('mcp-user-config: unknown server "ghost"')
    await expect(b.service.startAuthorization('alpha')).rejects.toThrow('mcp-user-config: server "alpha" has no live connection; enable it before authorizing')
    const plain = await bench({ handle: false, entries: [{ entry: plainEntry(), registered: false }] })
    await expect(plain.service.startAuthorization('alpha')).rejects.toThrow('mcp-user-config: server "alpha" has no OAuth configuration')
    const headless = await bench({ web: false })
    await expect(headless.service.startAuthorization('alpha')).rejects.toThrow('mcp-user-config: explicit MCP OAuth authorization requires the web listener')
  })

  it('defaults the redirect origin to the loopback form of the web listener and accepts a trusted deployment origin', async () => {
    const b = await bench({ web: { host: '0.0.0.0', protocol: 'https:', port: 8443 } })
    await b.service.startAuthorization('alpha')
    expect(b.routes.map(route => route.kind)).toEqual(['exact'])
    expect(b.flow().begin.mock.calls[0]![0].redirectUri).toBe(`https://127.0.0.1:8443${CALLBACK_PATH}`)
    await b.service.cancelAuthorization('alpha')
    expect(b.routes).toHaveLength(0)

    const trusted = await bench({ web: { protocol: 'https:', port: 8443 }, trusted: ['https://harness.example'] })
    await trusted.service.startAuthorization('alpha', 'https://harness.example')
    expect(trusted.flow().begin.mock.calls[0]![0].redirectUri).toBe(`https://harness.example${CALLBACK_PATH}`)
  })

  it.each([
    'http://127.0.0.1:3080',
    'http://localhost:3080',
    'http://[::1]:3080',
  ])('accepts the loopback redirect origin %s without a trust fence', async (origin) => {
    const b = await bench()
    const { attempt } = await b.service.startAuthorization('alpha', origin)
    expect(attempt.phase).toBe('waiting-browser')
    expect(b.flow().begin.mock.calls[0]![0].redirectUri).toBe(`${origin}${CALLBACK_PATH}`)
  })

  it.each([
    'https://evil.example',
    'http://harness.example',
    'http://127.0.0.1.5:3080',
    'http://192.168.1.5:3080',
    'https://harness.example/app',
    'harness.example',
    'ftp://harness.example',
  ])('refuses the redirect origin %s before any flow starts', async (origin) => {
    const b = await bench({ trusted: ['https://harness.example', 'http://harness.example'] })
    await expect(b.service.startAuthorization('alpha', origin)).rejects.toThrow('is not a serving authority of this deployment')
    expect(b.oauth.flows).toHaveLength(0)
    expect(b.routes).toHaveLength(0)
    expect(b.attempt()).toBeUndefined()
  })

  it('runs the phases to authorized, resumes the connection, and removes the callback route', async () => {
    const b = await bench()
    const { authorizationUrl, attempt } = await b.service.startAuthorization('alpha')
    expect(authorizationUrl).toBe('https://as.example/authorize?client_id=app')
    expect(typeof attempt.id).toBe('string')
    expect(attempt.phase).toBe('waiting-browser')
    expect(typeof attempt.expiresAtMs).toBe('number')
    expect(attempt.expiresAtMs - Date.now()).toBeLessThanOrEqual(600_000)
    const request = b.flow().begin.mock.calls[0]![0]
    expect(request.redirectUri).toBe(`http://127.0.0.1:3080${CALLBACK_PATH}`)
    expect(request.state).toMatch(/^[\w-]{43}$/)
    const changesBefore = b.changed.mock.calls.length

    const answer = await b.callback(`?code=c-1&state=${b.state()}&iss=https://as.example`)
    expect(answer.status).toBe(200)
    expect(answer.headers).toMatchObject({ 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
    expect(answer.headers?.['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(answer.body).toContain(RECEIVED)
    expect(answer.body).toContain('Harniverse')
    expect(answer.body).not.toContain('c-1')
    expect(answer.body).not.toContain(b.state())
    await vi.waitFor(() => { expect(b.attempt()?.phase).toBe('authorized') })
    expect(b.flow().exchange.mock.calls[0]![0]).toEqual({ code: 'c-1', iss: 'https://as.example' })
    expect(b.flow().commit).toHaveBeenCalledTimes(1)
    expect(b.flow().dispose).toHaveBeenCalled()
    expect(b.oauth.resume).toHaveBeenCalledTimes(1)
    expect(b.routes).toHaveLength(0)
    // exchanging, committing, and authorized each announce themselves
    expect(b.changed.mock.calls.length - changesBefore).toBeGreaterThanOrEqual(3)
  })

  it('returns the pending attempt again instead of starting a second flow', async () => {
    const b = await bench()
    const first = await b.service.startAuthorization('alpha')
    expect(await b.service.startAuthorization('alpha')).toEqual(first)
    expect(await b.service.startAuthorization('alpha', 'https://ignored.example')).toEqual(first)
    expect(b.oauth.flows).toHaveLength(1)
    await b.service.cancelAuthorization('alpha')
    const third = await b.service.startAuthorization('alpha')
    expect(third.attempt.id).not.toBe(first.attempt.id)
    expect(b.oauth.flows).toHaveLength(2)
  })

  it('refuses a malformed, foreign, or wrong-method callback without echoing it', async () => {
    const b = await bench()
    await b.service.startAuthorization('alpha')
    const state = b.state()
    await refusedPage(b, '?code=c-1&state=wrong&iss=https://as.example')
    await refusedPage(b, '?code=c-1')
    await refusedPage(b, `?state=${state}`)
    await refusedPage(b, `?code=c-1&error=access_denied&state=${state}`)
    await refusedPage(b, `?code=c-1&code=c-2&state=${state}`)
    await refusedPage(b, `?code=&state=${state}`)
    await refusedPage(b, `?code=c-1&state=${state}&iss=a&iss=b`)
    await refusedPage(b, '//', {}, 404)
    expect((await b.raw('http://[')).status).toBe(400)
    await refusedPage(b, `?code=c-1&state=${state}`, { method: 'POST' }, 405)
    await refusedPage(b, `?code=c-1&state=${state}`, { host: 'evil.example' }, 404)
    await refusedPage(b, `?code=c-1&state=${state}`, { host: 'not a host' }, 404)
    expect(b.attempt()?.phase).toBe('waiting-browser')
  })

  it('consumes the state once: the first callback completes the attempt and a replay is gone', async () => {
    const b = await bench()
    await b.service.startAuthorization('alpha')
    expect((await b.callback(`?code=c-1&state=${b.state()}`)).status).toBe(200)
    await refusedPage(b, `?code=c-9&state=${b.state()}`, {}, 410)
    await vi.waitFor(() => { expect(b.attempt()?.phase).toBe('authorized') })
    expect(b.flow().exchange).toHaveBeenCalledTimes(1)
    expect(b.flow().exchange.mock.calls[0]![0].code).toBe('c-1')
  })

  it.each([
    ['access_denied', 'cancelled'],
    ['server_error', 'failed'],
  ] as const)('settles an authorization-server error (%s) as %s', async (error, phase) => {
    const b = await bench()
    await b.service.startAuthorization('alpha')
    const answer = await b.answer(`?error=${error}&state=${b.state()}`)
    expect(answer.status).toBe(200)
    expect(answer.body).toContain(INCOMPLETE)
    await vi.waitFor(() => { expect(b.attempt()?.phase).toBe(phase) })
    expect(b.flow().exchange).not.toHaveBeenCalled()
    expect(b.routes).toHaveLength(0)
  })

  it('cancels a pending attempt and ignores a repeated or unknown cancellation', async () => {
    const b = await bench()
    await b.service.startAuthorization('alpha')
    await b.service.cancelAuthorization('alpha')
    expect(b.attempt()?.phase).toBe('cancelled')
    expect(b.routes).toHaveLength(0)
    await b.service.cancelAuthorization('alpha')
    await b.service.cancelAuthorization('ghost')
    expect(b.attempt()?.phase).toBe('cancelled')
    // A late redirect finds no route: the callback exists only while its attempt can complete.
    expect(b.routes).toHaveLength(0)
  })

  it('fails an attempt at its authorization deadline', async () => {
    vi.useFakeTimers()
    try {
      const b = await bench()
      const { attempt } = await b.service.startAuthorization('alpha')
      await vi.advanceTimersByTimeAsync(attempt.expiresAtMs - Date.now() + 1)
      expect(b.attempt()?.phase).toBe('failed')
      expect(b.routes).toHaveLength(0)
      expect(b.warnings.join('\n')).toContain('timed out after 600000ms')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a refused flow step as failed and keeps its log free of codes', async () => {
    const beginning = await bench()
    const refused = fakeOAuth()
    refused.createFlow = vi.fn((): FlowDouble => {
      const flow = flowDouble({ begin: vi.fn(async () => { throw new McpLocalError('MCP OAuth authorization server discovery failed', 'MCP_OAUTH_FAILED') }) })
      refused.flows.push(flow)
      return flow
    })
    beginning.live.alpha = fakeHandle(refused)
    beginning.registry.notify('alpha')
    await expect(beginning.service.startAuthorization('alpha')).rejects.toThrow('MCP OAuth authorization server discovery failed')
    await vi.waitFor(() => { expect(beginning.attempt()?.phase).toBe('failed') })
    expect(beginning.routes).toHaveLength(0)

    const exchanging = await bench()
    await exchanging.service.startAuthorization('alpha')
    exchanging.flow().exchange.mockRejectedValue(new McpLocalError('MCP OAuth authorization code exchange was refused by the authorization server (invalid_grant)', 'MCP_OAUTH_FAILED'))
    await exchanging.callback('?code=secret-code&state=' + exchanging.state())
    await vi.waitFor(() => { expect(exchanging.attempt()?.phase).toBe('failed') })
    expect(exchanging.warnings.join('\n')).toContain('invalid_grant')
    expect(exchanging.warnings.join('\n')).not.toContain('secret-code')

    const committing = await bench()
    await committing.service.startAuthorization('alpha')
    committing.flow().commit.mockRejectedValue(new McpLocalError('MCP OAuth requires a credentials provider', 'MCP_OAUTH_FAILED'))
    await committing.callback('?code=c-1&state=' + committing.state())
    await vi.waitFor(() => { expect(committing.attempt()?.phase).toBe('failed') })
    expect(committing.oauth.resume).not.toHaveBeenCalled()
    // A foreign error is reported by its kind only, and a non-error rejection not at all.
    for (const [rejected, expected] of [[new TypeError('secret-code'), 'TypeError'], ['secret-code', 'unknown failure']] as const) {
      const foreign = await bench()
      await foreign.service.startAuthorization('alpha')
      foreign.flow().exchange.mockRejectedValue(rejected)
      await foreign.callback('?code=c-1&state=' + foreign.state())
      await vi.waitFor(() => { expect(foreign.attempt()?.phase).toBe('failed') })
      expect(foreign.warnings.join('\n')).toContain(expected)
      expect(foreign.warnings.join('\n')).not.toContain('secret-code')
    }
  })

  it('signs out through the connection and names an unknown or unconnected server', async () => {
    const b = await bench()
    await b.service.signOut('alpha')
    expect(b.oauth.signOut).toHaveBeenCalledTimes(1)
    await expect(b.service.signOut('ghost')).rejects.toThrow('mcp-user-config: unknown server "ghost"')
    const plain = await bench({ handle: false, entries: [{ entry: plainEntry(), registered: false }] })
    await expect(plain.service.signOut('alpha')).rejects.toThrow('mcp-user-config: server "alpha" has no OAuth configuration')
    const offline = await bench({ handle: false })
    await expect(offline.service.signOut('alpha')).rejects.toThrow('mcp-user-config: server "alpha" has no live connection; enable it first')
  })

  it('cancels a pending attempt when its connection is replaced, and on disposal', async () => {
    const b = await bench()
    await b.service.startAuthorization('alpha')
    b.live.alpha = fakeHandle(fakeOAuth())
    b.registry.notify('alpha')
    await vi.waitFor(() => { expect(b.attempt()?.phase).toBe('cancelled') })

    const disposable = await bench()
    await disposable.service.startAuthorization('alpha')
    await disposable.ctx.fiber.dispose()
    expect(disposable.routes).toHaveLength(0)
    await vi.waitFor(() => { expect(disposable.oauth.flows[0]!.dispose).toHaveBeenCalled() })

    // A settled attempt is left alone: only pending work is withdrawn.
    const settled = await bench()
    await settled.service.startAuthorization('alpha')
    await settled.callback('?code=c-1&state=' + settled.state())
    await vi.waitFor(() => { expect(settled.attempt()?.phase).toBe('authorized') })
    const releases = settled.oauth.flows[0]!.dispose.mock.calls.length
    await settled.ctx.fiber.dispose()
    expect(settled.oauth.flows[0]!.dispose.mock.calls.length).toBe(releases)
  })
})
