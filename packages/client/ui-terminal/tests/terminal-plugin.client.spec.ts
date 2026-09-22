// @vitest-environment jsdom
/**
 * ui-terminal plugin halves: the browser entry's dictionary and slot
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal — HMR safety), the controller wiring inside apply over the
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
import * as TerminalInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** One registration captured while the plugin applies. */
interface CapturedRegistration { options: Record<string, unknown>; component: unknown }

/** The inject face the center view receives (verbs + panel state source). */
interface TerminalFace {
  hooks: { terminals: { getSnapshot: () => { session: unknown } } }
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
      'sidebar.footer.action': { kind: 'list', scope: 'global' },
      'center.view': { kind: 'list', scope: 'global' },
    },
  } as never, () => null)
  ctx.provide('sessions', {})
  // The locale plugin binds a settings scope, which reads the connection
  // handle; the terminal panel's controller rides the same handle's RPC face.
  const rpcCalls: Array<{ channel: string; endpoint: string }> = []
  ctx.provide('connection', {
    api: { settings: {}, events: {} },
    isLoopback: false,
    rpc: {
      call: async (channel: string, endpoint: string) => {
        rpcCalls.push({ channel, endpoint })
        return { ok: true, value: endpoint === 'terminal/list' ? [] : undefined }
      },
    },
  } as never)
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
  return { ctx, fiber, captured, layoutCalls, rpcCalls }
}

describe('ui-terminal browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout', 'connection'])
  })

  it('registers both slots after their targets, and fiber teardown removes them (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('sidebar.footer.action').map(entry => entry.options.id)).toContain('terminal-view')
    expect(ctx.slots.entries('center.view').map(entry => entry.options.id)).toContain('terminal')
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.footer.action')).toEqual([])
    expect(ctx.slots.entries('center.view')).toEqual([])
  })

  it('shares one view store between the footer trigger and the panel', async () => {
    const { captured } = await bench()
    const trigger = captured.find(({ options }) => options['id'] === 'terminal-view')
    const view = captured.find(({ options }) => options['id'] === 'terminal')
    expect(trigger).toBeDefined()
    expect(view).toBeDefined()
    expect(trigger!.options['store']).toBe(view!.options['store'])
  })

  it('orders the footer trigger after the browser trigger', async () => {
    const { captured } = await bench()
    const trigger = captured.find(({ options }) => options['id'] === 'terminal-view')
    expect(trigger!.options['order']).toBe(40)
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
    const trigger = captured.find(({ options }) => options['id'] === 'terminal-view')
    const view = captured.find(({ options }) => options['id'] === 'terminal')
    const triggerFace = trigger!.options['inject'] as () => { openView: () => void }
    triggerFace().openView()
    const viewFace = view!.options['inject'] as () => TerminalFace
    viewFace().closeView()
    expect(layoutCalls).toEqual(['set:terminal', 'clear'])
  })

  it('wires the panel controller over the connection handle inside apply', async () => {
    const { captured, rpcCalls } = await bench()
    const view = captured.find(({ options }) => options['id'] === 'terminal')
    expect(view).toBeDefined()
    const face = view!.options['inject'] as () => TerminalFace
    const injected = face()
    expect(typeof injected.hooks.terminals.getSnapshot).toBe('function')
    // The panel state source publishes the bound session through the verbs.
    injected.bindSession('session-z')
    expect(injected.hooks.terminals.getSnapshot().session).toBe('session-z')
    // The session load rides the shared /api logical channel.
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(rpcCalls.map(call => [call.channel, call.endpoint])).toEqual([
      ['/api', 'terminal/environment'],
      ['/api', 'terminal/shells'],
      ['/api', 'terminal/list'],
    ])
  })
})

describe('ui-terminal node half', () => {
  it('is inert: the node entry exists only so the plugin appears in the Loader tree', () => {
    expect(applyNode).not.toThrow()
  })
})

describe('ui-terminal invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(TerminalInvariant)
    await fiber.await()
    expect(TerminalInvariant.name).toBe('terminal-panel-invariant')
    expect(TerminalInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
