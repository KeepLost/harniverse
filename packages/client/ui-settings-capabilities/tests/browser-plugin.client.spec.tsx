// @vitest-environment jsdom

import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { CapabilityCompositionTab } from '../src/client/CapabilityCompositionTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

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
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, catalog, list }
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
})

describe('ui-settings-capabilities node half', () => {
  it('contributes no host behavior', () => {
    // Capability management lives in its authorized Host package; this seat
    // exists only so the plugin appears in the Loader tree.
    expect(() => { nodeApply() }).not.toThrow()
  })
})
