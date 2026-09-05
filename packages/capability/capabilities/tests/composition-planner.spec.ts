import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Capabilities, {
  type CapabilityDescriptor,
  type CapabilityMemberDescriptor,
} from '@deepseek-ai/dsh-capabilities'
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
const globalTarget = { kind: 'global-agent' } as const

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

function member(id: string, overrides: Partial<CapabilityMemberDescriptor> = {}): CapabilityMemberDescriptor {
  return {
    id,
    kind: 'tool',
    name: id,
    description: `Member ${id}`,
    defaultVisible: true,
    available: true,
    requires: [],
    ...overrides,
  }
}

function personaDescriptor(): CapabilityDescriptor {
  return descriptor('plugin:persona', {
    members: [member('plugin:persona/tool:read'), member('plugin:persona/tool:write')],
    customization: {
      fields: [
        { id: 'text', kind: 'text', name: 'Persona', description: 'Agent identity.', required: true },
        { id: 'includeRuntimeContext', kind: 'boolean', name: 'Runtime context', description: 'Include runtime context.' },
        { id: 'limit', kind: 'number', name: 'Limit', description: 'Result limit.' },
      ],
      defaultValues: { text: 'default persona', includeRuntimeContext: true, limit: 3 },
    },
  })
}

async function boot(entries: readonly CapabilityDescriptor[]) {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(Capabilities)
  ctx.capabilities.registerAdapter(() => ({
    id: 'fixture',
    snapshot: () => ({ entries, complete: true }),
  }))
  return { ctx }
}

async function commit(ctx: { readonly capabilities: Capabilities }, changes: readonly Parameters<Capabilities['plan']>[1][number][]) {
  const snapshot = await ctx.capabilities.snapshot(target)
  const plan = await ctx.capabilities.plan(target, changes, snapshot.revision)
  await ctx.capabilities.apply(plan.id, plan.expectedRevision)
}

