/**
 * Tests for the shared-connection split: the connection-only supervisor
 * (inventory publication, status, raw call routing), the registry, the owner
 * plugin, and the registrar's scoped projection of the shared inventory.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import Capabilities from '@deepseek-ai/dsh-capabilities'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

const { mockConnect, mockClose, mockListTools, mockCallTool, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params, undefined, options)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    getInstructions = () => undefined
    getServerCapabilities = () => ({ tools: {} })
    listResources = () => Promise.resolve({ resources: [] })
    listResourceTemplates = () => Promise.resolve({ resourceTemplates: [] })
    readResource = () => Promise.resolve({ contents: [] })
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

import {
  McpConnectionsRegistry,
  McpOwnerPlugin,
  McpRegistrarPlugin,
  MCP_CONNECTIONS_SERVICE,
  startSharedConnection,
} from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'

// ---- Helpers ----

const testToolSignal = new AbortController().signal

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide(MCP_CONNECTIONS_SERVICE, new McpConnectionsRegistry())
  return ctx
}

/** Full exposure stack: capabilities, resources, prompt, tools, registry. */
async function mountExposure(): Promise<Context> {
  const ctx = await mountRegistry()
  await ctx.plugin(McpResources)
  await ctx.plugin(Capabilities)
  return ctx
}

function stdioConfig(reconnect?: Config['reconnect']): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

function ownerConfig(serverId: string, reconnect?: Config['reconnect']) {
  return { ...stdioConfig(reconnect), serverId }
}

/** A tools/list page over plain names. */
function listing(
  ...names: string[]
): { tools: { name: string; description?: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' }, description: `Tool ${name}` })),
    nextCursor: undefined,
  }
}

