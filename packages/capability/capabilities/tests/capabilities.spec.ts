import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Capabilities, {
  type CapabilityAdapterControl,
  type CapabilityDescriptor,
  type CapabilityPlanBlocker,
} from '@deepseek-ai/dsh-capabilities'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

const target = { kind: 'agent-profile', agentProfile: 'standard' } as const

function descriptor(id: string, overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id,
    kind: 'tool',
    name: id,
    description: `Capability ${id}`,
    provenance: 'unknown',
    assembleable: true,
    available: true,
    defaultLoaded: true,
    manageable: true,
    requires: [],
    ...overrides,
  }
}

async function boot(entries: readonly CapabilityDescriptor[]) {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(Capabilities)
  const restrict = vi.fn()
  let control!: CapabilityAdapterControl
  const dispose = ctx.capabilities.registerAdapter((borrowed) => {
    control = borrowed
    return {
      id: 'fixture',
      snapshot: () => ({ entries, complete: true }),
      restrict: (_scope, projected) => {
        restrict(projected.filter(entry => !entry.selected).map(entry => entry.id).sort())
      },
    }
  })
  return { ctx, restrict, control, dispose }
}

describe('Capabilities', () => {
  it('projects deterministic selection state and applies a revision-fenced plan', async () => {
    const { ctx } = await boot([
      descriptor('tool:read'),
      descriptor('tool:search', { requires: ['tool:read'] }),
    ])
    const initial = await ctx.capabilities.snapshot(target)
    expect(initial.entries.map(entry => [entry.id, entry.selection, entry.selected])).toEqual([
      ['tool:read', 'inherit', true],
      ['tool:search', 'inherit', true],
    ])

    const plan = await ctx.capabilities.plan(target, [
      { capabilityId: 'tool:search', selection: 'unload' },
    ], initial.revision)
    expect(plan.blockers).toEqual([])
    const committed = await ctx.capabilities.apply(plan.id, initial.revision)
    expect(committed.revision).toBe(initial.revision + 1)
    expect(committed.values).toEqual({ 'tool:search': { selection: 'unload' } })

    const current = await ctx.capabilities.snapshot(target)
    expect(current.entries.find(entry => entry.id === 'tool:search')).toMatchObject({
      selection: 'unload', effectiveSelection: 'unload', selected: false,
    })
  })

  it('blocks unknown, immutable, unavailable, and dependency-breaking edits', async () => {
    const { ctx } = await boot([
      descriptor('tool:provider'),
      descriptor('tool:consumer', { requires: ['tool:provider'] }),
      descriptor('tool:shared', { manageable: false }),
      descriptor('tool:missing', { assembleable: false, available: false }),
    ])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [
      { capabilityId: 'tool:provider', selection: 'unload' },
      { capabilityId: 'tool:shared', selection: 'unload' },
      { capabilityId: 'tool:missing', selection: 'load' },
      { capabilityId: 'tool:ghost', selection: 'unload' },
    ], snapshot.revision)
    expect(plan.blockers.map(blocker => blocker.code).sort()).toEqual([
      'not-assembleable', 'not-manageable', 'required-unloaded', 'unknown-capability',
    ])
    const mutableBlockers = plan.blockers as CapabilityPlanBlocker[]
    mutableBlockers.splice(0)
    await expect(ctx.capabilities.apply(plan.id, snapshot.revision)).rejects.toThrow(/blocked/)
  })

  it('automatically loads assembleable hard dependencies', async () => {
    const { ctx } = await boot([
      descriptor('tool:provider', { defaultLoaded: false }),
      descriptor('tool:consumer', { defaultLoaded: false, requires: ['tool:provider'] }),
    ])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [
      { capabilityId: 'tool:consumer', selection: 'load' },
    ], snapshot.revision)

    expect(plan.blockers).toEqual([])
    expect(plan.operations).toEqual([
      { capabilityId: 'tool:consumer', before: 'inherit', after: 'load' },
      { capabilityId: 'tool:provider', before: 'inherit', after: 'load' },
    ])
    expect(plan.result.filter(entry => entry.selected).map(entry => entry.id)).toEqual([
      'tool:consumer', 'tool:provider',
    ])
  })

  it('installs effective global and Profile denies on a standing scope', async () => {
    const { ctx, restrict } = await boot([descriptor('tool:a'), descriptor('tool:b')])
    let snapshot = await ctx.capabilities.snapshot({ kind: 'global-agent' })
    let plan = await ctx.capabilities.plan({ kind: 'global-agent' }, [
      { capabilityId: 'tool:a', selection: 'unload' },
    ], snapshot.revision)
    await ctx.capabilities.apply(plan.id, snapshot.revision)

    snapshot = await ctx.capabilities.snapshot(target)
    plan = await ctx.capabilities.plan(target, [
      { capabilityId: 'tool:a', selection: 'load' },
      { capabilityId: 'tool:b', selection: 'unload' },
    ], snapshot.revision)
    await ctx.capabilities.apply(plan.id, snapshot.revision)

    const standing = createScope(ctx, { preset: 'standard' })
    ctx.capabilities.mountComposition(standing.ctx, (await ctx.capabilities.snapshot(target)).entries)
    expect(restrict).toHaveBeenCalledWith(['tool:b'])
    await standing.dispose()
  })

  it('plans inherited member allowlists and typed Profile configuration', async () => {
    const { ctx } = await boot([descriptor('plugin:persona-tools', {
      members: [{
        id: 'plugin:persona-tools/tool:read',
        kind: 'tool',
        name: 'read',
        description: 'Read files.',
        defaultVisible: true,
        available: true,
        requires: [],
      }, {
        id: 'plugin:persona-tools/tool:write',
        kind: 'tool',
        name: 'write',
        description: 'Write files.',
        defaultVisible: true,
        available: true,
        requires: [],
      }],
      customization: {
        fields: [
          { id: 'text', kind: 'text', name: 'Persona', description: 'Agent identity.', required: true },
          { id: 'includeRuntimeContext', kind: 'boolean', name: 'Runtime context', description: 'Include runtime context.' },
        ],
        defaultValues: { text: 'default persona', includeRuntimeContext: true },
      },
    })])
    const initial = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{
      capabilityId: 'plugin:persona-tools',
      members: ['plugin:persona-tools/tool:read'],
      config: { text: 'reviewer persona', includeRuntimeContext: false },
    }], initial.revision)

    expect(plan.blockers).toEqual([])
    expect(plan.operations).toEqual([expect.objectContaining({
      capabilityId: 'plugin:persona-tools',
      membersChanged: true,
      configChanged: true,
    })])
    await ctx.capabilities.apply(plan.id, initial.revision)
    const current = (await ctx.capabilities.snapshot(target)).entries[0]!
    expect(current.memberSelection).toBe('custom')
    expect(current.memberEntries?.map(member => [member.name, member.visible])).toEqual([
      ['read', true],
      ['write', false],
    ])
    expect(current.effectiveConfig).toEqual({ text: 'reviewer persona', includeRuntimeContext: false })
  })

  it('blocks unknown members and fields outside the owner-declared configuration contract', async () => {
    const { ctx } = await boot([descriptor('plugin:bounded', {
      members: [],
      customization: { fields: [], defaultValues: {} },
    })])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{
      capabilityId: 'plugin:bounded',
      members: ['plugin:bounded/tool:ghost'],
      config: { secret: 'nope' },
    }], snapshot.revision)

    expect(plan.blockers.map(blocker => blocker.code).sort()).toEqual([
      'configuration-invalid',
      'unknown-member',
    ])
  })

  it('expires plans when an adapter invalidates or unloads', async () => {
    const { ctx, control, dispose } = await boot([descriptor('tool:a')])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [
      { capabilityId: 'tool:a', selection: 'unload' },
    ], snapshot.revision)
    control.invalidate()
    await expect(ctx.capabilities.apply(plan.id, snapshot.revision)).rejects.toThrow(/unknown or expired/)
    dispose()
    expect((await ctx.capabilities.snapshot(target)).entries).toEqual([])
  })

  it('keeps scoped adapters inside their Profile and merges them only for an explicit global view', async () => {
    const { ctx } = await boot([])
    const alpha = createScope(ctx, { profile: 'alpha' })
    const beta = createScope(ctx, { profile: 'beta' })
    alpha.ctx.inject(['capabilities'], (scoped) => {
      scoped.capabilities.registerAdapter(() => ({
        id: 'profile-extension',
        snapshot: () => ({ entries: [descriptor('mcp:alpha', { kind: 'mcp-server' })], complete: true }),
      }))
    })
    beta.ctx.inject(['capabilities'], (scoped) => {
      scoped.capabilities.registerAdapter(() => ({
        id: 'profile-extension',
        snapshot: () => ({ entries: [descriptor('mcp:beta', { kind: 'mcp-server' })], complete: true }),
      }))
    })

    expect((await ctx.capabilities.snapshot(target)).entries).toEqual([])
    expect((await ctx.capabilities.snapshot(target, { scope: scopeKey(alpha) })).entries.map(entry => entry.id))
      .toEqual(['mcp:alpha'])
    expect((await ctx.capabilities.snapshot(target, { scope: scopeKey(beta) })).entries.map(entry => entry.id))
      .toEqual(['mcp:beta'])
    expect((await ctx.capabilities.snapshot({ kind: 'global-agent' }, {
      scopes: [scopeKey(alpha), scopeKey(beta)],
    })).entries.map(entry => entry.id)).toEqual(['mcp:alpha', 'mcp:beta'])

    await alpha.dispose()
    expect((await ctx.capabilities.snapshot(target, { scope: scopeKey(alpha) })).entries).toEqual([])
    await beta.dispose()
  })
})

function scopeKey(scope: { ctx: Context }): object {
  const key = scopeOf(scope.ctx)
  if (key === undefined) throw new Error('expected scoped context')
  return key
}