describe('Capabilities planner', () => {
  it('rejects plans built against a stale composition revision', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    const snapshot = await ctx.capabilities.snapshot(target)
    await expect(ctx.capabilities.plan(target, [{ capabilityId: 'tool:a', selection: 'unload' }], snapshot.revision + 1))
      .rejects.toThrow(/stale composition revision/)
  })

  it('rejects two changes for one capability', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    const snapshot = await ctx.capabilities.snapshot(target)
    await expect(ctx.capabilities.plan(target, [
      { capabilityId: 'tool:a', selection: 'unload' },
      { capabilityId: 'tool:a', selection: 'load' },
    ], snapshot.revision)).rejects.toThrow(/duplicate change/)
  })

  it('blocks selection edits on capabilities that must remain loaded', async () => {
    const { ctx } = await boot([descriptor('tool:pinned', { selectionManageable: false, owner: 'platform' })])
    const snapshot = await ctx.capabilities.snapshot(target)
    expect(snapshot.entries.find(entry => entry.id === 'tool:pinned')?.owner).toBe('platform')
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'tool:pinned', selection: 'unload' }], snapshot.revision)
    expect(plan.blockers).toEqual([{
      code: 'not-manageable',
      capabilityId: 'tool:pinned',
      message: 'Capability tool:pinned must remain loaded in this target.',
    }])
  })

  it('returns selection to inherit and clears the stored profile', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    await commit(ctx, [{ capabilityId: 'tool:a', selection: 'unload' }])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'tool:a', selection: 'inherit' }], snapshot.revision)
    expect(plan.operations).toEqual([{ capabilityId: 'tool:a', before: 'unload', after: 'inherit' }])
    await ctx.capabilities.apply(plan.id, snapshot.revision)
    expect(ctx.capabilities.composition(target).values).toEqual({})
    expect((await ctx.capabilities.snapshot(target)).entries.find(entry => entry.id === 'tool:a'))
      .toMatchObject({ selection: 'inherit', effectiveSelection: 'load' })
  })

  it('returns member allowlists to inherit', async () => {
    const { ctx } = await boot([personaDescriptor()])
    await commit(ctx, [{ capabilityId: 'plugin:persona', members: ['plugin:persona/tool:read'] }])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'plugin:persona', members: 'inherit' }], snapshot.revision)
    expect(plan.operations).toEqual([{
      capabilityId: 'plugin:persona',
      before: 'inherit',
      after: 'inherit',
      membersChanged: true,
    }])
    await ctx.capabilities.apply(plan.id, snapshot.revision)
    const entry = (await ctx.capabilities.snapshot(target)).entries.find(item => item.id === 'plugin:persona')
    expect(entry?.memberSelection).toBe('inherit')
    expect(entry?.memberEntries?.map(item => item.visible)).toEqual([true, true])
  })

  it('returns configuration to inherit', async () => {
    const { ctx } = await boot([personaDescriptor()])
    await commit(ctx, [{ capabilityId: 'plugin:persona', config: { text: 'reviewer' } }])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'plugin:persona', config: 'inherit' }], snapshot.revision)
    expect(plan.operations).toEqual([{
      capabilityId: 'plugin:persona',
      before: 'inherit',
      after: 'inherit',
      configChanged: true,
    }])
    await ctx.capabilities.apply(plan.id, snapshot.revision)
    const entry = (await ctx.capabilities.snapshot(target)).entries.find(item => item.id === 'plugin:persona')
    expect(entry?.effectiveConfig).toEqual({ text: 'default persona', includeRuntimeContext: true, limit: 3 })
    expect(entry?.configOverrides).toEqual({})
  })

  it('sorts and dedupes committed member allowlists', async () => {
    const { ctx } = await boot([personaDescriptor()])
    await commit(ctx, [{
      capabilityId: 'plugin:persona',
      members: ['plugin:persona/tool:write', 'plugin:persona/tool:read', 'plugin:persona/tool:write'],
    }])
    expect(ctx.capabilities.composition(target).values).toEqual({
      'plugin:persona': { members: ['plugin:persona/tool:read', 'plugin:persona/tool:write'] },
    })
  })

  it('flags member edits against unknown capabilities', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'tool:ghost', members: ['tool:ghost/tool:x'] }], snapshot.revision)
    expect(plan.blockers.map(blocker => blocker.code).sort()).toEqual(['unknown-capability', 'unknown-member'])
  })

  it('rejects configuration for capabilities without a contract', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'tool:a', config: { any: 'thing' } }], snapshot.revision)
    expect(plan.blockers).toEqual([{
      code: 'configuration-unsupported',
      capabilityId: 'tool:a',
      message: 'Capability tool:a does not expose Profile configuration.',
    }])
  })

  it('emits operations for configuration-only edits', async () => {
    const { ctx } = await boot([personaDescriptor()])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'plugin:persona', config: { limit: 8 } }], snapshot.revision)
    expect(plan.blockers).toEqual([])
    expect(plan.operations).toEqual([{
      capabilityId: 'plugin:persona',
      before: 'inherit',
      after: 'inherit',
      configChanged: true,
    }])
  })

  it('suppresses no-op operations', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    await commit(ctx, [{ capabilityId: 'tool:a', selection: 'load' }])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'tool:a', selection: 'load' }], snapshot.revision)
    expect(plan.operations).toEqual([])
  })

  it('rejects apply at a stale revision', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'tool:a', selection: 'unload' }], snapshot.revision)
    await expect(ctx.capabilities.apply(plan.id, snapshot.revision + 1)).rejects.toThrow(/stale composition revision/)
  })

  it('blocks requirements that have no recipe anywhere', async () => {
    const { ctx } = await boot([
      descriptor('tool:consumer', { requires: ['tool:ghost'] }),
      descriptor('tool:other'),
    ])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [], snapshot.revision)
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'required-unassembleable',
      capabilityId: 'tool:consumer',
      dependencyId: 'tool:ghost',
    }))
  })

  it('blocks visible members that require hidden members', async () => {
    const { ctx } = await boot([descriptor('plugin:kit', {
      members: [
        member('plugin:kit/tool:a', { requires: ['plugin:kit/tool:b'] }),
        member('plugin:kit/tool:b'),
      ],
    })])
    const snapshot = await ctx.capabilities.snapshot(target)
    const hidden = await ctx.capabilities.plan(target, [{
      capabilityId: 'plugin:kit',
      members: ['plugin:kit/tool:a'],
    }], snapshot.revision)
    expect(hidden.blockers).toContainEqual(expect.objectContaining({
      code: 'required-member-hidden',
      capabilityId: 'plugin:kit',
      dependencyId: 'plugin:kit/tool:b',
    }))
    const visible = await ctx.capabilities.plan(target, [{
      capabilityId: 'plugin:kit',
      members: ['plugin:kit/tool:a', 'plugin:kit/tool:b'],
    }], snapshot.revision)
    expect(visible.blockers).toEqual([])
  })

  it('validates configuration field kinds', async () => {
    const { ctx } = await boot([personaDescriptor()])
    const snapshot = await ctx.capabilities.snapshot(target)
    const plan = await ctx.capabilities.plan(target, [{
      capabilityId: 'plugin:persona',
      config: { text: 5, includeRuntimeContext: 'yes', limit: Number.NaN },
    }], snapshot.revision)
    expect(plan.blockers.map(blocker => [blocker.code, blocker.dependencyId]).sort()).toEqual([
      ['configuration-invalid', 'includeRuntimeContext'],
      ['configuration-invalid', 'limit'],
      ['configuration-invalid', 'text'],
    ])
  })

  it('resolves global configuration for every target', async () => {
    const { ctx } = await boot([personaDescriptor()])
    const snapshot = await ctx.capabilities.snapshot(globalTarget)
    const plan = await ctx.capabilities.plan(globalTarget, [
      { capabilityId: 'plugin:persona', config: { limit: 7 } },
    ], snapshot.revision)
    await ctx.capabilities.apply(plan.id, snapshot.revision)
    const global = (await ctx.capabilities.snapshot(globalTarget)).entries.find(item => item.id === 'plugin:persona')
    expect(global?.effectiveConfig).toEqual({ text: 'default persona', includeRuntimeContext: true, limit: 7 })
    expect(global?.configOverrides).toEqual({ limit: 7 })
    const profile = (await ctx.capabilities.snapshot(target)).entries.find(item => item.id === 'plugin:persona')
    expect(profile?.effectiveConfig).toEqual({ text: 'default persona', includeRuntimeContext: true, limit: 7 })
    expect(profile?.configOverrides).toEqual({})
  })

  it('accepts string-form stored selections', async () => {
    const { ctx } = await boot([descriptor('tool:a', { defaultLoaded: false })])
    await ctx.settings.replace('capabilities' as SettingsNamespace, { global: { 'tool:a': 'load' }, profiles: {} })
    const entry = (await ctx.capabilities.snapshot(globalTarget)).entries.find(item => item.id === 'tool:a')
    expect(entry).toMatchObject({ selection: 'load', effectiveSelection: 'load', selected: true })
    const inherited = (await ctx.capabilities.snapshot(target)).entries.find(item => item.id === 'tool:a')
    expect(inherited).toMatchObject({ selection: 'inherit', effectiveSelection: 'load', selected: true })
    expect(ctx.capabilities.composition(target).values).toEqual({})
  })

  it('rejects stored overrides whose members are not id arrays', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    await ctx.settings.replace('capabilities' as SettingsNamespace, {
      global: { 'tool:a': { selection: 'load', members: 42 } },
      profiles: {},
    })
    await expect(ctx.capabilities.snapshot(target)).rejects.toThrow(/members must be an array of stable ids/)
  })

  it('rejects stored configuration that is not an object', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    await ctx.settings.replace('capabilities' as SettingsNamespace, {
      global: { 'tool:a': { selection: 'load', config: 42 } },
      profiles: {},
    })
    await expect(ctx.capabilities.snapshot(target)).rejects.toThrow(/stored override config must be an object/)
  })

  it('rejects stored configuration with non-primitive values', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    await ctx.settings.replace('capabilities' as SettingsNamespace, {
      global: { 'tool:a': { selection: 'load', config: { nested: {} } } },
      profiles: {},
    })
    await expect(ctx.capabilities.snapshot(target)).rejects.toThrow(/must contain JSON primitive values/)
  })
})

