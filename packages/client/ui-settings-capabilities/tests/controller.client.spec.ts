import { describe, expect, it, vi } from 'vitest'
import type {
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
        values: { 'tool:bash': 'unload' },
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

    expect(controller.store.getSnapshot().draft).toEqual({ 'tool:bash': 'unload' })
    expect(controller.store.getSnapshot().plan).toBeNull()
    controller.discard()
    expect(controller.store.getSnapshot().draft).toEqual({})
    expect(calls.apply).toEqual([])
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
