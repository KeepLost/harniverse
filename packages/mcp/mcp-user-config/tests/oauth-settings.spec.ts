/**
 * OAuth settings of the `mcp` namespace: both spellings of the `oauth` field
 * reach the mounted owner, and an OAuth entry the owner could not run with
 * is refused at the settings write before any child mounts.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionsOf } from '@deepseek-ai/dsh-mcp-client'
import type { UserMcpServerConfig } from '../src/index.ts'
import * as bridgeModule from '../src/index.ts'
import type { McpAuthorizationStart, McpManagementStatusRow } from '../src/types.ts'
import type { McpProbeResult } from '@deepseek-ai/dsh-mcp-client/types'
import { OAuthFixture } from '../../mcp-client/tests/oauth-fixture-server.ts'
import { authorize, MemoryCredentials, REDIRECT_URI, redirectOf } from '../../mcp-client/tests/oauth-harness.ts'

/** The management Remote as the settings page reaches it. */
interface ManagementFace {
  status(): McpManagementStatusRow[]
  probe(serverId: string): Promise<McpProbeResult>
  startAuthorization(serverId: string, redirectOrigin?: string): Promise<McpAuthorizationStart>
  cancelAuthorization(serverId: string): Promise<void>
  signOut(serverId: string): Promise<void>
}

class MemorySettings extends SettingsProvider {
  override readonly writable = true
  private rawDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.rawDocument))
  }

  protected persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.rawDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

function httpServer(fixture: OAuthFixture, overrides: Partial<UserMcpServerConfig> = {}): UserMcpServerConfig {
  return {
    id: 'web',
    enabled: true,
    transport: 'streamable-http',
    serverName: 'web',
    url: fixture.url,
    args: [],
    env: {},
    cwd: '',
    headers: {},
    oauth: true,
    toolCallTimeoutMs: 5_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 3 },
    ...overrides,
  }
}

