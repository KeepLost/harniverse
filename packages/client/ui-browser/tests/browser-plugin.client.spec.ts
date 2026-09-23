// @vitest-environment jsdom
/**
 * ui-browser plugin halves: the browser entry's dictionary and slot
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal — HMR safety), the panel controller wiring inside apply over the
 * connection handle, the inert node entry, and the invariant companion's
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
import * as BrowserInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** One registration captured while the plugin applies. */
interface CapturedRegistration { options: Record<string, unknown>; component: unknown }

/** The inject face the center view receives (verbs + panel state source). */
interface BrowserFace {
  hooks: {
    panel: { getSnapshot: () => { session: unknown } }
  }
  closeView: () => void
  bindSession: (sessionId: unknown) => void
}

/** Boot the browser half over a real slot tree declaring both contributions. */
async function bench(): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  captured: CapturedRegistration[]
  layoutCalls: string[]
  rpcCalls: Array<{ channel: string; endpoint: string }>
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'workbench.section.tab': { kind: 'list', scope: 'global' },
      'workbench.section.panel': { kind: 'list', scope: 'global' },
    },
  } as never, () => null)
  ctx.provide('sessions', {})
  // The locale plugin binds a settings scope, which reads the connection
  // handle; the browser panel's controller rides the same handle's RPC face
  // and its `browser` event stream.
  const rpcCalls: Array<{ channel: string; endpoint: string }> = []
  ctx.provide('connection', {
    api: {
      settings: {},
      events: {
        browser: () => ({
          [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
        }),
      },
    },
    isLoopback: false,
    rpc: {
      call: async (channel: string, endpoint: string) => {
        rpcCalls.push({ channel, endpoint })
        return { ok: true, value: endpoint === 'browser/list' ? [] : undefined }
      },
    },
  } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const layoutCalls: string[] = []
  ctx.provide('layout', {
    openWorkbench: () => { layoutCalls.push('open') },
    closeWorkbench: () => { layoutCalls.push('close') },
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
  return { ctx, fiber, captured, layoutCalls, rpcCalls }
}

describe('ui-browser browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout', 'connection'])
  })

  it('registers both slots after their targets, and fiber teardown removes them (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('workbench.section.tab').map(entry => entry.options.id)).toContain('browser')
    expect(ctx.slots.entries('workbench.section.panel').map(entry => entry.options.id)).toContain('browser')
    await fiber.dispose()
    expect(ctx.slots.entries('workbench.section.tab')).toEqual([])
    expect(ctx.slots.entries('workbench.section.panel')).toEqual([])
  })

  it('orders the section tab before the terminal section tab', async () => {
    const { captured } = await bench()
    const tab = captured.find(({ options }) => options['name'] === 'workbench.section.tab')
    expect(tab!.options['order']).toBe(10)
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

  it('binds the section body to closing the workbench', async () => {
    const { captured, layoutCalls } = await bench()
    const view = captured.find(({ options }) => options['name'] === 'workbench.section.panel')
    const viewFace = view!.options['inject'] as () => BrowserFace
    viewFace().closeView()
    expect(layoutCalls).toEqual(['close'])
  })

  it('wires the panel controller over the connection handle inside apply', async () => {
    const { captured, rpcCalls } = await bench()
    const view = captured.find(({ options }) => options['name'] === 'workbench.section.panel')
    expect(view).toBeDefined()
    const face = view!.options['inject'] as () => BrowserFace
    const injected = face()
    expect(typeof injected.hooks.panel.getSnapshot).toBe('function')
    // The panel state source publishes the bound session through the verbs.
    injected.bindSession('session-z')
    expect(injected.hooks.panel.getSnapshot().session).toBe('session-z')
    // The session load rides the shared /api logical channel.
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(rpcCalls.map(call => [call.channel, call.endpoint])).toEqual([
      ['/api', 'browser/environment'],
      ['/api', 'browser/list'],
    ])
  })
})

describe('ui-browser node half', () => {
  it('is inert: the node entry exists only so the plugin appears in the Loader tree', () => {
    expect(applyNode).not.toThrow()
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
