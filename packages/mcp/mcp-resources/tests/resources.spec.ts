import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import McpResources from '../src/index.ts'
import type { McpResourceProvider } from '../src/index.ts'

const resourceToolNames = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResources)
  return ctx
}

async function resourceScope(ctx: Context, owner: Agent): Promise<Scope> {
  let scoped!: Scope
  await ctx.plugin({ inject: ['mcpResources', 'tools'], apply(inner: Context) {
    scoped = createScope(inner, owner)
  } })
  return scoped
}

function visibleResourceTools(ctx: Context, agent?: Agent): string[] {
  return ctx.tools.schemas(agent).map(tool => tool.name).filter(name => resourceToolNames.includes(name)).sort()
}

function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    name, arguments: args, callId: CallId('resource-test'),
    signal: new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  })
}

describe('MCP resource tools', () => {
  it('omits every MCP contribution with no servers', async () => {
    const ctx = await setup()
    expect(visibleResourceTools(ctx)).toEqual([])
    const assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).not.toContain('mcp')
    expect(assembly.tools.map(tool => tool.name).filter(name => resourceToolNames.includes(name))).toEqual([])
    for (const name of resourceToolNames) {
      expect(ctx.tools.get(name)).toBeUndefined()
      expect(await call(ctx, name, { server: 'missing', uri: 'docs://text' }))
        .toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    }
  })

  it('keeps shared tools until the last provider unloads and accepts a replacement', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const first = await ctx.plugin({ inject: ['mcpResources'], apply(inner: Context) {
      inner.mcpResources.register('first', { request })
    } })
    const second = await ctx.plugin({ inject: ['mcpResources'], apply(inner: Context) {
      inner.mcpResources.register('second', { request })
    } })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    await first.dispose()
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    expect((await call(ctx, 'list_mcp_resources', { server: 'second' })).isError).toBe(false)
    await second.dispose()
    expect(visibleResourceTools(ctx)).toEqual([])
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP resource servers')

    const remove = ctx.mcpResources.register('second', { request })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    remove()
    expect(visibleResourceTools(ctx)).toEqual([])
    remove()
    expect(visibleResourceTools(ctx)).toEqual([])
    const replace = ctx.mcpResources.register('second', { request })
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    replace()
    expect(visibleResourceTools(ctx)).toEqual([])
  })

  it('shares scoped tools across independent provider owners (reverse disposal: true)', async () => {
    const ctx = await setup()
    const owner = {} as Agent
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const providers = await Promise.all(['first', 'second'].map(async server => ({
      server,
      fiber: await ctx.plugin({ inject: ['mcpResources'], apply(inner: Context) {
        createScope(inner, owner).ctx.mcpResources.register(server, { request })
      } }),
    })))
    providers.reverse()
    await providers[0]!.fiber.dispose()
    expect(visibleResourceTools(ctx, owner)).toEqual([...resourceToolNames].sort())
    expect((await call(ctx, 'list_mcp_resources', { server: providers[1]!.server }, owner)).isError).toBe(false)
    await providers[1]!.fiber.dispose()
    expect(visibleResourceTools(ctx, owner)).toEqual([])
  })

  it('exposes a scoped server only to its owner and descendants and falls back to inherited providers', async () => {
    const ctx = await setup()
    const owner = {} as Agent
    const child = {} as Agent
    const sibling = {} as Agent
    bindScopeParent(child, owner)
    const scoped = await resourceScope(ctx, owner)
    const localRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const globalRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [] })
    const removeLocal = scoped.ctx.mcpResources.register('docs', { request: localRequest })
    for (const agent of [owner, child]) {
      expect(visibleResourceTools(ctx, agent)).toEqual([...resourceToolNames].sort())
      expect((await call(ctx, 'list_mcp_resources', { server: 'docs' }, agent)).isError).toBe(false)
    }
    for (const agent of [undefined, sibling]) {
      expect(visibleResourceTools(ctx, agent)).toEqual([])
      expect(renderPrompt(await ctx.systemPrompt.assemble(agent === undefined ? {} : { scope: agent })))
        .not.toContain('MCP resource servers')
      expect(await call(ctx, 'list_mcp_resources', { server: 'docs' }, agent))
        .toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    }
    const removeGlobal = ctx.mcpResources.register('docs', { request: globalRequest })
    removeLocal()
    expect(visibleResourceTools(ctx, child)).toEqual([...resourceToolNames].sort())
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, child)
    expect(localRequest).toHaveBeenCalledTimes(2)
    expect(globalRequest).toHaveBeenCalledOnce()
    removeGlobal()
    expect(visibleResourceTools(ctx, owner)).toEqual([])
    expect(visibleResourceTools(ctx, child)).toEqual([])
    scoped.ctx.mcpResources.register('docs', { request: localRequest })
    expect(visibleResourceTools(ctx, owner)).toEqual([...resourceToolNames].sort())
    await scoped.dispose()
    expect(visibleResourceTools(ctx, owner)).toEqual([])
  })

  it('retains tools for a configured provider while its requests fail', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockRejectedValue(new Error('MCP server disconnected'))
    ctx.mcpResources.register('docs', { request })
    expect((await call(ctx, 'list_mcp_resources', { server: 'docs' })).isError).toBe(true)
    expect(visibleResourceTools(ctx)).toEqual([...resourceToolNames].sort())
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('server argument: ["docs"]')
  })

  it('rolls back a partial shared-tool registration (scoped: true)', async () => {
    const ctx = await setup()
    const owner = {} as Agent
    const registrationCtx = (await resourceScope(ctx, owner)).ctx
    const removeConflict = registrationCtx.tools.register({
      name: 'list_mcp_resource_templates', description: 'Conflicting tool.', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    })
    expect(() => registrationCtx.mcpResources.register('docs', { request: async () => ({ resources: [] }) }))
      .toThrow('already registered')
    expect(ctx.tools.get('list_mcp_resources', owner)).toBeUndefined()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: owner })))
      .not.toContain('MCP resource servers')
    removeConflict()
    registrationCtx.mcpResources.register('docs', { request: async () => ({ resources: [] }) })
    expect(visibleResourceTools(ctx, owner)).toEqual([...resourceToolNames].sort())
  })

  it('publishes explicit server names without requiring server tools or instructions', async () => {
    const ctx = await setup()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP resource servers')
    ctx.mcpResources.register('docs{{literal}}', { request: async () => ({ resources: [] }) })

    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('MCP resource servers')
    expect(prompt).toContain('server argument: ["docs{{literal}}"]')
  })

  it('lists only caller-visible names and withdraws disposed providers from the prompt', async () => {
    const ctx = await setup()
    const owner = {} as Agent
    const other = {} as Agent
    const provider = { request: async () => ({ resources: [] }) }
    const disposeGlobal = ctx.mcpResources.register('docs', provider)
    const fiber = await ctx.plugin({ inject: ['mcpResources'], apply(inner: Context) {
      const scope = createScope(inner, owner)
      scope.ctx.mcpResources.register('docs', provider)
      scope.ctx.mcpResources.register('private', provider)
    } })

    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: owner })))
      .toContain('server argument: ["docs","private"]')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: other })))
      .toContain('server argument: ["docs"]')
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: owner })))
      .toContain('server argument: ["docs"]')
    disposeGlobal()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP resource servers')
  })

  it('withdraws all shared tools and server-name context when its plugin unloads', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(McpResources)
    ctx.mcpResources.register('docs', { request: async () => ({ resources: [] }) })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('MCP resource servers')

    await fiber.dispose()
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect(ctx.tools.get(name)).toBeUndefined()
    }
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('MCP resource servers')
  })

  it('routes all three operations with the explicit server and opaque parameters', async () => {
    const ctx = await setup()
    const request = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ resources: [], nextCursor: 'next-page' })
    ctx.mcpResources.register('docs', { request })

    expect((await call(ctx, 'list_mcp_resources', { server: 'docs', cursor: 'page-2' })).isError).toBe(false)
    expect(request.mock.calls[0]?.[0]).toEqual({ method: 'resources/list', cursor: 'page-2' })
    expect((await call(ctx, 'list_mcp_resource_templates', { server: 'docs' })).isError).toBe(false)
    expect(request.mock.calls[1]?.[0]).toEqual({ method: 'resources/templates/list' })
    expect((await call(ctx, 'read_mcp_resource', { server: 'docs', uri: 'docs://guide' })).isError).toBe(false)
    expect(request.mock.calls[2]?.[0]).toEqual({ method: 'resources/read', uri: 'docs://guide' })
    expect(request.mock.calls[2]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect((await call(ctx, 'list_mcp_resource_templates', { server: 'docs', cursor: 'template-page' })).isError)
      .toBe(false)
    expect(request.mock.calls[3]?.[0]).toEqual({ method: 'resources/templates/list', cursor: 'template-page' })
  })

  it('keeps binary bytes programmatic while projecting text, URI and server attribution', async () => {
    const ctx = await setup()
    const value = { contents: [
      { uri: 'docs://text', mimeType: 'text/plain', text: 'Read this guide.' },
      { uri: 'docs://binary', mimeType: 'application/octet-stream', blob: 'AQIDBA==' },
    ] }
    ctx.mcpResources.register('docs', { request: async () => value })
    const result = await call(ctx, 'read_mcp_resource', { server: 'docs', uri: 'docs://text' })
    expect(result.isError).toBe(false)
    expect('value' in result && result.value).toEqual(value)
    expect(result.content).toEqual([{ type: 'text', text: 'MCP server: docs\n'
      + '{"contents":[{"uri":"docs://text","mimeType":"text/plain","text":"Read this guide."},'
      + '{"uri":"docs://binary","mimeType":"application/octet-stream","blob":'
      + '"[binary resource: 8 base64 characters; available to programmatic callers]"}]}' }])
    expect(JSON.stringify(result.content)).not.toContain('AQIDBA==')
  })

  it('rejects missing parameters and unavailable servers before dispatch', async () => {
    const ctx = await setup()
    ctx.mcpResources.register('docs', { request: async () => ({ resources: [] }) })
    expect((await call(ctx, 'read_mcp_resource', { uri: 'docs://text' })).isError).toBe(true)
    const result = await call(ctx, 'read_mcp_resource', { server: 'missing', uri: 'docs://text' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('unavailable in this agent')
  })

  it('resolves scoped providers and removes only the disposed registration', async () => {
    const ctx = await setup()
    const globalRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ contents: [] })
    const localRequest = vi.fn<McpResourceProvider['request']>().mockResolvedValue({ contents: [] })
    const other = {} as Agent
    const owner = {} as Agent
    ctx.mcpResources.register('docs', { request: globalRequest })
    let dispose = () => {}
    await ctx.plugin({ inject: ['mcpResources'], apply(inner: Context) {
      const scope = createScope(inner, owner)
      dispose = scope.ctx.mcpResources.register('docs', { request: localRequest })
      expect(() => scope.ctx.mcpResources.register('docs', { request: localRequest })).toThrow('already registered')
    } })
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, owner)
    expect(localRequest).toHaveBeenCalledOnce()
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, other)
    expect(globalRequest).toHaveBeenCalledOnce()
    dispose()
    await call(ctx, 'list_mcp_resources', { server: 'docs' }, owner)
    expect(globalRequest).toHaveBeenCalledTimes(2)
  })
})
