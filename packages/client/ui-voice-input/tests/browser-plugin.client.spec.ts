/**
 * ui-voice-input plugin halves: the browser entry's dictionary, composer
 * seat, and settings-section registrations against the real SlotRegistry
 * (fiber teardown proving removal — HMR safety), the inert node entry, and
 * the invariant companion's ownership reservation.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as VoiceInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Slot ledger reader: entry ids currently registered in one of our seats. */
function entryIds(ctx: Context, slot: 'conversation.input.left' | 'settings.section'): (string | undefined)[] {
  return ctx.slots.entries(slot).map(entry => entry.options.id)
}

/** Boot the browser half over a real slot tree declaring both target seats. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('sessions', { scope: () => undefined })
  ctx.provide('connection', { api: { speech: {} } } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('ui-voice-input browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'sessions', 'settingsScope'])
  })

  it('registers the composer seat and the settings section, and fiber teardown removes both (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(entryIds(ctx, 'conversation.input.left')).toContain('voice-input')
    expect(entryIds(ctx, 'settings.section')).toContain('voice')
    await fiber.dispose()
    expect(entryIds(ctx, 'conversation.input.left')).not.toContain('voice-input')
    expect(entryIds(ctx, 'settings.section')).not.toContain('voice')
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('mic.start')).toBe(zh['mic.start'])
    ctx.locale.setLocale('en')
    expect(translate('mic.start')).toBe(en['mic.start'])
    await fiber.dispose()
    expect(translate('mic.start')).not.toBe(en['mic.start'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-voice-input node half', () => {
  it('contributes no host behavior', () => {
    expect(applyNode).not.toThrow()
  })
})

describe('ui-voice-input invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(VoiceInvariant)
    await fiber.await()
    expect(VoiceInvariant.name).toBe('client-ui-voice-invariant')
    expect(VoiceInvariant.inject).toEqual(['invariants'])
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