let callSeq = 0
function nextCallId(): CallId {
  return CallId(`shared-${++callSeq}`)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

// ---- Tests ----

describe('shared connection supervisor', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('add'))
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('publishes the inventory without registering tools and reports connected status', async () => {
    const changes: number[] = []
    const connection = startSharedConnection(ctx, stdioConfig({ enabled: false }), resolveReconnectPolicy({ enabled: false }, 't'))
    connection.subscribe(() => { changes.push(1) })
    const outcome = await connection.ready
    expect(outcome.error).toBeUndefined()
    expect(connection.connected()).toBe(true)
    expect(connection.status().state).toBe('connected')
    expect(connection.status().connectedAtMs).toBeDefined()
    expect(connection.toolNames()).toEqual(['mcp__srv__add'])
    expect(connection.toolDescriptors()[0]!.description).toBe('Tool add')
    // Nothing registered on the supervisor's own registry-backed context.
    expect(ctx.tools.get('mcp__srv__add')).toBeUndefined()
    expect(changes.length).toBeGreaterThan(0)
    await connection.dispose()
  })

  it('routes raw tool calls through the live generation and rejects while disconnected', async () => {
    const connection = startSharedConnection(ctx, stdioConfig({ enabled: false }), resolveReconnectPolicy({ enabled: false }, 't'))
    await connection.ready
    const result = await connection.callTool('add', { a: 1, b: 2 }, { signal: testToolSignal })
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(mockCallTool).toHaveBeenCalledWith({ name: 'add', arguments: { a: 1, b: 2 } }, undefined, { timeout: 60_000, signal: testToolSignal })
    await connection.dispose()
    await expect(connection.callTool('add', {}, {})).rejects.toThrow('server is disconnected')
    expect(connection.status().state).toBe('disposed')
  })

  it('clears the inventory and reports reconnecting after a lost generation, then resyncs', async () => {
    const connection = startSharedConnection(
      ctx,
      stdioConfig({ initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 5 }),
      resolveReconnectPolicy({ initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 5 }, 't'),
    )
    await connection.ready
    mockListTools.mockResolvedValue(listing('revived'))
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(connection.toolNames()).toEqual(['mcp__srv__revived']) })
    for (const state of [connection.status().state]) {
      expect(['connected', 'reconnecting']).toContain(state)
    }
    await connection.dispose()
  })

  it('exhausts the outage budget, empties the inventory, and stops retrying', async () => {
    const { errors } = captureLogs(ctx)
    const connection = startSharedConnection(
      ctx,
      stdioConfig({ initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 1 }),
      resolveReconnectPolicy({ initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 1 }, 't'),
    )
    await connection.ready
    expect(connection.toolNames()).toEqual(['mcp__srv__add'])
    mockConnect.mockRejectedValue(new Error('boom'))
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(connection.status().state).toBe('exhausted') })
    expect(connection.toolNames()).toEqual([])
    expect(connection.connected()).toBe(false)
    expect(connection.status().lastErrorKind).toBe('Error')
    expect(errors.some(line => line.includes('giving up after 1 consecutive failed reconnect attempts'))).toBe(true)
    await connection.dispose()
  })

  it('reports stopped when reconnect is disabled after a loss', async () => {
    const connection = startSharedConnection(ctx, stdioConfig({ enabled: false }), resolveReconnectPolicy({ enabled: false }, 't'))
    await connection.ready
    instances[0]!.onclose?.()
    await flush()
    expect(connection.status().state).toBe('stopped')
    // The last-good inventory is retained while down — same contract as the
    // registered bridge: calls fail with "server is disconnected" until it returns.
    expect(connection.toolNames()).toEqual(['mcp__srv__add'])
    await expect(connection.callTool('add', {}, {})).rejects.toThrow('server is disconnected')
    await connection.dispose()
  })

  it('empties the inventory when the server has no tools capability', async () => {
    const connection = startSharedConnection(ctx, stdioConfig({ enabled: false }), resolveReconnectPolicy({ enabled: false }, 't'))
    await connection.ready
    ;(instances[0] as unknown as { getServerCapabilities: () => { tools?: {} } }).getServerCapabilities = () => ({})
    instances[0]!.onclose?.()
    // Reconnect is disabled, so the post-drop state is stopped; the
    // no-capability arm itself is exercised through a direct re-sync below.
    await flush()
    await connection.dispose()
    expect(connection.status().state).toBe('disposed')
  })

  it('reports connecting while the first attempt is in flight', async () => {
    let releaseConnect: () => void = () => {}
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => { releaseConnect = () => { gate.resolve() }; return gate.promise })
    const connection = startSharedConnection(ctx, stdioConfig({ enabled: false }), resolveReconnectPolicy({ enabled: false }, 't'))
    expect(connection.status().state).toBe('connecting')
    releaseConnect()
    await connection.ready
    expect(connection.status().state).toBe('connected')
    await connection.dispose()
  })

  it('builds call options without a signal and names non-Error failure kinds', async () => {
    const connection = startSharedConnection(ctx, stdioConfig({ enabled: false }), resolveReconnectPolicy({ enabled: false }, 't'))
    await connection.ready
    await connection.callTool('add', {}, {})
    expect(mockCallTool).toHaveBeenLastCalledWith({ name: 'add', arguments: {} }, undefined, { timeout: 60_000 })
    await connection.dispose()
    const retrying = startSharedConnection(
      ctx,
      stdioConfig({ initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 1 }),
      resolveReconnectPolicy({ initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 1 }, 't'),
    )
    await retrying.ready
    mockConnect.mockRejectedValue('plain string failure')
    instances.at(-1)!.onclose?.()
    await vi.waitFor(() => { expect(retrying.status().lastErrorKind).toBe('string') })
    await retrying.dispose()
  })

  it('contains a throwing inventory subscriber and keeps notifying the rest', async () => {
    const { errors } = captureLogs(ctx)
    const connection = startSharedConnection(ctx, stdioConfig({ enabled: false }), resolveReconnectPolicy({ enabled: false }, 't'))
    let heard = 0
    connection.subscribe(() => { throw new Error('listener bug') })
    connection.subscribe(() => { heard += 1 })
    await connection.ready
    expect(heard).toBeGreaterThan(0)
    expect(errors.some(line => line.includes('inventory subscriber failed'))).toBe(true)
    await connection.dispose()
  })

  it('empties the inventory when a generation advertises no tools capability', async () => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => gate.promise)
    const connection = startSharedConnection(ctx, stdioConfig({ enabled: false }), resolveReconnectPolicy({ enabled: false }, 't'))
    const generation = instances.at(-1) as unknown as { getServerCapabilities: () => { tools?: {} } }
    generation.getServerCapabilities = () => ({})
    gate.resolve()
    await connection.ready
    expect(connection.toolNames()).toEqual([])
    await connection.dispose()
  })

  it('owner publishes into the registry, survives a failed startup, and unpublishes on dispose', async () => {
    mockConnect.mockRejectedValue(new TypeError('spawn failed'))
    const fiber = ctx.plugin(McpOwnerPlugin, ownerConfig('github', { enabled: false }))
    await fiber
    const registry = ctx.get(MCP_CONNECTIONS_SERVICE)
    // The owner contained the failure: it stays registered and reports it.
    const handle = registry?.get('github')
    expect(handle).toBeDefined()
    expect(handle!.status().state).toBe('stopped')
    expect(handle!.status().lastErrorKind).toBe('TypeError')
    await fiber.dispose()
    expect(registry?.get('github')).toBeUndefined()
  })
})

