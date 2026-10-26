/**
 * Registration, lifecycle, and the namespace narrowing contract: one apply
 * registers the dictionaries and the `network-proxy` settings section bound
 * to the host `network-proxy` settings namespace, every registration leaves
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
import { NetworkProxySection } from '../src/client/NetworkProxySection.tsx'
import { decodeNetworkProxySection, NETWORK_PROXY_NS } from '../src/client/decode.ts'
import { zh } from '../src/client/locales.ts'
import type { NetworkProxySectionValue } from '../src/client/decode.ts'

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
  const unsetMock = vi.fn(async () => {})
  const scope: SettingsScope<NetworkProxySectionValue> = {
    getSnapshot: () => ({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }),
    subscribe: () => () => {},
    set: setMock,
    unset: unsetMock,
  }
  const bind = vi.fn(() => scope)
  ctx.provide('settingsScope', { describe: () => scope, bind })
  return { ctx, slots: ctx.slots, scope, bind, setMock, unsetMock }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-settings-network-proxy apply', () => {
  it('declares exactly the services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
  })

  it('keeps the node-half apply as the surface no-op', () => {
    applyNode()
  })

  it('binds the network-proxy namespace and registers the section at order 13 with the shipped label', async () => {
    const { ctx, slots, scope, bind, setMock, unsetMock } = await bench()
    declareRoot(slots)

    await ctx.plugin({ apply, inject }).await()

    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ namespace: NETWORK_PROXY_NS }))
    const section = slots.entries('settings.section').find(entry => entry.options.id === 'network-proxy')
    expect(section?.component).toBe(NetworkProxySection)
    expect(section?.options).toMatchObject({ id: 'network-proxy', order: 13 })
    expect(resolveSlotLabel(section?.options.label)).toBe(zh.nav)
    // The inject face hands the section the bound scope plus write callbacks.
    const injectFace = section?.inject as (() => unknown) | undefined
    expect(injectFace).toBeTypeOf('function')
    const face = injectFace?.() as {
      hooks: { scope: unknown }
      set: (field: string, value: unknown) => Promise<void>
      unset: (field: string) => Promise<void>
    }
    expect(face.hooks.scope).toBe(scope)
    await face.set('mode', 'manual')
    await face.unset('url')
    expect(setMock).toHaveBeenCalledWith('mode', 'manual')
    expect(unsetMock).toHaveBeenCalledWith('url')
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

describe('decodeNetworkProxySection', () => {
  it('accepts a full manual section', () => {
    expect(decodeNetworkProxySection({ mode: 'manual', url: 'http://127.0.0.1:7890', noProxy: ['localhost'] }))
      .toEqual({ mode: 'manual', url: 'http://127.0.0.1:7890', noProxy: ['localhost'] })
  })

  it('defaults an absent mode to off and drops absent optionals', () => {
    expect(decodeNetworkProxySection({})).toEqual({ mode: 'off' })
  })

  it('rejects a non-object section', () => {
    expect(decodeNetworkProxySection('manual')).toBeUndefined()
    expect(decodeNetworkProxySection(null)).toBeUndefined()
  })

  it('rejects an unknown mode or wrongly typed fields', () => {
    expect(decodeNetworkProxySection({ mode: 'socks' })).toBeUndefined()
    expect(decodeNetworkProxySection({ mode: 'off', url: 7 })).toBeUndefined()
    expect(decodeNetworkProxySection({ mode: 'off', noProxy: 'localhost' })).toBeUndefined()
    expect(decodeNetworkProxySection({ mode: 'off', noProxy: ['localhost', 3] })).toBeUndefined()
  })
})
