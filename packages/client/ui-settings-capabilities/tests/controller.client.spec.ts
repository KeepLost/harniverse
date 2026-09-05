import { describe, expect, it, vi } from 'vitest'
import type {
  CapabilityCatalogEntry,
  CapabilityCatalogSnapshot,
  CapabilityPlan,
  CapabilityCompositionSnapshot,
  CapabilityTarget,
} from '@deepseek-ai/dsh-api-remotes/client'
import { CapabilityCompositionController, type CapabilityCompositionWire } from '../src/client/controller.ts'

const globalTarget = { kind: 'global-agent' } as const
const profileTarget = (agentProfile: string) => ({ kind: 'agent-profile', agentProfile }) as const

function catalog(target: CapabilityTarget, revision = 1): CapabilityCatalogSnapshot {
  return {
    target,
    revision,
    topologyRevision: 7,
    complete: true,
    entries: [{
      id: 'tool:bash',
      kind: 'tool',
      name: 'bash',
      description: 'Run commands.',
      provenance: 'upstream',
      assembleable: true,
      available: true,
      defaultLoaded: true,
      manageable: true,
      owner: 'ctx.tools',
      requires: [],
      selection: 'inherit',
      effectiveSelection: 'load',
      selected: true,
    }, {
      id: 'subagent-provider:spawn',
      kind: 'subagent-provider',
      name: 'spawn',
      description: 'Subagent provider spawn.',
      provenance: 'upstream',
      assembleable: false,
      available: true,
      defaultLoaded: true,
      manageable: false,
      owner: 'ctx.subagents',
      requires: [],
      selection: 'inherit',
      effectiveSelection: 'load',
      selected: true,
    }],
  }
}

function plan(target: CapabilityTarget, blockers: CapabilityPlan['blockers'] = []): CapabilityPlan {
  return {
    id: 'plan-1',
    target,
    expectedRevision: 1,
    topologyRevision: 7,
    operations: [{ capabilityId: 'tool:bash', before: 'inherit', after: 'unload' }],
    blockers,
    result: catalog(target).entries.map(entry => entry.id === 'tool:bash'
      ? { ...entry, selection: 'unload', effectiveSelection: 'unload', selected: false }
      : entry),
  }
}

function bench(overrides: Partial<CapabilityCompositionWire> = {}) {
  const calls = {
    catalog: [] as CapabilityTarget[],
    apply: [] as Array<readonly [planId: string, expectedRevision: number]>,
  }
  const wire: CapabilityCompositionWire = {
    listProfiles: vi.fn(async () => [
      { id: 'standard', name: 'Standard' },
      { id: 'minimal', name: 'Minimal' },
    ]),
    catalog: async (target) => {
      calls.catalog.push(target)
      return catalog(target)
    },
    plan: async target => plan(target),
    apply: async (planId, expectedRevision): Promise<CapabilityCompositionSnapshot> => {
      calls.apply.push([planId, expectedRevision])
      return {
        target: globalTarget,
        revision: 2,
        values: { 'tool:bash': { selection: 'unload' } },
      }
    },
    ...overrides,
  }
  return { calls, controller: new CapabilityCompositionController(wire) }
}

