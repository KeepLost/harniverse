import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Capabilities, { type CapabilityCatalogSnapshot, type CapabilityDescriptor } from '@deepseek-ai/dsh-capabilities'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import CapabilityManagementGateway from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function recipe(name: string, defaultLoaded: boolean): CapabilityDescriptor {
  return {
    id: `plugin:${name}`,
    kind: 'tool',
    name,
    description: `Profile plugin ${name}`,
    provenance: 'upstream',
    assembleable: true,
    available: true,
    defaultLoaded,
    manageable: true,
    owner: `@deepseek-ai/dsh-${name}`,
    requires: [],
  }
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Capabilities)
  let standingReads = 0
  let runtimeAgent: { ctx: Context; session: { header: { agentProfile?: string } } } | undefined
  const runtimeCapabilities = [{
    ...recipe('profile-tool', true),
    selection: 'inherit' as const,
    effectiveSelection: 'load' as const,
    selected: true,
    status: 'loaded' as const,
  }]
  ctx.provide('agentPresets', {
    list: () => Promise.resolve([{ id: 'standard' }, { id: 'minimal' }]),
    standingKeyFor: () => { standingReads += 1; return Promise.resolve({}) },
    capabilityRecipes: (id?: string) => Promise.resolve([
      recipe('profile-tool', id === undefined || id === 'standard'),
      recipe('minimal-tool', id === undefined || id === 'minimal'),
    ]),
    compositionRuntime: () => ({ agentProfile: 'standard', generation: 'standard@2', capabilities: runtimeCapabilities }),
  })
  ctx.provide('agents', { get: () => runtimeAgent })
  await ctx.plugin(CapabilityManagementGateway)
  return {
    ctx,
    gateway: ctx.get('capabilityManagement') as CapabilityManagementGateway,
    standingReads: () => standingReads,
    setRuntimeAgent: (agent: typeof runtimeAgent) => { runtimeAgent = agent },
  }
}

describe('CapabilityManagementGateway', () => {
  it('separates observation from authorized composition mutation', async () => {
    const { gateway } = await harness()
    expect(remoteMethods(gateway)).toEqual([
      { method: 'catalog', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
      { method: 'plan', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.administer' },
      { method: 'apply', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.administer' },
      { method: 'session', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
    ])
  })

  it('projects a Profile tool and commits only an unblocked revision-fenced plan', async () => {
    const { gateway } = await harness()
    const target = { kind: 'agent-profile', agentProfile: 'standard' } as const
    const catalog = await gateway.catalog(target)
    expect(catalog.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plugin:profile-tool', kind: 'tool', manageable: true, selected: true }),
    ]))

    const plan = await gateway.plan(target, [
      { capabilityId: 'plugin:profile-tool', selection: 'unload' },
    ], catalog.revision)
    expect(plan.blockers).toEqual([])
    const applied = await gateway.apply(plan.id, catalog.revision)
    expect(applied.values).toEqual({ 'plugin:profile-tool': 'unload' })
    await expect(gateway.apply(plan.id, catalog.revision)).rejects.toThrow(/expired/)
  })

  it('projects one deployment capability universe with target-specific availability', async () => {
    const { gateway, standingReads } = await harness()
    const global = await gateway.catalog({ kind: 'global-agent' })
    const standard = await gateway.catalog({ kind: 'agent-profile', agentProfile: 'standard' })
    const minimal = await gateway.catalog({ kind: 'agent-profile', agentProfile: 'minimal' })
    const ids = (entries: CapabilityCatalogSnapshot['entries']) => entries.map(entry => entry.id)

    expect(ids(standard.entries)).toEqual(ids(global.entries))
    expect(ids(minimal.entries)).toEqual(ids(global.entries))
    expect(standard.entries.find(entry => entry.id === 'plugin:profile-tool')).toMatchObject({ assembleable: true, selected: true })
    expect(standard.entries.find(entry => entry.id === 'plugin:minimal-tool')).toMatchObject({ assembleable: true, selected: false })
    expect(minimal.entries.find(entry => entry.id === 'plugin:profile-tool')).toMatchObject({ assembleable: true, selected: false })
    expect(minimal.entries.find(entry => entry.id === 'plugin:minimal-tool')).toMatchObject({ assembleable: true, selected: true })
    expect(standingReads()).toBe(0)
  })

  it('returns the immutable assembly result for a live Session generation', async () => {
    const { ctx, gateway, setRuntimeAgent } = await harness()
    setRuntimeAgent({ ctx, session: { header: {} } })

    expect(gateway.session('session-1')).toMatchObject({
      sessionId: 'session-1',
      agentProfile: 'standard',
      generation: 'standard@2',
      entries: [expect.objectContaining({ id: 'plugin:profile-tool', status: 'loaded' })],
    })
  })
})
