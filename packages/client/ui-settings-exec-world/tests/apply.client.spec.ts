/**
 * Registration, lifecycle, and the namespace narrowing contract: one apply
 * registers the dictionaries and the `exec-world` settings section bound
 * to the host `exec-world` settings namespace, every registration leaves
 * with the plugin fiber (the HMR-safety rule), and the decode only accepts
 * the shapes the host schema can actually resolve.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry, type SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { ExecWorldSection } from '../src/client/ExecWorldSection.tsx'
import { decodeExecWorldSection, EXEC_WORLD_NS } from '../src/client/decode.ts'
import { zh } from '../src/client/locales.ts'
import type { ExecWorldSectionValue } from '../src/client/decode.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

/** Build one client bench with the plugin's service doubles. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const setMock = vi.fn(async () => {})
  const scope: SettingsScope<ExecWorldSectionValue> = {
    getSnapshot: () => ({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }),
    subscribe: () => () => {},
    set: setMock,
    unset: setMock,
  }
  const bind = vi.fn(() => scope)
  ctx.provide('settingsScope', { describe: () => scope, bind })
  return { ctx, slots: ctx.slots, scope, bind, setMock }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-settings-exec-world apply', () => {
  it('declares exactly the services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
  })

  it('keeps the node-half apply as the surface no-op', () => {
    applyNode()
  })

  it('binds the exec-world namespace and registers the section at order 17 with the shipped label', async () => {
    const { ctx, slots, scope, bind, setMock } = await bench()
    declareRoot(slots)

    await ctx.plugin({ apply, inject }).await()

    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ namespace: EXEC_WORLD_NS }))
    const section = slots.entries('settings.section').find(entry => entry.options.id === 'exec-world')
    expect(section?.component).toBe(ExecWorldSection)
    expect(section?.options).toMatchObject({ id: 'exec-world', order: 17 })
    expect(resolveSlotLabel(section?.options.label)).toBe(zh.nav)
    // The inject face hands the section the bound scope plus the write callback.
    const injectFace = section?.inject as (() => unknown) | undefined
    expect(injectFace).toBeTypeOf('function')
    const face = injectFace?.() as {
      hooks: { scope: unknown }
      set: (field: string, value: unknown) => Promise<void>
    }
    expect(face.hooks.scope).toBe(scope)
    await face.set('world', 'vm')
    expect(setMock).toHaveBeenCalledWith('world', 'vm')
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

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})

describe('decodeExecWorldSection', () => {
  it('accepts each stored preference', () => {
    expect(decodeExecWorldSection({ world: 'vm' })).toEqual({ world: 'vm' })
    expect(decodeExecWorldSection({ world: 'local' })).toEqual({ world: 'local' })
  })

  it('defaults an absent world to local', () => {
    expect(decodeExecWorldSection({})).toEqual({ world: 'local' })
  })

  it('rejects a non-object section', () => {
    expect(decodeExecWorldSection('vm')).toBeUndefined()
    expect(decodeExecWorldSection(null)).toBeUndefined()
  })

  it('rejects an unknown or wrongly typed world', () => {
    expect(decodeExecWorldSection({ world: 'cloud' })).toBeUndefined()
    expect(decodeExecWorldSection({ world: 7 })).toBeUndefined()
  })
})
