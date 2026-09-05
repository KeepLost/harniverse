// @vitest-environment jsdom

import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  CapabilityCatalogSnapshot,
  CapabilityPlan,
  CapabilityCompositionSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import type { CapabilityCompositionTabInjected } from '../src/client/CapabilityCompositionTab.tsx'
import { apply as nodeApply } from '../src/index.ts'
import { CapabilityCompositionTab } from '../src/client/CapabilityCompositionTab.tsx'
import type { SessionCapabilitiesViewInjected } from '../src/client/SessionCapabilitiesView.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const TARGET = { kind: 'global-agent' } as const

const CATALOG: CapabilityCatalogSnapshot = {
  target: TARGET,
  revision: 1,
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
    members: [{ id: 'tool:bash/tool:run', kind: 'tool', name: 'run', description: 'Run.', defaultVisible: true, available: true, requires: [] }],
    memberSelection: 'inherit',
    memberEntries: [{ id: 'tool:bash/tool:run', kind: 'tool', name: 'run', description: 'Run.', defaultVisible: true, available: true, requires: [], visible: true }],
    customization: { fields: [{ id: 'text', kind: 'text', name: 'Text', description: 'Text.' }], defaultValues: { text: 'default' } },
    configOverrides: {},
    effectiveConfig: { text: 'default' },
    selection: 'inherit',
    effectiveSelection: 'load',
    selected: true,
  }],
}

const PLAN: CapabilityPlan = {
  id: 'plan-1',
  target: TARGET,
  expectedRevision: 1,
  topologyRevision: 7,
  operations: [{ capabilityId: 'tool:bash', before: 'inherit', after: 'unload' }],
  blockers: [],
  result: CATALOG.entries.map(entry => ({ ...entry, selection: 'unload' as const, effectiveSelection: 'unload' as const, selected: false })),
}

const APPLIED: CapabilityCompositionSnapshot = {
  target: TARGET,
  revision: 2,
  values: { 'tool:bash': { selection: 'unload' } },
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  const catalog = vi.fn()
  const plan = vi.fn()
  const applyPlan = vi.fn()
  const session = vi.fn()
  ctx.provide('remote.capabilityManagement', { catalog, plan, apply: applyPlan, session })
  const list = vi.fn()
  ctx.provide('connection', { api: { agentPresets: { list } } })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, catalog, plan, applyPlan, session, list }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
      'conversation.view': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

const rosterOf = (presets: object[]) => ({ rpcId: 'r', result: { ok: true as const, value: { presets } } })
const refused = (message: string) => ({ ok: false as const, error: { code: 'internal' as const, message, details: {} } })
const sessionSnapshot = { sessionId: 's1', agentProfile: 'standard', generation: 'standard@1', entries: [] }

async function mountedTab() {
  const b = await bench()
  declare(b.slots)
  await b.ctx.plugin({ inject: [...inject], apply }).await()
  const entry = b.slots.entries('settings.plugins.tab')[0]!
  const face = (entry.inject as unknown as () => CapabilityCompositionTabInjected)()
  return { ...b, face }
}

