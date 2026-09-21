/**
 * Tests for the mcp-client plugin's `apply` lifecycle entry point.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Capabilities from '@deepseek-ai/dsh-capabilities'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources, { MAX_RESOURCE_RESULT_BYTES } from '@deepseek-ai/dsh-mcp-resources'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import { mcpResourceMemberId, mcpResourceTemplateMemberId } from '@deepseek-ai/dsh-mcp-client/src/resource-contract.ts'
import { MAX_RESOURCE_ITEMS, resolveReconnectPolicy, startConnection } from '../src/connection.ts'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const {
  mockConnect,
  mockClose,
  mockListTools,
  mockCallTool,
  mockSetNotificationHandler,
  mockGetInstructions,
  mockGetServerCapabilities,
  mockListResources,
  mockListResourceTemplates,
  mockReadResource,
  MockClient,
} = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockGetInstructions = vi.fn<() => string | undefined>()
  const mockGetServerCapabilities = vi.fn<() => Record<string, unknown> | undefined>()
  const mockListResources = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockListResourceTemplates = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockReadResource = vi.fn<(_params: { uri: string }) => Promise<unknown>>()
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
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    callTool = mockCallTool
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    getInstructions = mockGetInstructions
    getServerCapabilities = mockGetServerCapabilities
    listResources = mockListResources
    listResourceTemplates = mockListResourceTemplates
    readResource = mockReadResource
  }
  return {
    mockConnect,
    mockClose,
    mockListTools,
    mockCallTool,
    mockSetNotificationHandler,
    mockGetInstructions,
    mockGetServerCapabilities,
    mockListResources,
    mockListResourceTemplates,
    mockReadResource,
    MockClient,
  }
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

// vi.mock is hoisted above static imports, so the module under test sees the
// mocked SDK even through a static import.
import { apply, name, inject, Config as ConfigSchema } from '@deepseek-ai/dsh-mcp-client/src/index.ts'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

async function mountCapabilityRegistry(): Promise<Context> {
  const ctx = await mountRegistry()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(Capabilities)
  return ctx
}

function sleep(ms: number): Promise<void> {
  // Annotated binding (not withResolvers<void>()): the tests lint layer runs
  // no-invalid-void-type with default options, which rejects the explicit
  // type argument in call position but accepts the inferred form.
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

const stdioConfig: Config = {
  transport: 'stdio',
  serverName: 'srv',
  command: 'echo',
  args: [],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

// ---- Tests ----

describe('mcp-client plugin module exports', () => {
  it('exports name, inject, and Config', () => {
    expect(name).toBe('mcp-client')
    expect(inject).toEqual(['tools'])
    expect(ConfigSchema).toBeDefined()
  })

  it('Config schema rejects a missing serverName', () => {
    expect(() => ConfigSchema({
      transport: 'stdio',
      command: 'echo',
    } as never)).toThrow()
  })

  it('Config schema rejects an invalid serverName', () => {
    // schemastery unions wrap branch errors in a generic "expected ... but got"
    // message, so assert the throw, not the inner pattern text.
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'bad name!',
      command: 'echo',
    } as never)).toThrow()
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'x'.repeat(33),
      command: 'echo',
    } as never)).toThrow()
  })

  it('Config schema accepts a valid serverName', () => {
    const resolved = ConfigSchema({
      transport: 'stdio',
      serverName: 'github-prod_1',
      command: 'echo',
    } as never)
    expect(resolved.serverName).toBe('github-prod_1')
  })

  it('Config schema materializes reconnect defaults and merges partial overrides', () => {
    const omitted = ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
    } as never)
    expect(omitted.reconnect).toEqual({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 })

    const partial = ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      reconnect: { initialDelayMs: 100 },
    } as never)
    expect(partial.reconnect).toEqual({ enabled: true, initialDelayMs: 100, maxDelayMs: 30_000, maxAttempts: 10 })
  })

  it('Config schema rejects an invalid reconnect block', () => {
    // schemastery unions wrap branch errors, so assert the throw only.
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      reconnect: { maxAttempts: 0 },
    } as never)).toThrow()
  })
})

describe('apply (plugin lifecycle)', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    mockGetInstructions.mockReturnValue(undefined)
    mockGetServerCapabilities.mockReturnValue({ tools: {} })
    mockListResources.mockResolvedValue({ resources: [] })
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [] })
    mockReadResource.mockResolvedValue({ contents: [] })
    ctx = await mountRegistry()
  })

  it('connects, syncs tools under the namespace, and registers a notification handler', async () => {
    await apply(ctx, stdioConfig)

    expect(mockConnect).toHaveBeenCalled()
    expect(mockListTools).toHaveBeenCalled()
    expect(mockSetNotificationHandler).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(ctx.tools.get('remote')).toBeUndefined()
  })

  it('lets a Profile unload one MCP server from its assembled tool exposure', async () => {
    const managed = await mountCapabilityRegistry()
    await apply(managed, stdioConfig)
    const standingKey = { profile: 'standard' }
    const standing = createScope(managed, standingKey)
    const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
    const view = { scope: standingKey }
    const catalog = await managed.capabilities.snapshot(target, view)
    const server = catalog.entries.find(entry => entry.kind === 'mcp-server')
    expect(server).toMatchObject({ name: 'srv', manageable: true, available: true })

    const plan = await managed.capabilities.plan(target, [
      { capabilityId: server!.id, selection: 'unload' },
    ], catalog.revision, view)
    expect(plan.blockers).toEqual([])
    await managed.capabilities.apply(plan.id, catalog.revision)
    managed.capabilities.mountComposition(standing.ctx, (await managed.capabilities.snapshot(target, view)).entries)

    expect(managed.tools.schemas(standingKey).map(tool => tool.name)).not.toContain('mcp__srv__remote')

    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await handler()
    expect(managed.tools.schemas(standingKey).map(tool => tool.name)).not.toContain('mcp__srv__updated')
    expect(managed.tools.schemas().map(tool => tool.name)).toContain('mcp__srv__updated')
    await managed.fiber.dispose()
  })

  it('lets a Profile expose only selected tools from a shared MCP server', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: 'read', description: 'Read', inputSchema: { type: 'object' } },
        { name: 'write', description: 'Write', inputSchema: { type: 'object' } },
      ],
      nextCursor: undefined,
    })
    const managed = await mountCapabilityRegistry()
    await apply(managed, stdioConfig)
    const standingKey = { profile: 'selected-tools' }
    const standing = createScope(managed, standingKey)
    const target = { kind: 'agent-profile', agentProfile: 'selected-tools' } as const
    const view = { scope: standingKey }
    const catalog = await managed.capabilities.snapshot(target, view)
    const server = catalog.entries.find(entry => entry.kind === 'mcp-server')!
    const read = server.memberEntries?.find(member => member.name === 'mcp__srv__read')
    expect(server.memberEntries?.map(member => member.name)).toEqual(['mcp__srv__read', 'mcp__srv__write'])

    const plan = await managed.capabilities.plan(target, [{
      capabilityId: server.id,
      members: [read!.id],
    }], catalog.revision, view)
    expect(plan.blockers).toEqual([])
    await managed.capabilities.apply(plan.id, catalog.revision)
    managed.capabilities.mountComposition(standing.ctx, (await managed.capabilities.snapshot(target, view)).entries)

    expect(managed.tools.schemas(standingKey).map(tool => tool.name)).toContain('mcp__srv__read')
    expect(managed.tools.schemas(standingKey).map(tool => tool.name)).not.toContain('mcp__srv__write')
    await managed.fiber.dispose()
  })

  it('keeps the Cordis plugin loading until initial discovery publishes its tools', async () => {
    const connection: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(async () => {
      await connection.promise
    })
    const fiber = ctx.plugin({ name: 'mcp-client-lifecycle', inject, apply }, stdioConfig)
    let activated = false
    const activation = Promise.resolve(fiber).then(() => { activated = true })

    await vi.waitFor(() => { expect(mockConnect).toHaveBeenCalled() })
    expect(activated).toBe(false)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    connection.resolve()
    await activation
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await fiber.dispose()
  })

  it('rejects a duplicate serverName at load and leaves the first instance intact', async () => {
    await apply(ctx, stdioConfig)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    await expect(apply(ctx, stdioConfig)).rejects.toThrow(/serverName "srv" is already in use/)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('allows the same public serverName for explicitly separate owners', async () => {
    await apply(ctx, { ...stdioConfig, reservationKey: 'profile-a' })
    await expect(apply(ctx, { ...stdioConfig, reservationKey: 'profile-b' })).resolves.toBeUndefined()
  })

  it('releases the serverName reservation on dispose', async () => {
    const first = new Context()
    await first.plugin(SystemPrompt)
    await first.plugin(ToolRuntime)
    await apply(first, stdioConfig)

    await first.fiber.dispose()
    await sleep(50)

    // Same root would conflict; a fresh app root reuses the name freely,
    // and the disposed instance no longer holds the reservation on its root.
    const second = new Context()
    await second.plugin(SystemPrompt)
    await second.plugin(ToolRuntime)
    await expect(apply(second, stdioConfig)).resolves.toBeUndefined()
    await second.fiber.dispose()
  })

  it('scopes serverName reservations per app root', async () => {
    const other = await mountRegistry()

    const first = apply(ctx, stdioConfig)
    // Same serverName on a DIFFERENT root is fine.
    const second = apply(other, stdioConfig)
    await Promise.all([first, second])

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(other.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('logs error and registers no tools when connect fails; dispose closes the client', async () => {
    mockConnect.mockRejectedValue(new Error('connection refused'))

    await apply(ctx, stdioConfig)

    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    // Disposal cancels the scheduled reconnect attempt: nothing to
    // unregister, close already attempted by the failed attempt, no throw.
    await ctx.fiber.dispose()
    await sleep(50)
    expect(mockClose).toHaveBeenCalled()
  })

  it('rejects activation and still closes the client when startup failure is configured as fatal', async () => {
    const cause = new Error('connection refused')
    mockConnect.mockRejectedValue(cause)
    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toMatchObject({
      message: 'mcp-client(srv): initial connection or tool synchronization failed',
      cause,
    })

    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await ctx.fiber.dispose()
    expect(mockClose).toHaveBeenCalled()
  })

  it('rejects strict startup when the initial tool generation cannot be registered', async () => {
    ctx.tools.register({
      name: 'mcp__srv__remote',
      description: 'Foreign squatter',
      parameters: { type: 'object' },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      execute: async () => 'foreign',
    })

    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toThrow('initial connection or tool synchronization failed')

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
    expect(mockClose).toHaveBeenCalled()
  })

  it('preserves strict startup registration when list_changed arrives before connect resolves', async () => {
    ctx.tools.register({
      name: 'mcp__srv__remote',
      description: 'Foreign squatter',
      parameters: { type: 'object' },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      execute: async () => 'foreign',
    })
    mockConnect.mockImplementation(async () => {
      const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
      await handler()
    })

    await expect(apply(ctx, {
      ...stdioConfig,
      failOnStartupError: true,
    })).rejects.toThrow('initial connection or tool synchronization failed')

    expect(mockListTools).toHaveBeenCalledTimes(2)
    expect(ctx.tools.get('mcp__srv__remote')?.description).toBe('Foreign squatter')
    await ctx.fiber.dispose()
  })

  it('re-syncs tools on ToolListChanged notification', async () => {
    await apply(ctx, stdioConfig)

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })

    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await handler()

    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__updated')).toBeDefined()
  })

  it('keeps the previous generation when a re-sync fails', async () => {
    await apply(ctx, stdioConfig)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    mockListTools.mockRejectedValue(new Error('flaky server'))
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    // Must not reject (contained), and must keep the last good generation.
    await handler()

    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('effect disposer unregisters the CURRENT generation and closes client', async () => {
    // Load through ctx.plugin so ONLY the plugin's fiber is disposed — the
    // registry must survive to observe the unregistration.
    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, stdioConfig)
    await fiber

    // Advance to a second generation first.
    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await handler()
    expect(ctx.tools.get('mcp__srv__updated')).toBeDefined()

    await fiber.dispose()
    await sleep(50)

    expect(mockClose).toHaveBeenCalled()
    // The live (second) generation was unregistered, not just the first.
    expect(ctx.tools.get('mcp__srv__updated')).toBeUndefined()
  })

  it('effect disposer handles client.close failure gracefully', async () => {
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.reject(new Error('already closed'))
    })

    await apply(ctx, stdioConfig)

    // Should not throw when dispose is triggered.
    await ctx.fiber.dispose()
    await sleep(50)

    expect(mockClose).toHaveBeenCalled()
  })

  it('uses streamable-http config path', async () => {
    const httpConfig: Config = {
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer x' },
      toolCallTimeoutMs: 30_000,
      failOnStartupError: false,
    }

    await apply(ctx, httpConfig)

    expect(mockConnect).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__web__remote')).toBeDefined()
  })
})

describe('capability composition edges', () => {
  const serverEntryId = `mcp-server:${Buffer.from('srv').toString('hex')}`

  it('ignores compositions that name no MCP server entry', async () => {
    const managed = await mountCapabilityRegistry()
    await apply(managed, stdioConfig)
    const standingKey = { profile: 'no-entry' }
    const standing = createScope(managed, standingKey)

    managed.capabilities.mountComposition(standing.ctx, [])

    expect(managed.tools.schemas(standingKey).map(tool => tool.name)).toContain('mcp__srv__remote')
    await managed.fiber.dispose()
  })

  it('skips restriction when the composition context has no tool registry', async () => {
    const managed = await mountCapabilityRegistry()
    await apply(managed, stdioConfig)
    const entry = { id: serverEntryId, kind: 'mcp-server', selected: true }

    managed.capabilities.mountComposition(new Context(), [entry as never])

    expect(managed.tools.schemas().map(tool => tool.name)).toContain('mcp__srv__remote')
    await managed.fiber.dispose()
  })

  it('imposes no restriction when every live tool stays visible', async () => {
    const managed = await mountCapabilityRegistry()
    await apply(managed, stdioConfig)
    const standingKey = { profile: 'all-visible' }
    const standing = createScope(managed, standingKey)
    const entry = { id: serverEntryId, kind: 'mcp-server', selected: true }
    const restrictSpy = vi.spyOn(managed.tools, 'restrict')

    managed.capabilities.mountComposition(standing.ctx, [entry as never])

    expect(managed.tools.schemas(standingKey).map(tool => tool.name)).toContain('mcp__srv__remote')
    expect(restrictSpy).not.toHaveBeenCalled()
    await managed.fiber.dispose()
  })

  it('contains a failing composition restriction refresh without mutating the captured generation', async () => {
    const managed = await mountCapabilityRegistry()
    await apply(managed, stdioConfig)
    const errors: string[] = []
    managed.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof managed.logger.error
    const standingKey = { profile: 'failing-refresh' }
    const standing = createScope(managed, standingKey)
    const target = { kind: 'agent-profile', agentProfile: 'failing-refresh' } as const
    const view = { scope: standingKey }
    const catalog = await managed.capabilities.snapshot(target, view)
    const server = catalog.entries.find(entry => entry.kind === 'mcp-server')!
    const plan = await managed.capabilities.plan(target, [
      { capabilityId: server.id, members: [] },
    ], catalog.revision, view)
    expect(plan.blockers).toEqual([])
    await managed.capabilities.apply(plan.id, catalog.revision)
    const entries = (await managed.capabilities.snapshot(target, view)).entries
    managed.capabilities.mountComposition(standing.ctx, entries)

    // The generation entry is immutable. Exercise containment at the actual
    // refresh boundary instead of mutating the captured catalog after mount.
    vi.spyOn(managed.tools, 'restrict').mockImplementation(() => {
      throw new Error('restriction broke')
    })

    mockListTools.mockResolvedValue({
      tools: [{ name: 'updated', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    await handler()

    expect(errors.join('\n')).toContain('composition restriction refresh failed')
    expect(errors.join('\n')).toContain('restriction broke')
    await managed.fiber.dispose()
  })
})

describe('W07 instructions and resource surfaces', () => {
  const serverEntryId = `mcp-server:${Buffer.from('srv').toString('hex')}`

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    mockGetInstructions.mockReturnValue(undefined)
    mockGetServerCapabilities.mockReturnValue({ tools: {} })
    mockListResources.mockResolvedValue({ resources: [] })
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [] })
    mockReadResource.mockResolvedValue({ contents: [] })
  })

  async function mountResourceRegistry(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(McpResources)
    return ctx
  }

  it('captures attributed instructions verbatim in a connection-owned section', async () => {
    const registry = await mountResourceRegistry()
    mockGetInstructions.mockReturnValue('Be careful. Braces {{stay literal}}.')
    await apply(registry, stdioConfig)

    expect(renderPrompt(await registry.systemPrompt.assemble()))
      .toContain('### MCP server: srv\n\nBe careful. Braces {{stay literal}}.')
    await registry.fiber.dispose()
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid programmatic instruction budget %s before connecting', async (maxInstructionBytes) => {
      const registry = await mountResourceRegistry()
      await expect(apply(registry, { ...stdioConfig, maxInstructionBytes }))
        .rejects.toThrow('maxInstructionBytes must be a positive safe integer')
      expect(mockConnect).not.toHaveBeenCalled()
      expect(registry.tools.get('mcp__srv__remote')).toBeUndefined()
      await registry.fiber.dispose()
    },
  )

  it('removes old tools when the server stops advertising the tools capability', async () => {
    const registry = await mountResourceRegistry()
    await apply(registry, stdioConfig)
    expect(registry.tools.get('mcp__srv__remote')).toBeDefined()
    mockGetServerCapabilities.mockReturnValue({ resources: {} })
    const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    await handler()
    expect(registry.tools.get('mcp__srv__remote')).toBeUndefined()
    const result = await registry.tools.execute({ name: 'list_mcp_resources', arguments: { server: 'srv' },
      signal: new AbortController().signal, callId: CallId('resource-only-refresh') })
    expect(result.isError).toBe(false)
    await registry.fiber.dispose()
  })

  it('retains the last good tools when resource notification synchronization fails', async () => {
    const registry = await mountResourceRegistry()
    const errors: string[] = []
    registry.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof registry.logger.error
    const fiber = registry.plugin({ name, inject, apply }, stdioConfig)
    await fiber
    mockListTools.mockRejectedValueOnce(new Error('notification fetch failed'))
    const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    await handler()
    expect(errors).toEqual(['mcp-client(srv): resource re-sync failed: Error: notification fetch failed'])
    expect(registry.tools.get('mcp__srv__remote')).toBeDefined()
    await fiber.dispose()
    mockListTools.mockClear()
    await handler()
    expect(mockListTools).not.toHaveBeenCalled()
    expect(registry.tools.get('mcp__srv__remote')).toBeUndefined()
    await registry.fiber.dispose()
  })

  it('quiesces a failing resource notification during disposal without logging a stale failure', async () => {
    const registry = await mountResourceRegistry()
    const errors: string[] = []
    registry.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof registry.logger.error
    const connection = startConnection(registry, stdioConfig, resolveReconnectPolicy({ enabled: false }, 'test'))
    await connection.ready
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const pending: PromiseWithResolvers<unknown> = Promise.withResolvers()
    mockListTools.mockImplementationOnce(() => { entered.resolve(); return pending.promise })
    const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    const refreshing = handler()
    await entered.promise
    const disposing = connection.dispose()
    pending.reject(new Error('late notification failure'))
    await Promise.all([refreshing, disposing])
    expect(errors).toEqual([])
    expect(connection.toolNames()).toEqual([])
    expect(connection.connected()).toBe(false)
    await registry.fiber.dispose()
  })

  it('contributes no instruction section when the server sends none', async () => {
    const registry = await mountResourceRegistry()
    await apply(registry, stdioConfig)

    expect(renderPrompt(await registry.systemPrompt.assemble()))
      .not.toContain('### MCP server: srv')
    await registry.fiber.dispose()
  })

  it('fails startup when attributed instructions exceed maxInstructionBytes', async () => {
    const registry = await mountResourceRegistry()
    mockGetInstructions.mockReturnValue('x'.repeat(64))
    const failure = apply(registry, { ...stdioConfig, maxInstructionBytes: 8, failOnStartupError: true })
    await expect(failure).rejects.toThrow('initial connection or tool synchronization failed')
    const error = await failure.catch((reason: unknown) => reason)
    expect(String((error as Error & { cause?: unknown }).cause))
      .toContain('server instructions exceed maxInstructionBytes (8)')
    expect(registry.tools.get('mcp__srv__remote')).toBeUndefined()
    await registry.fiber.dispose()
  })

  it('defaults maxInstructionBytes to 32768 and accepts multibyte budgets by bytes', async () => {
    const registry = await mountResourceRegistry()
    // 3 bytes per CJK character: the server text costs 12 bytes on top of
    // the 21-byte attribution header — a 33-byte budget admits it by bytes.
    mockGetInstructions.mockReturnValue('你好你好')
    await expect(apply(registry, { ...stdioConfig, maxInstructionBytes: 33, failOnStartupError: true }))
      .resolves.toBeUndefined()
    await registry.fiber.dispose()
  })

  it('advertises discovered resource members alongside tool members', async () => {
    const managed = await mountCapabilityRegistry()
    mockGetServerCapabilities.mockReturnValue({ tools: {}, resources: { listChanged: false } })
    mockListResources.mockResolvedValue({
      resources: [{ uri: 'docs://a', name: 'A' }, { uri: 'docs://b', name: 'B' }],
    })
    await apply(managed, stdioConfig)

    const target = { kind: 'agent-profile', agentProfile: 'resource-members' } as const
    const view = { scope: { profile: 'resource-members' } }
    const catalog = await managed.capabilities.snapshot(target, view)
    const server = catalog.entries.find(entry => entry.id === serverEntryId)!
    expect(server.memberEntries?.map(member => [member.kind, member.name])).toEqual([
      ['mcp-tool', 'mcp__srv__remote'],
      ['mcp-resource', 'docs://a'],
      ['mcp-resource', 'docs://b'],
    ])
    expect(server.memberEntries?.map(member => member.id)).toEqual([
      `${serverEntryId}/mcp-tool:${Buffer.from('mcp__srv__remote').toString('hex')}`,
      mcpResourceMemberId('srv', 'docs://a'),
      mcpResourceMemberId('srv', 'docs://b'),
    ])
    await managed.fiber.dispose()
  })

  it('bounds reads and lists to the Profile-visible resources of a narrowed agent', async () => {
    const managed = new Context()
    await managed.plugin(SystemPrompt)
    await managed.plugin(ToolRuntime)
    await managed.plugin(McpResources)
    await managed.plugin(MemorySettings)
    await managed.plugin(Capabilities)
    mockGetServerCapabilities.mockReturnValue({ resources: { listChanged: false } })
    mockListResources.mockResolvedValue({
      resources: [{ uri: 'docs://a', name: 'A' }, { uri: 'docs://b', name: 'B' }],
    })
    mockReadResource.mockResolvedValue({ contents: [{ uri: 'docs://a', mimeType: 'text/plain', text: 'A body.' }] })
    await apply(managed, stdioConfig)

    const standingKey = { profile: 'narrowed-resources' }
    const standing = createScope(managed, standingKey)
    const target = { kind: 'agent-profile', agentProfile: 'narrowed-resources' } as const
    const view = { scope: standingKey }
    const catalog = await managed.capabilities.snapshot(target, view)
    const server = catalog.entries.find(entry => entry.id === serverEntryId)!
    const resourceA = server.memberEntries?.find(member => member.name === 'docs://a')
    const plan = await managed.capabilities.plan(target, [{
      capabilityId: server.id,
      members: [resourceA!.id],
    }], catalog.revision, view)
    expect(plan.blockers).toEqual([])
    await managed.capabilities.apply(plan.id, catalog.revision)
    managed.capabilities.mountComposition(standing.ctx, (await managed.capabilities.snapshot(target, view)).entries)

    const agent = {} as object
    bindScopeParent(agent, standingKey)
    const allowed = await managed.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-allowed'),
      name: 'read_mcp_resource',
      arguments: { server: 'srv', uri: 'docs://a' },
      agent: agent as never,
    })
    expect(allowed.isError).toBe(false)
    expect(JSON.stringify(allowed.content)).toContain('A body.')
    mockReadResource.mockClear()

    const denied = await managed.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-denied'),
      name: 'read_mcp_resource',
      arguments: { server: 'srv', uri: 'docs://b' },
      agent: agent as never,
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('not visible to this agent')
    expect(mockReadResource).not.toHaveBeenCalled()

    const listed = await managed.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('list-narrowed'),
      name: 'list_mcp_resources',
      arguments: { server: 'srv' },
      agent: agent as never,
    })
    expect(listed.isError).toBe(false)
    expect(JSON.stringify(listed.content)).toContain('docs://a')
    expect(JSON.stringify(listed.content)).not.toContain('docs://b')

    // An agent outside the narrowed composition reaches everything.
    const outsider = await managed.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-outsider'),
      name: 'read_mcp_resource',
      arguments: { server: 'srv', uri: 'docs://b' },
      agent: {} as never,
    })
    expect(outsider.isError).toBe(false)
    await managed.fiber.dispose()
  })

  it('denies every resource of an unloaded server', async () => {
    const managed = new Context()
    await managed.plugin(SystemPrompt)
    await managed.plugin(ToolRuntime)
    await managed.plugin(McpResources)
    await managed.plugin(MemorySettings)
    await managed.plugin(Capabilities)
    mockGetServerCapabilities.mockReturnValue({ resources: { listChanged: false } })
    mockListResources.mockResolvedValue({
      resources: [{ uri: 'docs://a', name: 'A' }],
    })
    mockGetInstructions.mockReturnValue('private server instruction')
    const register = vi.spyOn(managed.mcpResources, 'register')
    await apply(managed, stdioConfig)
    const provider = register.mock.calls.find(([server]) => server === 'srv')![1]

    const standingKey = { profile: 'unloaded-resources' }
    const standing = createScope(managed, standingKey)
    const target = { kind: 'agent-profile', agentProfile: 'unloaded-resources' } as const
    const view = { scope: standingKey }
    const catalog = await managed.capabilities.snapshot(target, view)
    const server = catalog.entries.find(entry => entry.id === serverEntryId)!
    const plan = await managed.capabilities.plan(target, [
      { capabilityId: server.id, selection: 'unload' },
    ], catalog.revision, view)
    await managed.capabilities.apply(plan.id, catalog.revision)
    managed.capabilities.mountComposition(standing.ctx, (await managed.capabilities.snapshot(target, view)).entries)

    const agent = {} as object
    bindScopeParent(agent, standingKey)
    mockListResources.mockClear()
    mockListResourceTemplates.mockClear()
    await expect(provider.request({ method: 'resources/read', uri: 'docs://a' }, {
      agent, signal: new AbortController().signal, callId: CallId('direct-unloaded'),
    } as never)).rejects.toThrow('resource server is not visible to this agent')
    expect(renderPrompt(await managed.systemPrompt.assemble({ scope: agent }))).not.toContain('private server instruction')
    expect(renderPrompt(await managed.systemPrompt.assemble({ scope: agent }))).not.toContain('server argument:')
    const denied = await managed.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-unloaded'),
      name: 'read_mcp_resource',
      arguments: { server: 'srv', uri: 'docs://a' },
      agent: agent as never,
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('unavailable in this agent')

    const listed = await managed.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('list-unloaded'),
      name: 'list_mcp_resources',
      arguments: { server: 'srv' },
      agent: agent as never,
    })
    expect(listed.isError).toBe(true)
    expect(JSON.stringify(listed.content)).not.toContain('docs://a')
    expect(mockReadResource).not.toHaveBeenCalled()
    expect(mockListResources).not.toHaveBeenCalled()
    const templates = await managed.tools.execute({
      signal: new AbortController().signal, callId: CallId('templates-unloaded'),
      name: 'list_mcp_resource_templates', arguments: { server: 'srv' }, agent: agent as never,
    })
    expect(templates.isError).toBe(true)
    expect(mockListResourceTemplates).not.toHaveBeenCalled()
    await managed.fiber.dispose()
  })

  it('passes non-list result shapes through the narrowing untouched', async () => {
    const managed = new Context()
    await managed.plugin(SystemPrompt)
    await managed.plugin(ToolRuntime)
    await managed.plugin(McpResources)
    await managed.plugin(MemorySettings)
    await managed.plugin(Capabilities)
    mockGetServerCapabilities.mockReturnValue({ resources: { listChanged: false } })
    mockListResources.mockResolvedValue({ resources: [{ uri: 'docs://a', name: 'A' }] })
    await apply(managed, stdioConfig)

    const standingKey = { profile: 'narrowed-shapes' }
    const standing = createScope(managed, standingKey)
    const target = { kind: 'agent-profile', agentProfile: 'narrowed-shapes' } as const
    const view = { scope: standingKey }
    const catalog = await managed.capabilities.snapshot(target, view)
    const server = catalog.entries.find(entry => entry.id === serverEntryId)!
    const resourceA = server.memberEntries?.find(member => member.name === 'docs://a')
    const plan = await managed.capabilities.plan(target, [{
      capabilityId: server.id,
      members: [resourceA!.id],
    }], catalog.revision, view)
    await managed.capabilities.apply(plan.id, catalog.revision)
    managed.capabilities.mountComposition(standing.ctx, (await managed.capabilities.snapshot(target, view)).entries)
    const agent = {} as object
    bindScopeParent(agent, standingKey)

    // A scalar/array result or one without a resources array passes as-is.
    const markers: [unknown, string][] = [[[], '[]'], ['plain', 'plain'], [{ note: 'no resources here' }, 'no resources here']]
    for (const [shape, marker] of markers) {
      mockListResources.mockResolvedValue(shape)
      const listed = await managed.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('list-shape'),
        name: 'list_mcp_resources',
        arguments: { server: 'srv' },
        agent: agent as never,
      })
      expect(listed.isError).toBe(false)
      expect(JSON.stringify(listed.content)).toContain(marker)
    }

    mockListResources.mockResolvedValue({ resources: [null, [], 'invalid', { uri: 42 },
      { uri: 'docs://a', name: 'Allowed' }, { uri: 'docs://b', name: 'Hidden' }] })
    const malformed = await managed.tools.execute({
      signal: new AbortController().signal, callId: CallId('malformed-members'),
      name: 'list_mcp_resources', arguments: { server: 'srv' }, agent: agent as never,
    })
    expect(malformed.isError).toBe(false)
    expect(malformed).toHaveProperty('value', { resources: [{ uri: 'docs://a', name: 'Allowed' }] })

    // An explicit concrete-resource grant does not also grant templates.
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [{ uriTemplate: 'docs://x/{q}', name: 'x' }] })
    const templates = await managed.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('templates-narrowed'),
      name: 'list_mcp_resource_templates',
      arguments: { server: 'srv' },
      agent: agent as never,
    })
    expect(templates.isError).toBe(false)
    expect(JSON.stringify(templates.content)).not.toContain('docs://x/{q}')
    await managed.fiber.dispose()
  })

  it('supports an unscoped composition and disposes it without a scope record', async () => {
    const managed = await mountCapabilityRegistry()
    mockGetServerCapabilities.mockReturnValue({ tools: {}, resources: { listChanged: false } })
    mockListResources.mockResolvedValue({ resources: [{ uri: 'docs://a', name: 'A' }] })
    await apply(managed, stdioConfig)
    const entry = { id: serverEntryId, kind: 'mcp-server', selected: true }

    const plain = new Context()
    await plain.plugin(SystemPrompt)
    await plain.plugin(ToolRuntime)
    managed.capabilities.mountComposition(plain, [entry as never])
    // The unscoped composition records no visibility, and its disposal skips
    // the per-scope record cleanup without touching the live registry.
    await plain.fiber.dispose()
    expect(managed.tools.schemas().map(tool => tool.name)).toContain('mcp__srv__remote')
    await managed.fiber.dispose()
  })

  it('contains a failed resource discovery and keeps the previous cache', async () => {
    const registry = await mountResourceRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: { listChanged: false } })
    const errors: string[] = []
    registry.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof registry.logger.error
    mockListResources.mockResolvedValue({
      resources: [{ uri: 'docs://a', name: 'A' }],
    })
    await apply(registry, stdioConfig)

    mockListResources.mockRejectedValue(new Error('resource backend down'))
    const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    await handler()
    await vi.waitFor(() => { expect(errors.join('\n')).toContain('resource discovery failed') })
    expect(errors.join('\n')).not.toContain('repeated continuation cursor')

    // The read surface keeps working and the stale URI stays resolvable.
    mockReadResource.mockResolvedValue({ contents: [{ uri: 'docs://a', mimeType: 'text/plain', text: 'A body.' }] })
    const read = await registry.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-stale-cache'),
      name: 'read_mcp_resource',
      arguments: { server: 'srv', uri: 'docs://a' },
    })
    expect(read.isError).toBe(false)
    await registry.fiber.dispose()
  })

  it('treats a repeated continuation cursor as invalid pagination', async () => {
    const registry = await mountResourceRegistry()
    const errors: string[] = []
    registry.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof registry.logger.error
    mockGetServerCapabilities.mockReturnValue({ tools: {}, resources: { listChanged: false } })
    mockListResources.mockResolvedValue({
      resources: [{ uri: 'docs://a', name: 'A' }],
      nextCursor: 'same-page',
    })
    await apply(registry, stdioConfig)

    expect(errors.join('\n')).toContain('repeated continuation cursor "same-page"')
    expect(mockListResources).toHaveBeenCalledTimes(2)
    expect(registry.tools.get('mcp__srv__remote')).toBeDefined()
    await registry.fiber.dispose()
  })

  it('routes the three resource operations through the live generation', async () => {
    const registry = await mountResourceRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: { listChanged: false } })
    mockListResources.mockResolvedValue({ resources: [] })
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [{ uriTemplate: 'docs://q/{term}', name: 'q' }] })
    mockReadResource.mockResolvedValue({ contents: [{ uri: 'docs://t', mimeType: 'text/plain', text: 'T.' }] })
    await apply(registry, stdioConfig)

    await registry.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('route-list'),
      name: 'list_mcp_resources',
      arguments: { server: 'srv', cursor: 'page-7' },
    })
    expect(mockListResources).toHaveBeenCalledWith({ cursor: 'page-7' }, expect.anything())
    await registry.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('route-templates'),
      name: 'list_mcp_resource_templates',
      arguments: { server: 'srv', cursor: 'tpl-page' },
    })
    expect(mockListResourceTemplates).toHaveBeenCalledWith({ cursor: 'tpl-page' }, expect.anything())
    const read = await registry.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('route-read'),
      name: 'read_mcp_resource',
      arguments: { server: 'srv', uri: 'docs://t' },
    })
    expect(mockReadResource).toHaveBeenCalledWith({ uri: 'docs://t' }, expect.anything())
    expect(JSON.stringify(read.content)).toContain('T.')
    await registry.fiber.dispose()
  })

  it('requests resources and instructions only from a connected generation', async () => {
    const registry = await mountResourceRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: { listChanged: false } })
    mockConnect.mockRejectedValue(new Error('connection refused'))
    await apply(registry, stdioConfig)

    const offline = await registry.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('read-offline-mock'),
      name: 'read_mcp_resource',
      arguments: { server: 'srv', uri: 'docs://t' },
    })
    expect(offline.isError).toBe(true)
    expect(JSON.stringify(offline.content)).toContain('server is disconnected')
    expect(mockReadResource).not.toHaveBeenCalled()
    await registry.fiber.dispose()
  })

  it('connects a resource-only server without invoking tools/list', async () => {
    const registry = await mountResourceRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: {} })
    mockListTools.mockRejectedValue(new Error('tools capability not supported'))
    await apply(registry, { ...stdioConfig, failOnStartupError: true })
    expect(mockListTools).not.toHaveBeenCalled()
    const result = await registry.tools.execute({
      signal: new AbortController().signal, callId: CallId('resource-only'),
      name: 'list_mcp_resources', arguments: { server: 'srv' },
    })
    expect(result.isError).toBe(false)
    await registry.fiber.dispose()
  })

  it('uses native URI templates and preserves explicit inherited grants without discovery entries', async () => {
    const managed = await mountCapabilityRegistry()
    await managed.plugin(McpResources)
    mockGetServerCapabilities.mockReturnValue({ resources: {} })
    const template = 'docs://search{?query}'
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [{ name: 'search', uriTemplate: template }] })
    await apply(managed, stdioConfig)
    const key = {}
    const standing = createScope(managed, key)
    const catalog = await managed.capabilities.snapshot({ kind: 'agent-profile', agentProfile: 'search' })
    const server = catalog.entries.find(entry => entry.id === serverEntryId)!
    managed.capabilities.mountComposition(standing.ctx, [{
      ...server, memberEntries: [], memberSelection: 'inherit',
      memberAllowlist: [mcpResourceTemplateMemberId('srv', template)],
    }])
    const agent = {}
    bindScopeParent(agent, key)
    for (const [uri, allowed] of [['docs://search?query=a%20b', true], ['docs://private', false]] as const) {
      mockReadResource.mockClear()
      mockReadResource.mockResolvedValue({ contents: [{ uri, text: 'query result' }] })
      const result = await managed.tools.execute({
        signal: new AbortController().signal, callId: CallId(uri),
        name: 'read_mcp_resource', arguments: { server: 'srv', uri }, agent: agent as never,
      })
      expect(result.isError).toBe(!allowed)
      expect(mockReadResource).toHaveBeenCalledTimes(allowed ? 1 : 0)
      if (allowed) expect(JSON.stringify(result.content)).toContain('query result')
    }
    // Refresh does not widen the captured grant, even with a new template.
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [
      { name: 'search', uriTemplate: template }, { name: 'private', uriTemplate: 'docs://private/{id}' },
    ] })
    const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    await handler()
    const list = await managed.tools.execute({
      signal: new AbortController().signal, callId: CallId('filtered-templates'),
      name: 'list_mcp_resource_templates', arguments: { server: 'srv' }, agent: agent as never,
    })
    expect(JSON.stringify(list.content)).toContain(template)
    expect(JSON.stringify(list.content)).not.toContain('docs://private')
    await managed.fiber.dispose()
  })

  it('bounds raw reads before returning a tool value, including binary and metadata', async () => {
    const registry = await mountResourceRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: {} })
    await apply(registry, stdioConfig)
    for (const content of [
      { uri: 'docs://large', blob: 'A'.repeat(MAX_RESOURCE_RESULT_BYTES) },
      { uri: 'docs://large', text: 'small', _meta: { data: 'x'.repeat(MAX_RESOURCE_RESULT_BYTES) } },
    ]) {
      mockReadResource.mockResolvedValue({ contents: [content] })
      const result = await registry.tools.execute({
        signal: new AbortController().signal, callId: CallId('oversized-resource'),
        name: 'read_mcp_resource', arguments: { server: 'srv', uri: 'docs://large' },
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('resource result exceeds')
      expect('value' in result).toBe(false)
    }
    await registry.fiber.dispose()
  })

  it('follows an empty opaque resource cursor', async () => {
    const registry = await mountResourceRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: {} })
    mockListResources.mockResolvedValueOnce({ resources: [], nextCursor: '' })
      .mockResolvedValueOnce({ resources: [{ uri: 'docs://second', name: 'Second' }] })
    await apply(registry, stdioConfig)
    expect(mockListResources).toHaveBeenCalledTimes(2)
    expect(mockListResources).toHaveBeenLastCalledWith({ cursor: '' }, expect.anything())
    await registry.fiber.dispose()
  })

  it('publishes resource and template inventory atomically on resource notifications', async () => {
    const managed = await mountCapabilityRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: { listChanged: true } })
    mockListResources.mockResolvedValue({ resources: [{ uri: 'docs://old', name: 'Old' }] })
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [{ uriTemplate: 'docs://old/{id}', name: 'Old template' }] })
    await apply(managed, stdioConfig)
    const names = async () => (await managed.capabilities.snapshot({ kind: 'global-agent' })).entries
      .find(entry => entry.id === serverEntryId)!.memberEntries!.map(member => member.name)
    const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    mockListResources.mockResolvedValue({ resources: [{ uri: 'docs://new', name: 'New' }] })
    mockListResourceTemplates.mockRejectedValueOnce(new Error('template discovery failed'))
    await handler()
    expect(await names()).toEqual(['docs://old', 'docs://old/{id}'])
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [{ uriTemplate: 'docs://new/{id}', name: 'New template' }] })
    await handler()
    expect(await names()).toEqual(['docs://new', 'docs://new/{id}'])
    await managed.fiber.dispose()
  })

  it('follows opaque template cursors and publishes the complete sorted inventory', async () => {
    const registry = await mountResourceRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: {} })
    mockListResourceTemplates.mockResolvedValueOnce({
      resourceTemplates: [{ name: 'Z', uriTemplate: 'docs://z/{id}' }], nextCursor: '',
    }).mockResolvedValueOnce({ resourceTemplates: [{ name: 'A', uriTemplate: 'docs://a/{id}' }] })
    const connection = startConnection(registry, stdioConfig, resolveReconnectPolicy({ enabled: false }, 'test'))
    await connection.ready
    expect(connection.resourceTemplates()).toEqual(['docs://a/{id}', 'docs://z/{id}'])
    expect(mockListResourceTemplates).toHaveBeenLastCalledWith({ cursor: '' }, expect.anything())
    await connection.dispose()
    await registry.fiber.dispose()
  })

  it.each(['resources', 'templates'] as const)('discards %s discovery completed after disposal', async (stage) => {
    const registry = await mountResourceRegistry()
    mockGetServerCapabilities.mockReturnValue({ resources: {} })
    const connection = startConnection(registry, stdioConfig, resolveReconnectPolicy({ enabled: false }, 'test'))
    await connection.ready
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const pending: PromiseWithResolvers<unknown> = Promise.withResolvers()
    const listing = stage === 'resources' ? mockListResources : mockListResourceTemplates
    listing.mockImplementationOnce(() => { entered.resolve(); return pending.promise })
    const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
    const refreshing = handler()
    await entered.promise
    const disposing = connection.dispose()
    pending.resolve(stage === 'resources'
      ? { resources: [{ name: 'Late', uri: 'docs://late' }] }
      : { resourceTemplates: [{ name: 'Late', uriTemplate: 'docs://late/{id}' }] })
    await Promise.all([refreshing, disposing])
    expect(connection.resourceUris()).toEqual([])
    expect(connection.resourceTemplates()).toEqual([])
    expect(connection.connected()).toBe(false)
    await registry.fiber.dispose()
  })

  it.each(['resource-count', 'template-count', 'resource-bytes', 'template-bytes'] as const)(
    'keeps both last-good inventories when discovery exceeds %s', async (limit) => {
      const registry = await mountResourceRegistry()
      mockGetServerCapabilities.mockReturnValue({ resources: {} })
      mockListResources.mockResolvedValue({ resources: [{ name: 'Old', uri: 'docs://old' }] })
      mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [{ name: 'Old', uriTemplate: 'docs://old/{id}' }] })
      const errors: string[] = []
      registry.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof registry.logger.error
      const connection = startConnection(registry, stdioConfig, resolveReconnectPolicy({ enabled: false }, 'test'))
      await connection.ready
      if (limit === 'resource-count') {
        mockListResources.mockResolvedValue({ resources: Array.from({ length: MAX_RESOURCE_ITEMS + 1 }, (_, index) => ({ name: 'New', uri: `docs://${index}` })) })
      } else if (limit === 'template-count') {
        mockListResourceTemplates.mockResolvedValue({ resourceTemplates: Array.from({ length: MAX_RESOURCE_ITEMS }, (_, index) => ({ name: 'New', uriTemplate: `docs://${index}/{id}` })) })
      } else {
        const metadata = 'x'.repeat(Math.floor(MAX_RESOURCE_RESULT_BYTES / 2))
        if (limit === 'resource-bytes') {
          mockListResources.mockResolvedValueOnce({ resources: [], _meta: { metadata }, nextCursor: 'second' })
            .mockResolvedValueOnce({ resources: [], _meta: { metadata } })
        } else {
          mockListResources.mockResolvedValue({ resources: [], _meta: { metadata } })
          mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [], _meta: { metadata } })
        }
      }
      const handler = mockSetNotificationHandler.mock.calls.at(-1)![1] as () => Promise<void>
      await handler()
      expect(errors).toEqual(['mcp-client(srv): resource discovery failed: Error: MCP resource inventory exceeds its limit'])
      expect(connection.resourceUris()).toEqual(['docs://old'])
      expect(connection.resourceTemplates()).toEqual(['docs://old/{id}'])
      await connection.dispose()
      await registry.fiber.dispose()
    },
  )

  it('reapplies captured tool grants before awaiting refreshed resource discovery', async () => {
    const managed = await mountCapabilityRegistry()
    mockGetServerCapabilities.mockReturnValue({ tools: {}, resources: {} })
    mockListTools.mockResolvedValue({ tools: [{ name: 'allowed', inputSchema: { type: 'object' } }] })
    await apply(managed, stdioConfig)
    const key = { profile: 'tool-refresh' }
    const standing = createScope(managed, key)
    const target = { kind: 'agent-profile', agentProfile: 'tool-refresh' } as const
    const view = { scope: key }
    const snapshot = await managed.capabilities.snapshot(target, view)
    const entry = snapshot.entries.find(candidate => candidate.id === serverEntryId)!
    const allowed = entry.memberEntries!.find(member => member.name === 'mcp__srv__allowed')!
    const plan = await managed.capabilities.plan(target, [{ capabilityId: entry.id, members: [allowed.id] }], snapshot.revision, view)
    await managed.capabilities.apply(plan.id, snapshot.revision)
    managed.capabilities.mountComposition(standing.ctx, (await managed.capabilities.snapshot(target, view)).entries)
    const agent = {} as object
    bindScopeParent(agent, key)
    mockListTools.mockResolvedValue({ tools: [
      { name: 'allowed', inputSchema: { type: 'object' } },
      { name: 'new_tool', inputSchema: { type: 'object' } },
    ] })
    let names: string[] = []
    let denied: boolean | undefined
    mockListResources.mockImplementationOnce(async () => {
      names = managed.tools.schemas(agent as never).map(tool => tool.name)
      denied = (await managed.tools.execute({ agent: agent as never, name: 'mcp__srv__new_tool', arguments: {},
        callId: CallId('during-discovery'), signal: new AbortController().signal })).isError
      return { resources: [] }
    })
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await handler()
    expect(names).toContain('mcp__srv__allowed')
    expect(names).not.toContain('mcp__srv__new_tool')
    expect(denied).toBe(true)
    expect(mockCallTool).not.toHaveBeenCalled()
    await managed.fiber.dispose()
  })
})
