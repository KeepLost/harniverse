// @vitest-environment jsdom
/**
 * ui-browser plugin halves: the browser entry's dictionary and slot
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal — HMR safety), the node entry against the real settings Service
 * Definition, and the invariant companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SettingsProvider, { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { BROWSER_SETTINGS_NAMESPACE, apply as applyNode, inject as nodeInject } from '../src/index.ts'
import * as BrowserInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** One registration captured while the plugin applies. */
interface CapturedRegistration { options: Record<string, unknown>; component: unknown }

/** Minimal in-memory provider: the smallest real SettingsProvider subclass. */
class MemorySettings extends SettingsProvider {
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(): Promise<void> { return Promise.resolve() }
}

/** Boot the browser half over a real slot tree declaring both contributions. */
async function bench(): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  captured: CapturedRegistration[]
  layoutCalls: string[]
  configStub: ReturnType<typeof stubSettingsScope>
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
  ctx.provide('sessions', {})
  // The locale plugin binds a settings scope over the connection handle and
  // subscribes through the remote event surface.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  const configStub = stubSettingsScope()
  ctx.provide('settingsScope', { bind: () => configStub.scope } as never)
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
  return { ctx, fiber, captured, layoutCalls, configStub }
}

describe('ui-browser browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope', 'layout'])
  })

  it('registers both slots after their targets, and fiber teardown removes them (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('sidebar.footer.action').map(entry => entry.options.id)).toContain('browser-view')
    expect(ctx.slots.entries('center.view').map(entry => entry.options.id)).toContain('browser')
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.footer.action')).toEqual([])
    expect(ctx.slots.entries('center.view')).toEqual([])
  })

  it('shares one view store between the footer trigger and the panel', async () => {
    const { captured } = await bench()
    const trigger = captured.find(({ options }) => options['id'] === 'browser-view')
    const view = captured.find(({ options }) => options['id'] === 'browser')
    expect(trigger).toBeDefined()
    expect(view).toBeDefined()
    expect(trigger!.options['store']).toBe(view!.options['store'])
  })

  it('orders the footer trigger after the schedules and governor triggers', async () => {
    const { captured } = await bench()
    const trigger = captured.find(({ options }) => options['id'] === 'browser-view')
    expect(trigger!.options['order']).toBe(30)
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    // jsdom's navigator reports English: pin the locale before asserting.
    ctx.locale.setLocale('zh')
    const translate = ctx.locale.bind(NS)
    expect(translate('view.nav')).toBe(zh['view.nav'])
    ctx.locale.setLocale('en')
    expect(translate('view.nav')).toBe(en['view.nav'])
    await fiber.dispose()
    expect(translate('view.nav')).not.toBe(en['view.nav'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('binds the trigger to occupying the center column and the panel to releasing it', async () => {
    const { captured, layoutCalls } = await bench()
    const trigger = captured.find(({ options }) => options['id'] === 'browser-view')
    const view = captured.find(({ options }) => options['id'] === 'browser')
    const triggerFace = trigger!.options['inject'] as () => { openView: () => void }
    triggerFace().openView()
    const viewFace = view!.options['inject'] as () => { closeView: () => void }
    viewFace().closeView()
    expect(layoutCalls).toEqual(['set:browser', 'clear'])
  })

  it('binds the panel to the browser settings scope and the harness origin', async () => {
    const { captured, configStub } = await bench()
    const view = captured.find(({ options }) => options['id'] === 'browser')
    expect(view).toBeDefined()
    const face = view!.options['inject'] as () => {
      hooks: { config: unknown }
      selfOrigin: string
      closeView: () => void
    }
    const injected = face()
    expect(injected.hooks.config).toBe(configStub.scope)
    expect(injected.selfOrigin).toBe(location.origin)
  })
})

describe('ui-browser node half', () => {
  it('declares the settings service injection and the section namespace', () => {
    expect(nodeInject).toEqual(['settings'])
    expect(BROWSER_SETTINGS_NAMESPACE).toBe(settingsNamespace('browser'))
  })

  it('registers the section over the real settings service and withdraws with the fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({
      inject: [...nodeInject],
      apply: (nodeCtx) => { applyNode(nodeCtx, { allowedHosts: ['example.com'] }) },
    })
    await fiber.await()
    expect(ctx.settings.get(BROWSER_SETTINGS_NAMESPACE)).toEqual({ allowedHosts: ['example.com'] })
    await fiber.dispose()
    expect(ctx.settings.get(BROWSER_SETTINGS_NAMESPACE)).toBeUndefined()
  })

  it('accepts an omitted config: the resolver materializes the empty allowlist', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ inject: [...nodeInject], apply: (nodeCtx) => { applyNode(nodeCtx) } })
    await fiber.await()
    // Absent arrays resolve to [] (schemastery materializes them); the panel's
    // settings seam lifts an empty allowlist back to open browsing.
    expect(ctx.settings.get(BROWSER_SETTINGS_NAMESPACE)).toEqual({ allowedHosts: [] })
  })

  it('fails loudly on allowlist entries that are not bare hostnames', () => {
    const fakeCtx = { settings: { register: () => () => {} } }
    const entries = [
      '', 'example.com/path', 'example.com?q=1', 'example.com#f', 'user@example.com', 'example.com:8080', 'two words',
    ]
    for (const entry of entries) {
      expect(() => { applyNode(fakeCtx as never, { allowedHosts: [entry] }) }).toThrow(/bare hostnames/)
    }
  })
})

describe('ui-browser invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(BrowserInvariant)
    await fiber.await()
    expect(BrowserInvariant.name).toBe('browser-panel-invariant')
    expect(BrowserInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