describe('CapabilityCompositionController', () => {
  it('loads global composition and offers every healthy Agent Profile as a target', async () => {
    const { calls, controller } = bench()
    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.target).toEqual(globalTarget)
    expect(state.profiles.map(profile => profile.id)).toEqual(['standard', 'minimal'])
    expect(state.catalog?.entries.map(entry => entry.id)).toEqual(['tool:bash', 'subagent-provider:spawn'])
    expect(calls.catalog).toEqual([globalTarget])
  })

  it('switches target, stages tri-state selections, and discards without a write', async () => {
    const { calls, controller } = bench()
    await controller.load()
    await controller.selectTarget(profileTarget('minimal'))
    controller.setSelection('tool:bash', 'unload')

    expect(controller.store.getSnapshot().draft).toEqual({ 'tool:bash': { selection: 'unload' } })
    expect(controller.store.getSnapshot().plan).toBeNull()
    controller.discard()
    expect(controller.store.getSnapshot().draft).toEqual({})
    expect(calls.apply).toEqual([])
  })

  it('stages member and configuration changes without changing load selection', async () => {
    const baseCatalog = catalog(globalTarget)
    const customCatalog: CapabilityCatalogSnapshot = {
      ...baseCatalog,
      entries: [{
        ...baseCatalog.entries[0]!,
        members: [{ id: 'tool:bash/tool:run', kind: 'tool', name: 'run', description: 'Run.', defaultVisible: true, available: true, requires: [] }],
        memberSelection: 'inherit',
        memberEntries: [{ id: 'tool:bash/tool:run', kind: 'tool', name: 'run', description: 'Run.', defaultVisible: true, available: true, requires: [], visible: true }],
        customization: { fields: [{ id: 'text', kind: 'text', name: 'Text', description: 'Text.' }], defaultValues: { text: 'default' } },
        configOverrides: {},
        effectiveConfig: { text: 'default' },
      }, ...baseCatalog.entries.slice(1)],
    }
    const { controller } = bench({ catalog: vi.fn(async () => customCatalog) })
    await controller.load()
    controller.setMembers('tool:bash', [])
    controller.setConfig('tool:bash', { text: 'custom' })

    expect(controller.store.getSnapshot().draft).toEqual({
      'tool:bash': { members: [], config: { text: 'custom' } },
    })
  })

  it('previews blockers and refuses to apply a blocked plan', async () => {
    const blocked = plan(globalTarget, [{
      code: 'required-unloaded',
      capabilityId: 'tool:bash',
      dependencyId: 'tool:read',
      message: 'bash requires read',
    }])
    const { calls, controller } = bench({ plan: vi.fn(async () => blocked) })
    await controller.load()
    controller.setSelection('tool:bash', 'unload')
    await controller.preview()

    expect(controller.store.getSnapshot().plan?.blockers).toHaveLength(1)
    await controller.apply()
    expect(calls.apply).toEqual([])
  })

  it('applies an unchanged plan and reloads the committed target', async () => {
    const snapshots = [catalog(globalTarget, 1), catalog(globalTarget, 2)]
    const { calls, controller } = bench({ catalog: vi.fn(async () => snapshots.shift()!) })
    await controller.load()
    controller.setSelection('tool:bash', 'unload')
    await controller.preview()
    await controller.apply()

    const state = controller.store.getSnapshot()
    expect(calls.apply).toEqual([['plan-1', 1]])
    expect(state.catalog?.revision).toBe(2)
    expect(state.draft).toEqual({})
    expect(state.plan).toBeNull()
  })

  it('drops a committed draft when the post-apply catalog refresh fails', async () => {
    let reads = 0
    const { calls, controller } = bench({
      catalog: async (target) => {
        reads += 1
        if (reads === 1) return catalog(target)
        throw new Error('refresh unavailable')
      },
    })
    await controller.load()
    controller.setSelection('tool:bash', 'unload')
    await controller.preview()
    await controller.apply()

    const state = controller.store.getSnapshot()
    expect(calls.apply).toEqual([['plan-1', 1]])
    expect(state.status).toBe('error')
    expect(state.catalog).toBeNull()
    expect(state.draft).toEqual({})
    expect(state.plan).toBeNull()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    promise,
    resolve: (value: T) => { resolve(value) },
    reject: (reason?: unknown) => { reject(reason) },
  }
}

/** A catalog whose tool:bash entry carries members and customization. */
function richCatalog(target: CapabilityTarget, overrides: {
  memberSelection?: 'inherit' | 'custom'
  configOverrides?: Record<string, unknown>
} = {}): CapabilityCatalogSnapshot {
  const base = catalog(target)
  const { configOverrides: baseConfigOverrides, ...baseEntry } = base.entries[0]!
  const entry: Record<string, unknown> = {
    ...baseEntry,
    members: [{ id: 'tool:bash/tool:run', kind: 'tool', name: 'run', description: 'Run.', defaultVisible: true, available: true, requires: [] }],
    memberSelection: overrides.memberSelection ?? 'inherit',
    memberEntries: [{ id: 'tool:bash/tool:run', kind: 'tool', name: 'run', description: 'Run.', defaultVisible: true, available: true, requires: [], visible: true }],
    customization: { fields: [{ id: 'text', kind: 'text', name: 'Text', description: 'Text.' }], defaultValues: { text: 'default' } },
    effectiveConfig: { text: 'default' },
  }
  if (baseConfigOverrides !== undefined) entry.configOverrides = baseConfigOverrides
  if (overrides.configOverrides !== undefined) entry.configOverrides = overrides.configOverrides
  return {
    ...base,
    entries: [entry as unknown as CapabilityCatalogEntry, ...base.entries.slice(1)],
  }
}

describe('CapabilityCompositionController staleness and guards', () => {
  it('reports a failure thrown as a non-Error', async () => {
    const { controller } = bench({ listProfiles: vi.fn(async () => {
      throw 'roster unavailable'
    }) })

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('roster unavailable')
  })

  it('treats selecting the current target as a no-op', async () => {
    const { calls, controller } = bench()
    await controller.load()
    const catalogReads = calls.catalog.length

    await controller.selectTarget({ kind: 'global-agent' })
    await controller.selectTarget(profileTarget('minimal'))
    const afterSwitch = calls.catalog.length
    await controller.selectTarget(profileTarget('minimal'))

    expect(afterSwitch).toBe(catalogReads + 1)
    expect(calls.catalog.length).toBe(afterSwitch)
    await controller.selectTarget(profileTarget('standard'))
    expect(calls.catalog.length).toBe(afterSwitch + 1)
  })

  it('keeps the newest load when an older one settles late', async () => {
    const gates = [deferred<readonly { id: string; name: string }[]>(), deferred<readonly { id: string; name: string }[]>()]
    let reads = 0
    const { controller } = bench({
      listProfiles: vi.fn(() => gates[reads++]!.promise),
    })
    const first = controller.load()
    const second = controller.load()

    gates[0]!.resolve([{ id: 'standard', name: 'Standard' }])
    await first
    expect(controller.store.getSnapshot().status).toBe('loading')

    gates[1]!.resolve([{ id: 'standard', name: 'Standard' }])
    await second
    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('keeps the newest load when an older one fails late', async () => {
    const gates = [deferred<readonly { id: string; name: string }[]>(), deferred<readonly { id: string; name: string }[]>()]
    let reads = 0
    const { controller } = bench({
      listProfiles: vi.fn(() => gates[reads++]!.promise),
    })
    const first = controller.load()
    const second = controller.load()

    gates[0]!.reject(new Error('first attempt failed'))
    await first
    expect(controller.store.getSnapshot().status).toBe('loading')

    gates[1]!.resolve([{ id: 'standard', name: 'Standard' }])
    await second
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().error).toBeNull()
  })

  it('drops a target read that a newer target superseded', async () => {
    const gates = [deferred<CapabilityCatalogSnapshot>(), deferred<CapabilityCatalogSnapshot>()]
    let reads = 0
    const { controller } = bench({
      catalog: vi.fn((target: CapabilityTarget) => {
        const index = reads
        reads += 1
        if (index === 0) return Promise.resolve(catalog(target))
        return gates[index - 1]!.promise
      }),
    })
    await controller.load()

    const first = controller.selectTarget(profileTarget('minimal'))
    const second = controller.selectTarget(profileTarget('standard'))
    gates[0]!.resolve(catalog(profileTarget('minimal')))
    await first
    expect(controller.store.getSnapshot().status).toBe('loading')

    gates[1]!.resolve(catalog(profileTarget('standard')))
    await second
    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('drops a failed target read that a newer target superseded', async () => {
    const gates = [deferred<CapabilityCatalogSnapshot>(), deferred<CapabilityCatalogSnapshot>()]
    let reads = 0
    const { controller } = bench({
      catalog: vi.fn((target: CapabilityTarget) => {
        const index = reads
        reads += 1
        if (index === 0) return Promise.resolve(catalog(target))
        return gates[index - 1]!.promise
      }),
    })
    await controller.load()

    const first = controller.selectTarget(profileTarget('minimal'))
    const second = controller.selectTarget(profileTarget('standard'))
    gates[0]!.reject(new Error('unavailable'))
    await first
    expect(controller.store.getSnapshot().status).toBe('loading')

    gates[1]!.resolve(catalog(profileTarget('standard')))
    await second
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().error).toBeNull()
  })

  it('reports a failed target read and keeps the tab usable only after a retry', async () => {
    let reads = 0
    const { controller } = bench({
      catalog: vi.fn(async (target: CapabilityTarget) => {
        reads += 1
        if (reads === 1) return catalog(target)
        throw new Error('unavailable')
      }),
    })
    await controller.load()

    await controller.selectTarget(profileTarget('minimal'))

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.catalog).toBeNull()
    expect(state.error).toBe('unavailable')
  })

  it('ignores staging against unmanageable capabilities', async () => {
    const { controller } = bench()
    await controller.load()

    controller.setSelection('subagent-provider:spawn', 'unload')
    controller.setMembers('subagent-provider:spawn', [])
    controller.setConfig('subagent-provider:spawn', { text: 'x' })
    controller.setMembers('tool:bash', [])

    expect(controller.store.getSnapshot().draft).toEqual({})
  })

  it('removes a staged selection that repeats the catalog value', async () => {
    const { controller } = bench()
    await controller.load()

    controller.setSelection('tool:bash', 'inherit')

    expect(controller.store.getSnapshot().draft).toEqual({})
  })

  it('restores inherited membership only when the target carried none', async () => {
    const inheritCatalog = richCatalog(globalTarget)
    const { controller } = bench({ catalog: vi.fn(async () => inheritCatalog) })
    await controller.load()

    controller.setMembers('tool:bash', 'inherit')
    expect(controller.store.getSnapshot().draft).toEqual({})

    const customCatalog = richCatalog(globalTarget, { memberSelection: 'custom' })
    const custom = new CapabilityCompositionController({
      listProfiles: async () => [],
      catalog: async () => customCatalog,
      plan: async () => plan(globalTarget),
      apply: async () => ({ target: globalTarget, revision: 2, values: {} }),
    })
    await custom.load()
    custom.setMembers('tool:bash', 'inherit')
    expect(custom.store.getSnapshot().draft).toEqual({ 'tool:bash': { members: 'inherit' } })
  })

  it('restores inherited configuration only when the target carried none', async () => {
    const emptyOverrides = richCatalog(globalTarget)
    const { controller } = bench({ catalog: vi.fn(async () => emptyOverrides) })
    await controller.load()

    controller.setConfig('tool:bash', 'inherit')
    expect(controller.store.getSnapshot().draft).toEqual({})

    const customOverrides = richCatalog(globalTarget, { configOverrides: { text: 'x' } })
    const custom = new CapabilityCompositionController({
      listProfiles: async () => [],
      catalog: async () => customOverrides,
      plan: async () => plan(globalTarget),
      apply: async () => ({ target: globalTarget, revision: 2, values: {} }),
    })
    await custom.load()
    custom.setConfig('tool:bash', 'inherit')
    expect(custom.store.getSnapshot().draft).toEqual({ 'tool:bash': { config: 'inherit' } })
  })

  it('holds the draft through an in-flight preview', async () => {
    const gate = deferred<CapabilityPlan>()
    const { controller } = bench({ plan: vi.fn(() => gate.promise) })
    await controller.load()
    controller.setSelection('tool:bash', 'unload')
    const previewing = controller.preview()

    controller.discard()
    expect(controller.store.getSnapshot().draft).toEqual({ 'tool:bash': { selection: 'unload' } })

    gate.resolve(plan(globalTarget))
    await previewing
    expect(controller.store.getSnapshot().plan).not.toBeNull()
  })

  it('ignores a preview without a catalog or without staged changes', async () => {
    let reads = 0
    const failing = bench({
      catalog: vi.fn(async (target: CapabilityTarget) => {
        reads += 1
        if (reads === 1) return catalog(target)
        throw new Error('unavailable')
      }),
    })
    await failing.controller.load()
    await failing.controller.selectTarget(profileTarget('minimal'))
    await failing.controller.preview()
    expect(failing.controller.store.getSnapshot().plan).toBeNull()

    const { controller } = bench()
    await controller.load()
    await controller.preview()
    expect(controller.store.getSnapshot().plan).toBeNull()
    expect(controller.store.getSnapshot().planning).toBe(false)
  })

  it('drops a plan that arrived after the target moved on', async () => {
    const gate = deferred<CapabilityPlan>()
    const { controller } = bench({ plan: vi.fn(() => gate.promise) })
    await controller.load()
    await controller.selectTarget(profileTarget('minimal'))
    controller.setSelection('tool:bash', 'unload')
    const previewing = controller.preview()

    await controller.load()
    gate.resolve(plan(profileTarget('minimal')))
    await previewing

    expect(controller.store.getSnapshot().plan).toBeNull()
    expect(controller.store.getSnapshot().target).toEqual(globalTarget)
  })

  it('reports a refused plan', async () => {
    const { controller } = bench({ plan: vi.fn(async () => {
      throw new Error('plan refused')
    }) })
    await controller.load()
    controller.setSelection('tool:bash', 'unload')

    await controller.preview()

    const state = controller.store.getSnapshot()
    expect(state.planning).toBe(false)
    expect(state.error).toBe('plan refused')
  })

  it('reports a refused apply and keeps the plan showing', async () => {
    const { controller } = bench({ apply: vi.fn(async () => {
      throw new Error('apply refused')
    }) })
    await controller.load()
    controller.setSelection('tool:bash', 'unload')
    await controller.preview()

    await controller.apply()

    const state = controller.store.getSnapshot()
    expect(state.applying).toBe(false)
    expect(state.error).toBe('apply refused')
    expect(state.plan).not.toBeNull()
  })
})
