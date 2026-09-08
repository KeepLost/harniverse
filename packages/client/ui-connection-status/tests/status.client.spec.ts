// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHealthState } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

usePinnedBrowserLanguages('en')

describe('read-only sidebar connection status', () => {
  it('waits for its declaration, reflects live health, and offers no action', async () => {
    const runtime = await SlotTestRuntime.create()
    hostApply()
    await runtime.ctx.plugin(InvariantRegistry, { enabled: true })
    await runtime.ctx.plugin(Invariant).await()
    let state: ConnectionHealthState = 'connecting'
    const listeners = new Set<() => void>()
    runtime.provide('connection', { health: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    try {
      const plugin = await runtime.mount({ apply, inject })
      expect(runtime.slots.entries('sidebar.header.status')).toHaveLength(0)
      await runtime.declare({ 'sidebar.header.status': { kind: 'single', scope: 'root' } })
      const view = runtime.renderSlot('sidebar.header.status', { wide: true })
      for (const next of Object.keys(en) as ConnectionHealthState[]) {
        await act(async () => { state = next; for (const listener of listeners) listener() })
        const indicator = view.view.getByRole('img', { name: en[next] })
        fireEvent.focus(indicator)
        expect(screen.getByRole('tooltip').textContent).toBe(en[next])
        fireEvent.pointerDown(indicator, { pointerType: 'mouse' })
        fireEvent.click(indicator)
        expect(view.view.queryByRole('button')).toBeNull()
        fireEvent.blur(indicator)
      }
      view.update({ wide: false })
      const touch = new Event('pointerdown', { bubbles: true })
      Object.defineProperty(touch, 'pointerType', { value: 'touch' })
      fireEvent(view.view.getByRole('img'), touch)
      expect(document.activeElement).toBe(view.view.getByRole('img'))
      await act(async () => { locale.setLocale('zh') })
      expect(view.view.getByRole('img', { name: zh.bypass })).toBeTruthy()
      await plugin.dispose()
      expect(runtime.slots.entries('sidebar.header.status')).toHaveLength(0)
      expect(listeners.size).toBe(0)
    } finally { await runtime.dispose() }
  })
})
