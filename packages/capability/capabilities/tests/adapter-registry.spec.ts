import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Capabilities, {
  type CapabilityAdapterControl,
  type CapabilityDescriptor,
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

function emptyAdapter(id: string) {
  return { id, snapshot: () => ({ entries: [], complete: true }) }
}

async function boot(entries: readonly CapabilityDescriptor[]) {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(Capabilities)
  const restrict = vi.fn()
  ctx.capabilities.registerAdapter(() => ({
    id: 'fixture',
    snapshot: () => ({ entries, complete: true }),
    restrict: () => {
      restrict()
    },
  }))
  return { ctx, restrict }
}

describe('Capabilities adapter registry', () => {
  it('treats invalidation before registration and after disposal as a no-op', async () => {
    const { ctx } = await boot([])
    let early!: CapabilityAdapterControl
    const dispose = ctx.capabilities.registerAdapter((control) => {
      early = control
      control.invalidate()
      return emptyAdapter('early')
    })
    const before = (await ctx.capabilities.snapshot(target)).topologyRevision
    dispose()
    const afterDispose = (await ctx.capabilities.snapshot(target)).topologyRevision
    expect(afterDispose).toBe(before + 1)
    early.invalidate()
    expect((await ctx.capabilities.snapshot(target)).topologyRevision).toBe(afterDispose)
  })

  it('rejects duplicate adapter ids in one scope', async () => {
    const { ctx } = await boot([])
    ctx.capabilities.registerAdapter(() => emptyAdapter('dupe'))
    expect(() => ctx.capabilities.registerAdapter(() => emptyAdapter('dupe')))
      .toThrow(/is already registered/)
    expect((await ctx.capabilities.snapshot(target)).entries).toEqual([])
  })

  it('rejects adapter ids that are not stable ids', async () => {
    const { ctx } = await boot([])
    expect(() => ctx.capabilities.registerAdapter(() => emptyAdapter('BAD')))
      .toThrow(/must be a stable lowercase id/)
  })

  it('merges identical duplicate descriptors and rejects conflicting ones', async () => {
    const { ctx } = await boot([descriptor('tool:a')])
    ctx.capabilities.registerAdapter(() => ({
      id: 'mirror',
      snapshot: () => ({ entries: [descriptor('tool:a')], complete: true }),
    }))
    const merged = await ctx.capabilities.snapshot(target)
    expect(merged.entries.filter(entry => entry.id === 'tool:a')).toHaveLength(1)
    ctx.capabilities.registerAdapter(() => ({
      id: 'rival',
      snapshot: () => ({ entries: [descriptor('tool:a', { description: 'Rival capability tool:a.' })], complete: true }),
    }))
    await expect(ctx.capabilities.snapshot(target)).rejects.toThrow(/conflicting capability id/)
  })

  it('propagates incomplete adapter observations', async () => {
    const { ctx } = await boot([])
    ctx.capabilities.registerAdapter(() => ({ id: 'partial', snapshot: () => ({ entries: [], complete: false }) }))
    expect((await ctx.capabilities.snapshot(target)).complete).toBe(false)
  })

  it('skips scoped adapters when mounting an unscoped composition', async () => {
    const { ctx, restrict } = await boot([])
    const scopedRestrict = vi.fn()
    const scope = createScope(ctx, {})
    scope.ctx.inject(['capabilities'], (scopedCtx) => {
      scopedCtx.capabilities.registerAdapter(() => ({
        id: 'scoped-ext',
        snapshot: () => ({ entries: [descriptor('tool:scoped')], complete: true }),
        restrict: scopedRestrict,
      }))
    })
    const key = scopeOf(scope.ctx)
    if (key === undefined) throw new Error('expected scoped context')
    expect((await ctx.capabilities.snapshot(target, { scope: key })).entries.map(entry => entry.id))
      .toEqual(['tool:scoped'])
    ctx.capabilities.mountComposition(ctx, (await ctx.capabilities.snapshot(target)).entries)
    expect(restrict).toHaveBeenCalledTimes(1)
    expect(scopedRestrict).not.toHaveBeenCalled()
    await scope.dispose()
  })

  it('contains capability change listener failures', async () => {
    const { ctx } = await boot([])
    const seen: string[] = []
    ctx.on('capabilities/change', () => {
      seen.push('throwing')
      throw new Error('sync boom')
    })
    const rejecting: () => unknown = () => {
      seen.push('rejecting')
      return Promise.reject(new Error('async boom'))
    }
    ctx.on('capabilities/change', rejecting)
    ctx.on('capabilities/change', () => {
      seen.push('clean')
    })
    const dispose = ctx.capabilities.registerAdapter(() => ({
      id: 'observed',
      snapshot: () => ({ entries: [descriptor('tool:observed')], complete: true }),
    }))
    expect(seen).toEqual(['throwing', 'rejecting', 'clean'])
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect((await ctx.capabilities.snapshot(target)).entries.map(entry => entry.id)).toEqual(['tool:observed'])
    dispose()
  })

  it('releases the settings namespace when the plugin is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const fiber = ctx.plugin(Capabilities)
    await fiber.await()
    await fiber.dispose()
    const again = ctx.plugin(Capabilities)
    await again.await()
    expect(ctx.capabilities.composition(target).values).toEqual({})
  })

  it('stays read-only without the settings service', async () => {
    const ctx = new Context()
    await ctx.plugin(Capabilities)
    ctx.capabilities.registerAdapter(() => ({
      id: 'bare',
      snapshot: () => ({ entries: [descriptor('tool:a')], complete: true }),
    }))
    const snapshot = await ctx.capabilities.snapshot(target)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.entries.map(entry => entry.id)).toEqual(['tool:a'])
    expect(ctx.capabilities.composition(target).values).toEqual({})
    const plan = await ctx.capabilities.plan(target, [{ capabilityId: 'tool:a', selection: 'unload' }], 0)
    expect(plan.blockers).toEqual([])
    await expect(ctx.capabilities.apply(plan.id, 0)).rejects.toThrow(/settings service is unavailable/)
  })
})
