/**
 * ui-dashboard plugin halves: the browser entry's dictionary and slot
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal — HMR safety), the inert node entry, and the invariant companion's
 * ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as DashboardInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** One registration captured while the plugin applies. */
interface CapturedRegistration { options: Record<string, unknown>; component: unknown }

/** Boot the browser half over a real slot tree declaring both contributions. */
async function bench(): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  captured: CapturedRegistration[]
  layoutCalls: string[]
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'global' },
      'center.view': { kind: 'list', scope: 'global' },
    },
  } as never, () => null)
  // The locale plugin binds a settings scope, which reads the connection handle.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const layoutCalls: string[] = []
  ctx.provide('layout', {
    setCenterView: (id: string | undefined) => { layoutCalls.push(id === undefined ? 'clear' : `set:${id}`) },
    clearCenterView: () => { layoutCalls.push('clear') },
  } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const captured: CapturedRegistration[] = []
  const fiber = ctx.plugin({
    inject: [...inject],
    apply: (clientCtx) => {
      const slots = clientCtx.slots as unknown as {
        register: (options: Record<string, unknown>, component: unknown) => () => void
      }
      const inner = slots.register.bind(clientCtx.slots)
      slots.register = (options, component) => {
        captured.push({ options, component })
        return inner(options, component)
      }
      apply(clientCtx)
    },
  })
  await fiber.await()
  return { ctx, fiber, captured, layoutCalls }
}

describe('ui-dashboard browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout'])
  })

  it('registers both slots, and fiber teardown removes them (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('sidebar.footer.action').map(entry => entry.options.id)).toContain('dashboard-view')
    expect(ctx.slots.entries('center.view').map(entry => entry.options.id)).toContain('dashboard')
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.footer.action')).toEqual([])
    expect(ctx.slots.entries('center.view')).toEqual([])
  })

  it('shares one view store between the footer trigger and the view', async () => {
    const { captured } = await bench()
    const trigger = captured.find(({ options }) => options['id'] === 'dashboard-view')
    const view = captured.find(({ options }) => options['id'] === 'dashboard')
    expect(trigger).toBeDefined()
    expect(view).toBeDefined()
    expect(trigger!.options['store']).toBe(view!.options['store'])
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('view.nav')).toBe(zh['view.nav'])
    ctx.locale.setLocale('en')
    expect(translate('view.nav')).toBe(en['view.nav'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('view.nav')).not.toBe(en['view.nav'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('binds the footer trigger to the layout center-view occupancy', async () => {
    const { captured, layoutCalls } = await bench()
    const registration = captured.find(({ options }) => options['id'] === 'dashboard-view')
    expect(registration).toBeDefined()
    const injectFace = registration!.options['inject'] as () => { openView: () => void }
    injectFace().openView()
    const centerRegistration = captured.find(({ options }) => options['id'] === 'dashboard')
    const centerInject = centerRegistration!.options['inject'] as () => { closeView: () => void }
    centerInject().closeView()
    expect(layoutCalls).toEqual(['set:dashboard', 'clear'])
  })

  it('serves the tab ledger with thunk, string, and absent labels', async () => {
    const { ctx, captured } = await bench()
    // Extra entries through the real registry: a thunk label, a string label, and an absent one.
    ctx.slots.register({
      name: 'dashboard.center.tab', id: 'thunk-labelled', order: 20, locale: NS, label: () => 'Thunk label',
    } as never, () => null)
    ctx.slots.register({
      name: 'dashboard.center.tab', id: 'string-labelled', order: 30, locale: NS, label: 'Fixed label',
    } as never, () => null)
    ctx.slots.register({ name: 'dashboard.center.tab', id: 'unlabelled', order: 40, locale: NS } as never, () => null)
    const view = captured.find(({ options }) => options['id'] === 'dashboard')
    interface TabsSource {
      list: () => Array<{ id: string; label: string }>
      subscribe: (fn: () => void) => () => void
      version: () => number
    }
    const face = view!.options['inject'] as () => { tabs: TabsSource; closeView: () => void }
    const { tabs, closeView } = face()
    void closeView
    const descriptors = tabs.list()
    const byId = new Map(descriptors.map(d => [d.id, d.label]))
    expect(byId.get('thunk-labelled')).toBe('Thunk label')
    expect(byId.get('string-labelled')).toBe('Fixed label')
    expect(byId.get('unlabelled')).toBe('unlabelled')
    const before = tabs.version()
    let notified = 0
    const release = tabs.subscribe(() => { notified += 1 })
    ctx.slots.register({ name: 'dashboard.center.tab', id: 'late', order: 50, locale: NS } as never, () => null)
    expect(tabs.list().map(d => d.id)).toContain('late')
    void notified
    expect(tabs.version()).toBeGreaterThan(before)
    release()
    await ctx.fiber.dispose()
  })
})

describe('ui-dashboard node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})

describe('ui-dashboard invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(DashboardInvariant)
    await fiber.await()
    expect(DashboardInvariant.name).toBe('dashboard-invariant')
    expect(DashboardInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