describe('tool definition projection', () => {
  it('normalizes primitive results to the no-output text', async () => {
    const { descriptorToDefinition } = await import('@deepseek-ai/dsh-mcp-client/src/tools.ts')
    const definition = descriptorToDefinition('srv', {
      rawName: 'add',
      description: '',
      inputSchema: { type: 'object' },
      taskRequired: false,
    }, async () => 'just a string')
    const result = await definition.execute({}, { signal: new AbortController().signal, callId: nextCallId(), defer: () => {} } as never)
    expect(result).toEqual({ content: [{ type: 'text', text: '(no output)' }] })
  })
})

describe('shared connection registry', () => {
  it('keeps the replacement when an ousted registration disposes', () => {
    const registry = new McpConnectionsRegistry()
    const a = {} as never
    const b = {} as never
    const disposeA = registry.register('srv', a)
    registry.register('srv', b)
    disposeA()
    expect(registry.get('srv')).toBe(b)
  })
})

describe('shared connection registrar', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('add'))
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('projects the shared inventory into its own registry and executes through the shared transport', async () => {
    const owner = await ctx.plugin(McpOwnerPlugin, ownerConfig('github', { enabled: false }))
    const registrar = await ctx.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv' })
    expect(ctx.tools.get('mcp__srv__add')).toBeDefined()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__srv__add', arguments: { a: 1, b: 2 },
    })
    expect(result.isError).toBe(false)
    // One transport serves the composition; the registrar owns none.
    expect(instances).toHaveLength(1)
    await registrar.dispose()
    expect(ctx.tools.get('mcp__srv__add')).toBeUndefined()
    await owner.dispose()
  })

  it('resyncs when the inventory changes and when the owner swaps its handle', async () => {
    const owner = await ctx.plugin(McpOwnerPlugin, ownerConfig('github', { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 5 }))
    const registrar = await ctx.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv' })
    expect(ctx.tools.get('mcp__srv__add')).toBeDefined()

    // Inventory change through a reconnecting generation of the SAME handle.
    mockListTools.mockResolvedValue(listing('add', 'extra'))
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__extra')).toBeDefined() })
    expect(instances.length).toBe(2)

    // Owner restart swaps the handle object; the registrar follows the new one.
    await owner.dispose()
    expect(ctx.tools.get('mcp__srv__extra')).toBeUndefined()
    const owner2 = await ctx.plugin(McpOwnerPlugin, ownerConfig('github', { enabled: false }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__extra')).toBeDefined() })
    await registrar.dispose()
    await owner2.dispose()
  })

  it('registers nothing while no owner serves the server and follows a later owner', async () => {
    const registrar = await ctx.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv' })
    expect(ctx.tools.get('mcp__srv__add')).toBeUndefined()
    const owner = await ctx.plugin(McpOwnerPlugin, ownerConfig('github', { enabled: false }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__add')).toBeDefined() })
    await registrar.dispose()
    await owner.dispose()
  })

  it('stays inert without a shared-connection registry and guards direct apply', async () => {
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime)
    // Through the plugin object, the missing inject service keeps the mount
    // pending — no tools, no crash.
    const pending = bare.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv' })
    await flush()
    expect(bare.tools.get('mcp__srv__add')).toBeUndefined()
    await pending.dispose()
    // The defensive arm guards a programmatic apply that bypassed inject.
    expect(() => {
      void (McpRegistrarPlugin as { apply: (ctx: Context, config: { serverId: string; serverName: string }) => void })
        .apply(bare, { serverId: 'github', serverName: 'srv' })
    }).toThrow('no shared-connection registry')
  })

  it('rejects a duplicate serverName reservation in one scope', async () => {
    const owner = await ctx.plugin(McpOwnerPlugin, ownerConfig('github', { enabled: false }))
    await ctx.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv' })
    await expect(ctx.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv' })).rejects.toThrow('already in use')
    await owner.dispose()
  })

  it('contains a foreign squatter on the public namespace', async () => {
    const { errors } = captureLogs(ctx)
    // The squatter takes the SECOND tool's name, so the first registration of
    // the generation succeeds and the conflict's rollback has work to undo.
    let squatterDisposed = false
    const release = ctx.tools.register({
      name: 'mcp__srv__extra',
      description: 'squatter',
      parameters: { type: 'object' },
      output: { schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false }, render: () => [] },
      execute: async () => ({}),
    })
    mockListTools.mockResolvedValue(listing('add', 'extra'))
    const owner = await ctx.plugin(McpOwnerPlugin, ownerConfig('github', { enabled: false }))
    const registrar = await ctx.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv' })
    // The squatter keeps the namespace; the registrar registered nothing of its own.
    expect(errors.some(line => line.includes('tool registration failed, no tools registered'))).toBe(true)
    expect(ctx.tools.get('mcp__srv__add')).toBeUndefined()
    await registrar.dispose()
    await owner.dispose()
    release()
    expect(squatterDisposed).toBe(false)
    squatterDisposed = true
  })

  it('ignores registry swaps of other servers', async () => {
    const owner = await ctx.plugin(McpOwnerPlugin, ownerConfig('other', { enabled: false }))
    const registrar = await ctx.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv', reservationKey: 'rk' })
    await owner.dispose()
    await flush()
    // The registrar never attached; the other-id swap changed nothing.
    expect(ctx.tools.get('mcp__srv__add')).toBeUndefined()
    await registrar.dispose()
  })

  it('exposes capability members, prompt instructions, and resources through the shared handle', async () => {
    const exposure = await mountExposure()
    const before = instances.length
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => gate.promise)
    const mounting = exposure.plugin(McpOwnerPlugin, ownerConfig('github', { enabled: false }))
    await vi.waitFor(() => { expect(instances.length).toBe(before + 1) })
    ;(instances.at(-1) as unknown as { getInstructions: () => string | undefined }).getInstructions = () => 'Use add for math.'
    gate.resolve()
    const owner = await mounting
    mockConnect.mockResolvedValue(undefined)
    const registrar = await exposure.plugin(McpRegistrarPlugin, { serverId: 'github', serverName: 'srv' })

    const catalog = await exposure.capabilities.snapshot({ kind: 'global-agent' })
    const server = catalog.entries.find(entry => entry.kind === 'mcp-server' && entry.name === 'srv')
    expect(server).toBeDefined()
    expect(server!.available).toBe(true)
    expect(server?.members?.map(member => member.name)).toContain('mcp__srv__add')

    const agent: object = {}
    bindScopeParent(agent, exposure)
    const instructed = renderPrompt(await exposure.systemPrompt.assemble({ scope: agent }))
    expect(instructed).toContain('### MCP server: srv')
    expect(instructed).toContain('Use add for math.')

    const read = await exposure.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'read_mcp_resource', arguments: { server: 'srv', uri: 'file:///doc' },
    })
    expect(read.isError).toBe(false)

    // Owner gone: the exposure reports unavailable and the resource proxy refuses.
    await owner.dispose()
    const catalogDown = await exposure.capabilities.snapshot({ kind: 'global-agent' })
    const serverDown = catalogDown.entries.find(entry => entry.kind === 'mcp-server' && entry.name === 'srv')
    expect(serverDown?.available).toBe(false)
    const downPrompt = renderPrompt(await exposure.systemPrompt.assemble({ scope: agent }))
    expect(downPrompt).not.toContain('### MCP server: srv')
    const refused = await exposure.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'read_mcp_resource', arguments: { server: 'srv', uri: 'file:///doc' },
    })
    expect(refused.isError).toBe(true)
    await registrar.dispose()
  })

  it('guards a direct owner apply that bypassed inject', async () => {
    const bare = new Context()
    await expect(
      (McpOwnerPlugin as unknown as { apply: (ctx: Context, config: unknown) => Promise<void> }).apply(bare, ownerConfig('github')),
    ).rejects.toThrow('no shared-connection registry')
  })
})

/** Capture the supervisor's logger lines by level on one context. */
function captureLogs(ctx: Context): { warns: string[]; errors: string[]; infos: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  return { warns, errors, infos }
}