describe('mcp-user-config oauth settings', () => {
  let ctx: Context
  let fixture: OAuthFixture
  let store: MemoryCredentials
  let provider: (Fiber & PromiseLike<Fiber>) | undefined

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    fixture = await OAuthFixture.start()
    store = new MemoryCredentials()
    ctx.provide('credentials', store)
    provider = ctx.plugin({
      name: bridgeModule.name,
      inject: bridgeModule.inject,
      Config: bridgeModule.Config,
      apply: bridgeModule.apply,
    }, { role: 'provider', servers: [] })
    await provider
  })

  afterEach(async () => {
    await provider?.dispose()
    await ctx.fiber.dispose()
    await fixture.close()
  })

  function write(servers: UserMcpServerConfig[]): Promise<unknown> {
    return (ctx.get('settings') as MemorySettings).replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers })
  }

  it('resolves both oauth spellings in the settings schema', () => {
    const resolved = bridgeModule.SettingsConfig({
      servers: [
        { id: 'plain', transport: 'streamable-http', serverName: 'plain', url: 'https://mcp.example/mcp', oauth: true },
        { id: 'detailed', transport: 'streamable-http', serverName: 'detailed', url: 'https://mcp.example/mcp', oauth: { clientId: 'app' } },
        { id: 'off', transport: 'streamable-http', serverName: 'off', url: 'https://mcp.example/mcp' },
      ],
    } as never)
    expect(resolved.servers.map(server => server.oauth)).toEqual([
      true,
      { clientId: 'app', requestTimeoutMs: 10_000, authorizationTimeoutMs: 600_000 },
      undefined,
    ])
  })

  it('carries oauth from the settings write to the mounted owner', async () => {
    await write([httpServer(fixture)])
    await vi.waitFor(() => {
      expect(connectionsOf(ctx)?.get('web')?.status()).toMatchObject({
        state: 'waiting-authorization',
        authorization: { state: 'waiting-authorization', reason: 'missing' },
      })
    })
    expect(fixture.requests).toEqual([])

    // A changed oauth signature remounts the owner: the new session keeps the grant only for the same options.
    fixture.configure({ allowedClientIds: ['app-1'], allowedRedirectUris: [REDIRECT_URI] })
    await write([httpServer(fixture, { oauth: { clientId: 'app-1', scope: 'mcp:tools', authorizationTimeoutMs: 120_000 } })])
    await vi.waitFor(() => { expect(connectionsOf(ctx)?.get('web')?.oauth?.authorizationTimeoutMs).toBe(120_000) })
    await authorize(connectionsOf(ctx)!.get('web')!.oauth!, REDIRECT_URI)
    connectionsOf(ctx)!.get('web')!.oauth!.resume()
    await vi.waitFor(() => { expect(connectionsOf(ctx)!.get('web')?.status().state).toBe('connected') })
    await write([httpServer(fixture, { oauth: { scope: 'mcp:tools mcp:admin' } })])
    await vi.waitFor(() => {
      expect(connectionsOf(ctx)?.get('web')?.status()).toMatchObject({
        state: 'waiting-authorization',
        authorization: { state: 'waiting-authorization', reason: 'binding' },
      })
    })
  })

  it('accepts OAuth on an HTTPS endpoint and on every loopback spelling', async () => {
    // Without a stored grant the owner never opens a connection, so these endpoints are never contacted.
    const loopbackName = `http://localhost:${new URL(fixture.url).port}/mcp`
    for (const url of ['https://127.0.0.1:9/mcp', loopbackName, 'http://[::1]:9/mcp', fixture.url]) {
      await write([httpServer(fixture, { url })])
      await vi.waitFor(() => { expect(connectionsOf(ctx)?.get('web')?.status().state).toBe('waiting-authorization') })
      expect(fixture.requests).toEqual([])
    }
  })

  it.each([
    ['an Authorization header', { oauth: true, headers: { authorization: 'Bearer x' } }, /oauth cannot be combined with an Authorization header/],
    ['a stdio transport', { transport: 'stdio', command: 'echo', url: undefined, oauth: true }, /oauth is only valid for streamable-http/],
    ['an unknown oauth option', { oauth: { bogus: 1 } as never }, /unknown key "mcp\.servers\[0\]\.oauth\.bogus"/],
    ['an empty oauth field', { oauth: null as never }, /oauth must be true or an options object/],
    ['a blank client id', { oauth: { clientId: ' ' } }, /oauth\.clientId must not be blank/],
    ['an out-of-range request budget', { oauth: { requestTimeoutMs: MAX_TIMER_DELAY_MS + 1 } }, /requestTimeoutMs/],
    ['a non-integer authorization budget', { oauth: { authorizationTimeoutMs: 1.5 } as never }, /authorizationTimeoutMs/],
    ['a plain-HTTP remote endpoint', { url: 'http://mcp.example/mcp' }, /url: OAuth requires HTTPS except for loopback HTTP/],
    ['a non-HTTP endpoint', { url: 'ftp://127.0.0.1/mcp' }, /url: OAuth requires HTTPS except for loopback HTTP/],
    ['an unparsable endpoint', { url: 'mcp.example' }, /url: OAuth requires HTTPS except for loopback HTTP/],
  ] as const)('rejects oauth combined with %s before mounting any owner', async (_name, overrides, message) => {
    await expect(write([httpServer(fixture, overrides as Partial<UserMcpServerConfig>)])).rejects.toThrow(message)
    expect(connectionsOf(ctx)?.get('web')).toBeUndefined()
  })
})