describe('ui-settings-capabilities browser plugin', () => {
  it('registers a localized lazy tab without reading either wire', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.capabilityManagement'])
    expect(entry.component).toBe(CapabilityCompositionTab)
    expect(entry.options).toMatchObject({ id: 'capabilities', order: 5 })
    expect(entry.locale).toBe('settings.capabilityComposition')
    expect(resolveSlotLabel(entry.options.label)).toBe('Profile 组装')
    const sessionEntry = b.slots.entries('conversation.view')[0]!
    expect(sessionEntry.options).toMatchObject({ id: 'capabilities', order: 20 })
    expect(resolveSlotLabel(sessionEntry.options.label)).toBe('能力')
    expect(b.catalog).not.toHaveBeenCalled()
    expect(b.list).not.toHaveBeenCalled()

    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Profile assembly')
    await b.ctx.fiber.dispose()
  })

  it('loads profiles through the roster wire, skipping broken presets', async () => {
    const { face, list, catalog } = await mountedTab()
    list.mockResolvedValue(rosterOf([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'damaged', trust: 'user', isDefault: false, broken: 'invalid YAML' },
      { id: 'named', trust: 'system', isDefault: false, name: 'Named' },
    ]))
    catalog.mockResolvedValue({ ok: true, value: CATALOG })

    await face.load()

    const state = face.hooks.capabilityComposition.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.profiles).toEqual([{ id: 'standard', name: 'standard' }, { id: 'named', name: 'Named' }])
    expect(catalog).toHaveBeenCalledWith(TARGET)
  })

  it('surfaces a refused roster as the tab error', async () => {
    const { face, list } = await mountedTab()
    list.mockResolvedValue({ rpcId: 'r', result: refused('roster down') })

    await face.load()

    expect(face.hooks.capabilityComposition.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'agentPreset.list failed: internal: roster down',
    })
  })

  it('stages and commits through the injected face', async () => {
    const { face, list, catalog, plan, applyPlan } = await mountedTab()
    list.mockResolvedValue(rosterOf([{ id: 'standard', trust: 'system', isDefault: true }]))
    catalog.mockResolvedValue({ ok: true, value: CATALOG })
    plan.mockResolvedValue({ ok: true, value: PLAN })
    applyPlan.mockResolvedValue({ ok: true, value: APPLIED })
    await face.load()

    face.setSelection('tool:bash', 'unload')
    expect(face.hooks.capabilityComposition.getSnapshot().draft).toEqual({ 'tool:bash': { selection: 'unload' } })
    face.setMembers('tool:bash', [])
    face.setConfig('tool:bash', { text: 'custom' })
    expect(face.hooks.capabilityComposition.getSnapshot().draft).toEqual({
      'tool:bash': { selection: 'unload', members: [], config: { text: 'custom' } },
    })

    await face.preview()
    expect(plan).toHaveBeenCalledWith(TARGET, [{ capabilityId: 'tool:bash', selection: 'unload', members: [], config: { text: 'custom' } }], 1)
    expect(face.hooks.capabilityComposition.getSnapshot().plan?.id).toBe('plan-1')

    await face.apply()
    expect(applyPlan).toHaveBeenCalledWith('plan-1', 1)

    face.setSelection('tool:bash', 'load')
    face.discard()
    expect(face.hooks.capabilityComposition.getSnapshot().draft).toEqual({})
  })

  it('surfaces refused capability-management answers as tab errors', async () => {
    const { face, list, catalog, plan, applyPlan } = await mountedTab()
    list.mockResolvedValue(rosterOf([{ id: 'standard', trust: 'system', isDefault: true }]))
    catalog.mockResolvedValue({ ok: true, value: CATALOG })
    plan.mockResolvedValue({ ok: true, value: PLAN })
    applyPlan.mockResolvedValue({ ok: true, value: APPLIED })
    await face.load()

    catalog.mockResolvedValue(refused('catalog down'))
    await face.selectTarget({ kind: 'agent-profile', agentProfile: 'standard' })
    expect(face.hooks.capabilityComposition.getSnapshot().error).toBe('capabilityManagement.catalog failed: internal: catalog down')

    catalog.mockResolvedValue({ ok: true, value: CATALOG })
    await face.load()
    face.setSelection('tool:bash', 'unload')
    plan.mockResolvedValue(refused('plan down'))
    await face.preview()
    expect(face.hooks.capabilityComposition.getSnapshot().error).toBe('capabilityManagement.plan failed: internal: plan down')

    plan.mockResolvedValue({ ok: true, value: PLAN })
    await face.preview()
    applyPlan.mockResolvedValue(refused('apply down'))
    await face.apply()
    expect(face.hooks.capabilityComposition.getSnapshot().error).toBe('capabilityManagement.apply failed: internal: apply down')
  })

  it('reloads after a connection reset', async () => {
    const { face, list, catalog, ctx } = await mountedTab()
    list.mockResolvedValue(rosterOf([{ id: 'standard', trust: 'system', isDefault: true }]))
    catalog.mockResolvedValue({ ok: true, value: CATALOG })
    await face.load()

    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(catalog).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('serves the session view from the capability-management wire', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('conversation.view')[0]!
    const face = (entry.inject as unknown as (sessionId: SessionId) => SessionCapabilitiesViewInjected)('s1' as SessionId)

    b.session.mockResolvedValue({ ok: true, value: sessionSnapshot })
    await expect(face.load()).resolves.toBe(sessionSnapshot)

    b.session.mockResolvedValue(refused('session down'))
    await expect(face.load()).rejects.toThrow('capabilityManagement.session failed: internal: session down')
    await b.ctx.fiber.dispose()
  })
})

describe('ui-settings-capabilities node half', () => {
  it('contributes no host behavior', () => {
    // Capability management lives in its authorized Host package; this seat
    // exists only so the plugin appears in the Loader tree.
    expect(() => { nodeApply() }).not.toThrow()
  })
})
