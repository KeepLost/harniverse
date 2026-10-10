// @vitest-environment jsdom
/**
 * The settings nav glyph through the real slot machinery: the shell's apply
 * declares the keyed `settings.nav.icon` seat, the production renderer
 * dispatches it per nav row by section id, and a section without a
 * contribution keeps the settings gear. Registration is driven through the
 * real `slots.register` the owner packages use.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent } from '@testing-library/react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)

/** Test-owned sidebar frame occupying the hole the shell fills. */
type FrameProps = PropsRenderSlots<'sidebar.settings'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.settings', { wide: true })}</>
}

/** A contributed glyph standing in for an owner package's icon component. */
function ContributedGlyph() {
  return <svg data-testid="contributed-glyph" width="16" height="16" />
}

/** Runtime with the shell mounted, a Models section registered, and the panel open. */
async function openPanel() {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', { api: {}, isLoopback: false } as never)
  runtime.provide('settingsScope', {})
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({ 'sidebar.settings': { kind: 'single', scope: 'root' } }, SidebarFrame as never)
  await runtime.mount({ inject: [...inject], apply })
  runtime.slots.register(
    { name: 'settings.section', id: 'models', order: 10, label: '模型' } as never,
    (() => null) as never,
  )
  const view = runtime.renderRoot()
  await runtime.flush()
  fireEvent.click(view.getByRole('button', { name: '设置', expanded: false }))
  return { runtime, view }
}

describe('settings nav glyph assembly', () => {
  it('shows the settings gear for every section until an owner contributes a glyph', async () => {
    const { runtime, view } = await openPanel()
    const gear = view.getByRole('button', { name: '通用设置' }).querySelector('svg')
    expect(gear?.getAttribute('width')).toBe('16')
    expect(view.getByRole('button', { name: '模型' }).querySelector('svg')?.innerHTML).toBe(gear?.innerHTML)
    expect(view.queryByTestId('contributed-glyph')).toBeNull()
    await runtime.dispose()
  })

  it('swaps in the glyph registered for a section id, live and for that section only', async () => {
    const { runtime, view } = await openPanel()
    const gear = view.getByRole('button', { name: '通用设置' }).querySelector('svg')?.innerHTML

    let dispose = () => {}
    await act(async () => {
      dispose = runtime.slots.register(
        { name: 'settings.nav.icon', key: 'models' } as never,
        ContributedGlyph as never,
      )
      await Promise.resolve()
    })
    const models = view.getByRole('button', { name: '模型' })
    expect(models.querySelector('[data-testid="contributed-glyph"]')).toBeTruthy()
    expect(models.querySelectorAll('svg')).toHaveLength(1)
    expect(view.getByRole('button', { name: '通用设置' }).querySelector('svg')?.innerHTML).toBe(gear)

    // The contribution leaves with its registrant: the section is back on the gear.
    await act(async () => {
      dispose()
      await Promise.resolve()
    })
    expect(view.queryByTestId('contributed-glyph')).toBeNull()
    expect(view.getByRole('button', { name: '模型' }).querySelector('svg')?.innerHTML).toBe(gear)
    await runtime.dispose()
  })
})