describe('mcp-user-config OAuth through the management Remote', () => {
  let ctx: Context
  let fixture: OAuthFixture
  let store: MemoryCredentials
  let management: ManagementFace
  let routes: Array<{ kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }>
  const changes: number[] = []

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    fixture = await OAuthFixture.start()
    store = new MemoryCredentials()
    ctx.provide('credentials', store)
    routes = []
    ctx.provide('webServer', {
      protocol: 'http:',
      host: '127.0.0.1',
      port: 3080,
      register(route: (typeof routes)[number]) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    })
    await ctx.plugin({ name: bridgeModule.name, inject: bridgeModule.inject, Config: bridgeModule.Config, apply: bridgeModule.apply }, { role: 'provider', servers: [] })
    management = ctx.get('mcpManagement') as ManagementFace
    ctx.on('mcpManagement/fleet-changed', () => { changes.push(1) })
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await fixture.close()
  })

  function request(url: string): IncomingMessage {
    const incoming = Readable.from([]) as unknown as IncomingMessage
    Object.assign(incoming, { url, method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } })
    return incoming
  }

  function response(): { response: ServerResponse; status?: number; body?: string } {
    const state: { status?: number; body?: string } = {}
    const chunks: Buffer[] = []
    const server = Object.assign(new EventEmitter(), {
      writeHead(status: number) {
        state.status = status
        return this
      },
      end(value?: string) {
        if (value !== undefined) chunks.push(Buffer.from(value))
        if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
        return this
      },
    }) as unknown as ServerResponse
    return Object.assign(state, { response: server })
  }

  it('authorizes the server from the Remote, answers the browser redirect, and connects', async () => {
    await (ctx.get('settings') as MemorySettings).replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers: [httpServer(fixture)] })
    await vi.waitFor(() => {
      expect(management.status()[0]).toMatchObject({
        state: 'waiting-authorization',
        authorization: { state: 'waiting-authorization', reason: 'missing' },
      })
    })
    expect(await management.probe('web')).toMatchObject({ ok: false, message: 'MCP OAuth requires authorization: missing' })

    const { authorizationUrl, attempt } = await management.startAuthorization('web')
    expect(authorizationUrl.startsWith(`${fixture.baseUrl}/authorize?`)).toBe(true)
    expect(attempt.phase).toBe('waiting-browser')
    expect(routes.map(route => [route.kind, route.path])).toEqual([['exact', `/mcp/oauth/callback/${createHash('sha256').update('web').digest('hex')}`]])
    const callback = await redirectOf(authorizationUrl)
    expect(callback.origin + callback.pathname).toBe(`http://127.0.0.1:3080${routes[0]!.path}`)
    const changesBefore = changes.length
    const answer = response()
    await routes[0]!.handler(request(`${callback.pathname}${callback.search}`), answer.response)
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('Authorization received. You can close this page and check the connection in Harniverse.')
    expect(answer.body).toContain('已收到授权')
    expect(answer.body).not.toContain(callback.searchParams.get('code')!)
    await vi.waitFor(() => {
      expect(management.status()[0]).toMatchObject({
        state: 'connected',
        authorization: { state: 'authorized' },
        attempt: { phase: 'authorized', id: attempt.id },
        tools: [{ name: 'ping' }],
      })
    })
    expect(changes.length - changesBefore).toBeGreaterThanOrEqual(3)
    expect(routes).toHaveLength(0)
    expect(await management.probe('web')).toMatchObject({ ok: true, toolNames: ['ping'] })
    expect(JSON.stringify(management.status())).not.toContain('acc-')

    await management.signOut('web')
    await vi.waitFor(() => {
      expect(management.status()[0]).toMatchObject({ state: 'waiting-authorization', authorization: { state: 'waiting-authorization', reason: 'missing' } })
    })
    expect(store.values.size).toBe(0)
    expect(await management.probe('web')).toMatchObject({ ok: false, message: 'MCP OAuth requires authorization: missing' })
  })

  it('cancels an attempt that is still discovering the authorization server', async () => {
    fixture.configure({ hangPaths: ['/register'] })
    await (ctx.get('settings') as MemorySettings).replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers: [httpServer(fixture)] })
    await vi.waitFor(() => { expect(management.status()[0]?.state).toBe('waiting-authorization') })
    const starting = management.startAuthorization('web')
    await vi.waitFor(() => { expect(management.status()[0]!.attempt?.phase).toBe('starting') })
    await management.cancelAuthorization('web')
    await expect(starting).rejects.toThrow('cancelled')
    expect(management.status()[0]!.attempt?.phase).toBe('cancelled')
    expect(routes).toHaveLength(0)
  })

  it('cancels through the Remote, rejects an untrusted redirect origin, and names a disabled server', async () => {
    await (ctx.get('settings') as MemorySettings).replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers: [httpServer(fixture)] })
    await vi.waitFor(() => { expect(management.status()[0]?.state).toBe('waiting-authorization') })
    await expect(management.startAuthorization('web', 'https://evil.example')).rejects.toThrow('is not a serving authority of this deployment')
    expect(routes).toHaveLength(0)
    await management.startAuthorization('web')
    await management.cancelAuthorization('web')
    expect(management.status()[0]!.attempt).toMatchObject({ phase: 'cancelled' })
    expect(routes).toHaveLength(0)

    await (ctx.get('settings') as MemorySettings).replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers: [httpServer(fixture, { enabled: false })] })
    await vi.waitFor(() => { expect(management.status()[0]?.state).toBe('disabled') })
    await expect(management.startAuthorization('web')).rejects.toThrow('mcp-user-config: server "web" has no live connection; enable it before authorizing')
    await expect(management.signOut('web')).rejects.toThrow('mcp-user-config: server "web" has no live connection; enable it first')
  })
})