describe('Capabilities descriptor validation', () => {
  it('rejects unstable descriptor ids', async () => {
    const { ctx } = await boot([descriptor('BAD')])
    await expect(ctx.capabilities.snapshot(target)).rejects.toThrow(/must be a stable lowercase id/)
  })

  it('rejects invalid descriptor names and descriptions', async () => {
    const named = await boot([descriptor('tool:a', { name: ' padded ' })])
    await expect(named.ctx.capabilities.snapshot(target)).rejects.toThrow(/invalid name/)
    const described = await boot([descriptor('tool:a', { description: ' padded ' })])
    await expect(described.ctx.capabilities.snapshot(target)).rejects.toThrow(/invalid description/)
  })

  it('rejects self and repeated dependencies', async () => {
    const self = await boot([descriptor('tool:a', { requires: ['tool:a'] })])
    await expect(self.ctx.capabilities.snapshot(target)).rejects.toThrow(/requires itself/)
    const repeated = await boot([descriptor('tool:a', { requires: ['tool:b', 'tool:b'] })])
    await expect(repeated.ctx.capabilities.snapshot(target)).rejects.toThrow(/repeats dependency/)
  })

  it('rejects invalid, repeated, and misnamed members', async () => {
    const unstable = await boot([descriptor('plugin:kit', { members: [member('BAD')] })])
    await expect(unstable.ctx.capabilities.snapshot(target)).rejects.toThrow(/must be a stable lowercase id/)
    const repeated = await boot([descriptor('plugin:kit', {
      members: [member('plugin:kit/tool:a'), member('plugin:kit/tool:a')],
    })])
    await expect(repeated.ctx.capabilities.snapshot(target)).rejects.toThrow(/repeats member/)
    const misnamed = await boot([descriptor('plugin:kit', { members: [member('plugin:kit/tool:a', { name: ' pad ' })] })])
    await expect(misnamed.ctx.capabilities.snapshot(target)).rejects.toThrow(/invalid name/)
    const badRequires = await boot([descriptor('plugin:kit', {
      members: [member('plugin:kit/tool:a', { requires: ['BAD!'] })],
    })])
    await expect(badRequires.ctx.capabilities.snapshot(target)).rejects.toThrow(/must be a stable lowercase id/)
  })

  it('rejects unsafe and repeated configuration field ids', async () => {
    const unsafe = await boot([descriptor('plugin:persona', {
      customization: {
        fields: [{ id: 'constructor', kind: 'text', name: 'Ctor', description: 'Unsafe key.' }],
        defaultValues: {},
      },
    })])
    await expect(unsafe.ctx.capabilities.snapshot(target)).rejects.toThrow(/safe config key/)
    const repeated = await boot([descriptor('plugin:persona', {
      customization: {
        fields: [
          { id: 'text', kind: 'text', name: 'Persona', description: 'Identity.' },
          { id: 'text', kind: 'text', name: 'Persona', description: 'Identity.' },
        ],
        defaultValues: {},
      },
    })])
    await expect(repeated.ctx.capabilities.snapshot(target)).rejects.toThrow(/repeats configuration field/)
  })
})

describe('Capabilities target and signature validation', () => {
  it('rejects unsupported targets', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    await expect(ctx.capabilities.snapshot({ kind: 'workspace' } as never)).rejects.toThrow(/unsupported target/)
  })

  it('rejects invalid Agent Profile ids', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    await expect(ctx.capabilities.snapshot({ kind: 'agent-profile', agentProfile: 'NOPE' })).rejects.toThrow(/invalid Agent Profile id/)
    expect(() => ctx.capabilities.compositionSignature('Bad!', [])).toThrow(/invalid Agent Profile id/)
  })

  it('signatures the sorted effective composition', async () => {
    const { ctx } = await boot([descriptor('tool:z'), personaDescriptor()])
    const signature = ctx.capabilities.compositionSignature('standard', [
      descriptor('tool:z'),
      personaDescriptor(),
    ])
    expect(signature).toBe(JSON.stringify({
      'plugin:persona': {
        selection: 'load',
        members: ['plugin:persona/tool:read', 'plugin:persona/tool:write'],
        config: { text: 'default persona', includeRuntimeContext: true, limit: 3 },
      },
      'tool:z': { selection: 'load', members: [], config: {} },
    }))
  })
})
