/**
 * Registration, lifecycle, and the namespace narrowing contract: one apply
 * registers the dictionaries and the `shell-backend` settings section bound
 * to the host `shell-backend` settings namespace, every registration leaves
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
import { ShellBackendSection } from '../src/client/ShellBackendSection.tsx'
import { decodeShellBackendSection, SHELL_BACKEND_NS } from '../src/client/decode.ts'
import { zh } from '../src/client/locales.ts'
import type { ShellBackendSectionValue } from '../src/client/decode.ts'

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
  const scope: SettingsScope<ShellBackendSectionValue> = {
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

describe('ui-settings-shell-backend apply', () => {
  it('declares exactly the services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
  })

  it('keeps the node-half apply as the surface no-op', () => {
    applyNode()
  })

  it('binds the shell-backend namespace and registers the section at order 14 with the shipped label', async () => {
    const { ctx, slots, scope, bind, setMock } = await bench()
    declareRoot(slots)

    await ctx.plugin({ apply, inject }).await()

    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ namespace: SHELL_BACKEND_NS }))
    const section = slots.entries('settings.section').find(entry => entry.options.id === 'shell-backend')
    expect(section?.component).toBe(ShellBackendSection)
    expect(section?.options).toMatchObject({ id: 'shell-backend', order: 14 })
    expect(resolveSlotLabel(section?.options.label)).toBe(zh.nav)
    // The inject face hands the section the bound scope plus the write callback.
    const injectFace = section?.inject as (() => unknown) | undefined
    expect(injectFace).toBeTypeOf('function')
    const face = injectFace?.() as {
      hooks: { scope: unknown }
      set: (field: string, value: unknown) => Promise<void>
    }
    expect(face.hooks.scope).toBe(scope)
    await face.set('backend', 'git-bash')
    expect(setMock).toHaveBeenCalledWith('backend', 'git-bash')
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

describe('decodeShellBackendSection', () => {
  it('accepts each stored preference', () => {
    expect(decodeShellBackendSection({ backend: 'git-bash' })).toEqual({ backend: 'git-bash' })
    expect(decodeShellBackendSection({ backend: 'platform-default' })).toEqual({ backend: 'platform-default' })
  })

  it('defaults an absent backend to the platform default', () => {
    expect(decodeShellBackendSection({})).toEqual({ backend: 'platform-default' })
  })

  it('rejects a non-object section', () => {
    expect(decodeShellBackendSection('git-bash')).toBeUndefined()
    expect(decodeShellBackendSection(null)).toBeUndefined()
  })

  it('rejects an unknown or wrongly typed backend', () => {
    expect(decodeShellBackendSection({ backend: 'wsl' })).toBeUndefined()
    expect(decodeShellBackendSection({ backend: 7 })).toBeUndefined()
  })
})
