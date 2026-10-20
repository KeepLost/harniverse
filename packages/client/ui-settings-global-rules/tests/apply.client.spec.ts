/**
 * Registration and lifecycle: one apply registers the dictionaries, the
 * `global-rules` settings section (id, order, live label), and its nav glyph,
 * and every registration leaves with the plugin fiber (the HMR-safety rule).
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { GlobalRulesSection } from '../src/client/GlobalRulesSection.tsx'
import { NavIcon } from '../src/client/NavIcon.tsx'
import { zh } from '../src/client/locales.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

/** Build one client bench with the plugin's service doubles. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const globalRulesFace = { marker: 'global-rules-face' }
  ctx.provide('connection', { api: { globalRules: globalRulesFace } })
  return { ctx, slots: ctx.slots, globalRulesFace }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.nav.icon': { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-settings-global-rules apply', () => {
  it('declares exactly the services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('keeps the node-half apply as the surface no-op', () => {
    applyNode()
  })

  it('registers the section at id global-rules with order 12, the shipped label, and the nav glyph', async () => {
    const { ctx, slots, globalRulesFace } = await bench()
    declareRoot(slots)

    await ctx.plugin({ apply, inject }).await()

    const section = slots.entries('settings.section').find(entry => entry.options.id === 'global-rules')
    expect(section?.component).toBe(GlobalRulesSection)
    expect(section?.options).toMatchObject({ id: 'global-rules', order: 12 })
    expect(resolveSlotLabel(section?.options.label)).toBe(zh.nav)
    expect(slots.entries('settings.nav.icon').map(entry => [entry.options.key, entry.component]))
      .toEqual([['global-rules', NavIcon]])
    // The inject face hands the section the connection's globalRules verbs.
    const injectFace = section?.inject as (() => unknown) | undefined
    expect(injectFace).toBeTypeOf('function')
    expect(injectFace?.()).toEqual({ api: globalRulesFace })
    await ctx.fiber.dispose()
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ apply, inject }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
    await ctx.fiber.dispose()
  })

  it('removes every registration with the plugin fiber', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = await ctx.plugin({ apply, inject }).await()
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(slots.entries('settings.nav.icon')).toHaveLength(1)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('settings.nav.icon')).toHaveLength(0)
  })
})
