/**
 * ui-scheduler plugin halves: the browser entry's dictionary and slot
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
import * as ScheduleInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Slot ledger reader: entry ids currently registered in the header list. */
function headerEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('conversation.session.header.actions')
    .map(entry => entry.options.id)
}

/** One registration captured while the plugin applies. */
interface CapturedRegistration { options: Record<string, unknown>; component: unknown }

/** Boot the browser half over a real slot tree declaring both contributions. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']>; captured: CapturedRegistration[] }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'global' },
    },
  } as never, () => null)
  ctx.provide('sessions', {})
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', {
    $on: () => () => {},
    scheduler: {
      list: async () => ({ ok: true, value: [] }),
      create: async () => ({ ok: true, value: undefined }),
      update: async () => ({ ok: true, value: undefined }),
      runs: async () => ({ ok: true, value: [] }),
      delete: async () => ({ ok: true, value: false }),
    },
  } as never)
  ctx.provide('remote.scheduler', {
    list: async () => ({ ok: true, value: [] }),
    update: async () => ({ ok: true, value: undefined }),
    remove: async () => ({ ok: true, value: false }),
  } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
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
  return { ctx, fiber, captured }
}

describe('ui-scheduler browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'slots', 'locale', 'remote', 'remote.scheduler'])
  })

  it('registers both slots, and fiber teardown removes them (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(headerEntryIds(ctx)).toContain('schedule-list')
    expect(ctx.slots.entries('settings.section').map(entry => entry.options.id)).toContain('schedules')
    await fiber.dispose()
    expect(headerEntryIds(ctx)).not.toContain('schedule-list')
    expect(ctx.slots.entries('settings.section')).toEqual([])
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('list.aria')).toBe(zh['list.aria'])
    ctx.locale.setLocale('en')
    expect(translate('list.aria')).toBe(en['list.aria'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('list.aria')).not.toBe(en['list.aria'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('binds the slot inject verbs to the scheduler Remote per session', async () => {
    const { ctx, captured } = await bench()
    const registration = captured.find(({ options }) => options['id'] === 'schedule-list')
    expect(registration).toBeDefined()
    const inject = registration!.options['inject'] as (sessionId: string) => {
      onRefresh: () => Promise<unknown>
      onUpdate: (id: string, patch: { status?: 'active' | 'paused' }) => Promise<unknown>
      onRemove: (id: string) => Promise<unknown>
    }
    const calls: unknown[][] = []
    const scheduler = (ctx.get('remote') as unknown as { scheduler: Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined> }).scheduler
    for (const name of ['list', 'update', 'delete']) {
      const verb = scheduler[name]
      scheduler[name] = async (...args: unknown[]) => {
        calls.push([name, ...args])
        if (verb === undefined) throw new Error(`unexpected remote verb: ${name}`)
        return await verb(...args)
      }
    }
    const verbs = inject('session-z')
    await verbs.onRefresh()
    await verbs.onUpdate('sched-9', { status: 'paused' })
    await verbs.onRemove('sched-9')
    expect(calls).toEqual([
      ['list', 'session-z'],
      ['update', 'session-z', 'sched-9', { status: 'paused' }],
      ['delete', 'session-z', 'sched-9'],
    ])
  })

  it('binds the settings section verbs to the scheduler Remote', async () => {
    const { ctx, fiber, captured } = await bench()
    const registration = captured.find(({ options }) => options['id'] === 'schedules')
    expect(registration).toBeDefined()
    const label = registration!.options['label'] as () => string
    expect(label()).toBe(zh['management.nav'])
    const inject = registration!.options['inject'] as () => {
      list: (sessionId: string) => Promise<unknown>
      create: (sessionId: string, input: unknown) => Promise<unknown>
      update: (sessionId: string, id: string, input: unknown) => Promise<unknown>
      runs: (sessionId: string, id: string) => Promise<unknown>
      remove: (sessionId: string, id: string) => Promise<unknown>
    }
    const calls: unknown[][] = []
    const scheduler = (ctx.get('remote') as unknown as { scheduler: Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined> }).scheduler
    for (const name of ['list', 'create', 'update', 'runs', 'delete']) {
      const verb = scheduler[name]
      scheduler[name] = async (...args: unknown[]) => {
        calls.push([name, ...args])
        if (verb === undefined) throw new Error(`unexpected remote verb: ${name}`)
        return await verb(...args)
      }
    }
    const verbs = inject()
    await expect(verbs.list('session-z')).resolves.toEqual({ ok: true, value: [] })
    await expect(verbs.create('session-z', { prompt: 'new' })).resolves.toEqual({ ok: true, value: undefined })
    await expect(verbs.update('session-z', 'sched-9', { status: 'paused' })).resolves.toEqual({ ok: true, value: undefined })
    await expect(verbs.runs('session-z', 'sched-9')).resolves.toEqual({ ok: true, value: [] })
    await expect(verbs.remove('session-z', 'sched-9')).resolves.toEqual({ ok: true, value: false })
    expect(calls).toEqual([
      ['list', 'session-z'],
      ['create', 'session-z', { prompt: 'new' }],
      ['update', 'session-z', 'sched-9', { status: 'paused' }],
      ['runs', 'session-z', 'sched-9'],
      ['delete', 'session-z', 'sched-9'],
    ])
    await fiber.dispose()
  })
})

describe('ui-scheduler node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})

describe('ui-scheduler invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ScheduleInvariant)
    await fiber.await()
    expect(ScheduleInvariant.name).toBe('client-ui-scheduler-invariant')
    expect(ScheduleInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
