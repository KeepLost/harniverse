// @vitest-environment jsdom
/**
 * View registration acceptance on the real framework stack: the plugin fiber
 * registers the stats tab into a real SlotRegistry view ring with a
 * locale-aware label, Definitions land in the real registries, the inject
 * face resolves the session binding (and refuses an unavailable one), and
 * fiber disposal removes every registration.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import {
  ConversationEventRegistry, ConversationViewRegistry, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as nodeApply } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

afterEach(cleanup)

const SID = 's1' as SessionId

async function boot(): Promise<{ ctx: Context; slots: SlotRegistry }> {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  await ctx.plugin(ConversationEventRegistry).await()
  await ctx.plugin(ConversationViewRegistry).await()
  slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  }, (_p: { renderSlot?: unknown }) => null)
  ctx.provide('sessions', { binding: () => undefined })
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  return { ctx, slots }
}

async function mount(ctx: Context): Promise<Awaited<ReturnType<Context['plugin']>>> {
  const locale = await import('@deepseek-ai/dsh-client-locale/client')
  ctx.plugin({ inject: [...locale.inject], apply: locale.apply })
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  return fiber
}

describe('stats view registration', () => {
  it('registers the tab, definitions, and view target; disposal removes them', async () => {
    const { ctx, slots } = await boot()
    const fiber = await mount(ctx)
    const events = ctx.get('conversationEvents') as ConversationEventRegistry
    const views = ctx.get('conversationViews') as ConversationViewRegistry
    const entry = slots.entries('conversation.view')[0]
    expect(entry?.options.id).toBe('stats')
    const label = entry?.options.label
    expect(typeof label === 'function' ? (label as () => string)() : label).toBe(en['view.label'])
    expect(events.entries().map(definition => definition.kind)).toEqual([
      'stats-step', 'stats-prompt', 'stats-turn-end', 'stats-compaction',
    ])
    expect(views.entries().map(definition => definition.target)).toEqual(['stats'])
    await fiber.dispose()
    expect(slots.entries('conversation.view')).toHaveLength(0)
    expect(events.entries()).toEqual([])
    expect(views.entries()).toEqual([])
  })

  it('resolves the load-older face through the session binding', async () => {
    const { ctx, slots } = await boot()
    const loadOlder = vi.fn(async () => {
      viewsSnapshot.set('stats', { rows: [2], totals: null })
    })
    const viewsSnapshot = new Map<string, { rows: unknown[]; totals: null }>([['stats', { rows: [], totals: null }]])
    const binding = {
      session: {
        getSnapshot: () => ({ views: { get: (target: string) => viewsSnapshot.get(target) } }),
        loadOlder,
      },
    }
    ;(ctx.sessions as unknown as { binding: (id: SessionId) => unknown }).binding = (id: SessionId) =>
      id === SID ? binding : undefined
    await mount(ctx)
    const entry = slots.entries('conversation.view')[0]
    if (entry?.inject === undefined) throw new Error('missing inject face')
    const injectFace = entry.inject as unknown as (id: SessionId) => { loadOlder: () => Promise<boolean> }
    const face = injectFace(SID)
    viewsSnapshot.set('stats', { rows: [1], totals: null })
    await expect(face.loadOlder()).resolves.toBe(true)
    loadOlder.mockImplementation(async () => undefined)
    await expect(face.loadOlder()).resolves.toBe(false)
    expect(loadOlder).toHaveBeenCalledTimes(2)
    expect(() => injectFace('missing' as SessionId)).toThrow(/unavailable/)
  })

  it('registers nothing from the node half', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
