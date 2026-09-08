/**
 * apply wiring on a real cordis Context + SlotRegistry: InputTriggerService mounts
 * as ctx.inputTriggers once its sessions dependency is up; the MenuView overlay and
 * CommandSeat commands registrations follow the slot declarations, resolve the
 * per-session controller from the slot's sessionId, and unregister on fiber teardown.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { createScope, scopeOf, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject, InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { CommandSeatInjected, MenuViewInjected } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const sid = (k: string): SessionId => k as SessionId

// The sessions face: scope resolution for controllers.
function sessionsFaceOver(scope: { ctx: Context }) {
  return {
    scope: (id: SessionId) => (id === sid('a') ? scope.ctx : undefined),
    scopeOf: (c: Context) => scopeOf(c),
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  // Stand-in for the ui-conversation composer entry: declare the overlay and
  // commands slots without providing ConversationController, which is not
  // their lifecycle signal.
  slots.register(
    {
      name: 'root',
      children: {
        'conversation.input.overlay': { kind: 'list', scope: 'session' },
        'conversation.input.commands': { kind: 'single', scope: 'session' },
      },
    } as never,
    () => null,
  )
  // Sessions face: mint one real scope for session 'a' and resolve it by id.
  const scope = createScope(ctx, sid('a'))
  ctx.provide('sessions', sessionsFaceOver(scope))
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return { ctx, slots, locale }
}

describe('apply', () => {
  it('declares the sessions and locale dependencies (scope tree + localized menu copy)', () => {
    expect(inject).toEqual(['sessions', 'locale'])
  })

  it('registers the bilingual menu dictionaries (group titles by source name + the pending row)', async () => {
    const { ctx, locale } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const t = locale.bind('slash.menu')
    expect(t('command')).toBe('命令')
    locale.setLocale('en')
    expect(t('skill')).toBe('Skills')
    expect(t('subagent')).toBe('Subagents')
    expect(t('loading')).toBe('Loading…')
  })

  it('mounts ctx.inputTriggers once sessions is up, before any conversation service exists', async () => {
    const { ctx } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(ctx.get('inputTriggers')).toBeInstanceOf(InputTriggerService)
  })

  it('registers MenuView into the overlay and resolves the per-session controller by slot sessionId', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('conversation.input.overlay')).toHaveLength(1)
    const entries = slots.entries('conversation.input.overlay')
    expect(entries[0]!.options.id).toBe('slash-menu')
    // Copy rides the standard locale seat, not the business face.
    expect(entries[0]!.locale).toBe('slash.menu')

    const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
    // StoredEntry.inject is declaration-typed ((...args: never[]) shape);
    // the erased registration widens it past a direct cast, so hop unknown.
    const injectEntry = entries[0]!.inject as unknown as (sessionId: SessionId) => MenuViewInjected
    const injected = injectEntry(sid('a'))
    const controller = inputTriggers.sessionOf(
      (ctx.get('sessions') as { scope(id: SessionId): Context }).scope(sid('a')),
    )
    expect(injected.menu).toBe(controller.menu)
    // The pick face routes into the controller pipeline (closed menu → no-op).
    injected.onPick('command', 0)
    expect(controller.menu.getSnapshot().open).toBe(false)
    // The dismiss face routes into the controller too (closed menu → no-op).
    injected.onDismiss()
    expect(controller.menu.getSnapshot().open).toBe(false)
    // An unknown session id fails loud (no silent scope miss).
    expect(() => injectEntry(sid('ghost'))).toThrow(/resolved no scope/)
  })

  it('registers CommandSeat into the commands seat; its face aims a synthetic \'/\' hit through the controller', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('conversation.input.commands')).toHaveLength(1)
    const entry = slots.entries('conversation.input.commands')[0]!
    expect(entry.locale).toBe('slash.menu')

    const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
    const injectSeat = entry.inject as unknown as (sessionId: SessionId) => CommandSeatInjected
    const face = injectSeat(sid('a'))
    const controller = inputTriggers.sessionOf(
      (ctx.get('sessions') as { scope(id: SessionId): Context }).scope(sid('a')),
    )
    // The launcher hook rides the controller's store (the expanded-state source).
    expect(face.hooks.launcher).toBe(controller.launcher)
    const toggleSource = vi.spyOn(controller, 'toggleSource')
    const dismissPopup = () => {}
    // The aimed position derives from the captured bar context: a blank draft
    // before the selection is a leading trigger, anything else is inline.
    face.toggle({
      selection: { start: 0, end: 0 },
      leading: true,
      draftRev: 7,
      dismissPopup,
    })
    face.toggle({
      selection: { start: 4, end: 4 },
      leading: false,
      draftRev: 7,
      dismissPopup,
    })
    expect(toggleSource).toHaveBeenNthCalledWith(1, 'command', {
      trigger: '/',
      query: '',
      position: 'leading',
      span: { start: 0, end: 0, draftRev: 7 },
    })
    expect(toggleSource).toHaveBeenNthCalledWith(2, 'command', {
      trigger: '/',
      query: '',
      position: 'inline',
      span: { start: 4, end: 4, draftRev: 7 },
    })
    // No source named 'command' is registered on this bare bench: the toggle
    // collapses to a dismiss (the roster guard), proving the hit reached the
    // controller pipeline without throwing.
    expect(controller.menu.getSnapshot().open).toBe(false)
    expect(controller.launcher.getSnapshot()).toBeNull()
    // An unknown session id fails loud (no silent scope miss).
    expect(() => injectSeat(sid('ghost'))).toThrow(/resolved no scope/)
  })

  it('fiber teardown removes the overlay and commands entries', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('conversation.input.overlay')).toHaveLength(1)
    expect(slots.entries('conversation.input.commands')).toHaveLength(1)

    await fiber.dispose()
    expect(slots.entries('conversation.input.overlay')).toHaveLength(0)
    expect(slots.entries('conversation.input.commands')).toHaveLength(0)
    expect(ctx.get('inputTriggers')).toBeUndefined()
  })
})
