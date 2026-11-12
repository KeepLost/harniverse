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
async function bench(connection?: unknown) {
  const ctx = new Context()
  if (connection !== undefined) ctx.provide('connection', connection)
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
      probe: readonly { id: string; available: boolean }[] | undefined
    }
    expect(face.hooks.scope).toBe(scope)
    // No connection service: the probe badges stay absent, not broken.
    expect(face.probe).toBeUndefined()
    await face.set('default', 'posix')
    expect(setMock).toHaveBeenCalledWith('default', 'posix')
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

describe('boot probe badges', () => {
  it('mirrors the host description shell entries, and stays absent without a shell block', async () => {
    const withShell = await bench({
      hostDescription: { getSnapshot: () => ({ shell: { entries: [{ id: 'my-zsh', available: true }, { id: 'gone', available: false }] } }) },
    })
    declareRoot(withShell.slots)
    await withShell.ctx.plugin({ apply, inject }).await()
    const withFace = withShell.slots.entries('settings.section')[0]?.inject as () => { probe: unknown }
    expect(withFace().probe).toEqual([{ id: 'my-zsh', available: true }, { id: 'gone', available: false }])

    const bareHost = await bench({ hostDescription: { getSnapshot: () => ({}) } })
    declareRoot(bareHost.slots)
    await bareHost.ctx.plugin({ apply, inject }).await()
    const bareFace = bareHost.slots.entries('settings.section')[0]?.inject as () => { probe: unknown }
    expect(bareFace().probe).toBeUndefined()
    await withShell.ctx.fiber.dispose()
    await bareHost.ctx.fiber.dispose()
  })
})

describe('decodeShellBackendSection', () => {
  it('drops null, non-object, and unlabeled entry rows without failing the section', () => {
    expect(decodeShellBackendSection({
      default: 'my-zsh',
      entries: [null, 'nope', 42, { id: 'my-zsh', path: '/bin/zsh' }, { id: 'other', path: '/bin/sh', label: '' }],
    })).toEqual({ default: 'my-zsh', entries: [{ id: 'my-zsh', path: '/bin/zsh' }, { id: 'other', path: '/bin/sh' }] })
  })

  it('keeps the last accepted value on a non-array entries field', () => {
    expect(decodeShellBackendSection({ default: 'posix', entries: 'oops' })).toEqual({ default: 'posix', entries: [] })
  })

  it('accepts each stored default and narrows the entry list', () => {
    expect(decodeShellBackendSection({ default: 'posix' })).toEqual({ default: 'posix', entries: [] })
    expect(decodeShellBackendSection({ default: 'platform-default' })).toEqual({ default: 'platform-default', entries: [] })
    expect(decodeShellBackendSection({
      default: 'my-zsh',
      entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh', label: 'Work zsh' }, { id: 7, path: '/bin/bash' }],
    })).toEqual({ default: 'my-zsh', entries: [{ id: 'my-zsh', path: '/opt/homebrew/bin/zsh', label: 'Work zsh' }] })
  })

  it('defaults an absent default to the platform split', () => {
    expect(decodeShellBackendSection({})).toEqual({ default: 'platform-default', entries: [] })
  })

  it('rejects a non-object section', () => {
    expect(decodeShellBackendSection('posix')).toBeUndefined()
    expect(decodeShellBackendSection(null)).toBeUndefined()
  })

  it('rejects a wrongly typed default', () => {
    expect(decodeShellBackendSection({ default: 7 })).toBeUndefined()
  })
})
