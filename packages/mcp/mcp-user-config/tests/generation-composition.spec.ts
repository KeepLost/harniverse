/** The shipped MCP rows, real Loader/Profile generations, and a local SDK server. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import Capabilities from '@deepseek-ai/dsh-capabilities'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { mcpResourceTemplateMemberId, mcpServerCapabilityId } from '@deepseek-ai/dsh-mcp-client'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as Bridge from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  override readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> { return Promise.resolve() }
}

let root = ''
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

const repo = resolve(import.meta.dirname, '../../../..')
const fixture = fileURLToPath(new URL('../../mcp-client/tests/resource-fixture-server.ts', import.meta.url))
function server(serverName: string) {
  return { id: 'docs', serverName, transport: 'stdio', command: process.execPath, args: [fixture], reconnect: { enabled: false } }
}

// Limit the composition to shipped MCP ownership rows and their real host services.
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mcp-generation-'))
  const profiles = join(root, 'profiles')
  for (const id of ['standard', 'code', 'cordis', 'minimal']) {
    const rows = load(await readFile(join(repo, 'apps/cli/config/agent-presets', id, 'agent.cordis.yml'), 'utf8'), { schema: entryListSchema }) as EntryOptions[]
    const mcp = rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-user-config')
    expect(mcp).toHaveLength(id === 'minimal' ? 0 : 1)
    await mkdir(join(profiles, id), { recursive: true })
    await writeFile(join(profiles, id, 'agent.cordis.yml'), dump(mcp))
  }
  const patches = load(await readFile(join(repo, 'packages/bundle/base/cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as { insert?: EntryOptions[] }[]
  const mcpRows = patches.flatMap(patch => patch.insert ?? []).filter(row => ['mcp-resources', 'mcp-user-config-settings'].includes(row.id))
  expect(mcpRows.map(row => row.id).sort()).toEqual(['mcp-resources', 'mcp-user-config-settings'])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, dump([
    { name: '@deepseek-ai/dsh-system-prompt' }, { name: '@deepseek-ai/dsh-tools' },
    { name: 'test:settings' }, { name: '@deepseek-ai/dsh-capabilities' }, ...mcpRows,
    { name: '@deepseek-ai/dsh-agent-presets', config: { default: 'standard', roots: [{ path: profiles, trust: 'system' }], includeUserRoot: false } },
  ]))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['test:settings', MemorySettings], ['@deepseek-ai/dsh-capabilities', Capabilities],
    ['@deepseek-ai/dsh-agent-presets', AgentPresets], ['@deepseek-ai/dsh-mcp-resources', McpResources],
    ['@deepseek-ai/dsh-mcp-user-config', Bridge],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function caller(parent: object): Agent {
  const agent = {} as Agent
  bindScopeParent(agent, parent)
  return agent
}

function call(ctx: Context, agent: Agent, serverName: string, uri: string) {
  return ctx.tools.execute({ agent, name: 'read_mcp_resource', arguments: { server: serverName, uri },
    callId: CallId('profile-read'), signal: new AbortController().signal })
}

describe('shipped MCP Profile composition', () => {
  it('exposes resources in Standard-family Profiles, leaves Minimal empty, and pins existing generations', async () => {
    const ctx = await boot()
    const settings = ctx.get('settings') as MemorySettings
    await settings.replace(Bridge.MCP_SETTINGS_NAMESPACE, { servers: [server('docs')] })
    const original = await ctx.agentPresets.standingKeyFor('standard')
    const oldAgent = caller(original)
    const oldChild = caller(oldAgent)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: oldAgent }))
    expect(prompt).toContain('### MCP server: docs\n\nServe documentation resources. Literal braces {{stay literal}}.')
    expect(prompt).toContain('server argument: ["docs"]')
    for (const id of ['code', 'cordis']) {
      const agent = caller(await ctx.agentPresets.standingKeyFor(id))
      expect((await call(ctx, agent, 'docs', 'docs://guide')).isError).toBe(false)
    }
    const minimal = caller(await ctx.agentPresets.standingKeyFor('minimal'))
    expect(ctx.tools.schemas(minimal).map(tool => tool.name)).not.toContain('read_mcp_resource')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: minimal }))).not.toContain('MCP')
    expect((await call(ctx, minimal, 'docs', 'docs://guide')).isError).toBe(true)

    const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
    const view = { scope: original }
    const snapshot = await ctx.capabilities.snapshot(target, view)
    const templateId = mcpResourceTemplateMemberId('docs', 'docs://search/{query}')
    const plan = await ctx.capabilities.plan(target, [{
      capabilityId: mcpServerCapabilityId('docs'), members: [templateId],
    }], snapshot.revision, view)
    expect(plan.blockers).toEqual([])
    await ctx.capabilities.apply(plan.id, snapshot.revision)
    const narrowed = await ctx.agentPresets.standingKeyFor('standard')
    expect(narrowed).not.toBe(original)
    const narrowAgent = caller(narrowed)
    const result = await call(ctx, narrowAgent, 'docs', 'docs://search/testing')
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Results for the templated query.')
    expect((await call(ctx, narrowAgent, 'docs', 'docs://guide')).isError).toBe(true)
    expect((await call(ctx, oldAgent, 'docs', 'docs://guide')).isError).toBe(false)
    expect(await ctx.agentPresets.standingKeyFor('standard')).toBe(narrowed)

    await settings.replace(Bridge.MCP_SETTINGS_NAMESPACE, { servers: [server('replacement')] })
    const next = await ctx.agentPresets.standingKeyFor('standard')
    expect(next).not.toBe(narrowed)
    const nextAgent = caller(next)
    expect((await call(ctx, nextAgent, 'replacement', 'docs://guide')).isError).toBe(false)
    expect((await call(ctx, nextAgent, 'docs', 'docs://guide')).isError).toBe(true)
    expect((await call(ctx, narrowAgent, 'docs', 'docs://search/testing')).isError).toBe(false)
    expect((await call(ctx, narrowAgent, 'docs', 'docs://guide')).isError).toBe(true)
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: narrowAgent }))).not.toContain('replacement')
    expect((await call(ctx, oldChild, 'docs', 'docs://guide')).isError).toBe(false)

    const nextView = { scope: next }
    const nextSnapshot = await ctx.capabilities.snapshot(target, nextView)
    const unload = await ctx.capabilities.plan(target, [{ capabilityId: mcpServerCapabilityId('replacement'), selection: 'unload' }], nextSnapshot.revision, nextView)
    expect(unload.blockers).toEqual([])
    await ctx.capabilities.apply(unload.id, nextSnapshot.revision)
    const excluded = caller(await ctx.agentPresets.standingKeyFor('standard'))
    expect(ctx.tools.schemas(excluded).map(tool => tool.name)).not.toContain('read_mcp_resource')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: excluded }))).not.toContain('replacement')
    expect((await call(ctx, excluded, 'replacement', 'docs://guide')).isError).toBe(true)
    expect((await call(ctx, nextAgent, 'replacement', 'docs://guide')).isError).toBe(false)

    await settings.replace(Bridge.MCP_SETTINGS_NAMESPACE, { servers: [] })
    const empty = caller(await ctx.agentPresets.standingKeyFor('standard'))
    expect(ctx.tools.schemas(empty).map(tool => tool.name)).not.toContain('read_mcp_resource')
    expect((await call(ctx, nextAgent, 'replacement', 'docs://guide')).isError).toBe(false)
  }, 30_000)

  it('retries a settings replacement during asynchronous catalog discovery', async () => {
    const ctx = await boot()
    const settings = ctx.get('settings') as MemorySettings
    await settings.replace(Bridge.MCP_SETTINGS_NAMESPACE, { servers: [server('before')] })
    let changed = false
    ctx.capabilities.registerAdapter(() => ({
      id: 'test:settings-race',
      async snapshot() {
        if (!changed) {
          changed = true
          await settings.replace(Bridge.MCP_SETTINGS_NAMESPACE, { servers: [server('after')] })
        }
        return { complete: true, entries: [] }
      },
    }))
    const key = await ctx.agentPresets.standingKeyFor('standard')
    const agent = caller(key)
    expect((await call(ctx, agent, 'after', 'docs://guide')).isError).toBe(false)
    expect((await call(ctx, agent, 'before', 'docs://guide')).isError).toBe(true)
    expect(await ctx.agentPresets.standingKeyFor('standard')).toBe(key)
  }, 15_000)
})
