// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createScheduleViewStore } from '../src/client/stores.ts'
import { ScheduleSidebarAction, type ScheduleSidebarActionProps } from '../src/client/ScheduleSidebarAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: ScheduleSidebarActionProps['t'] = makeTranslate(zh)

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

/** Mount the trigger over a real store instance (the sanctioned engine path). */
function mount(wide: boolean, open: boolean) {
  const instance = createScheduleViewStore().create()
  if (open) instance.actions.setOpen(true)
  const openView = vi.fn()
  render(
    <ScheduleSidebarAction
      {...{
        wide,
        useStore: hookOf(instance),
        actions: instance.actions,
        openView,
        t,
      } as unknown as ScheduleSidebarActionProps}
    />,
  )
  return { instance, openView }
}

describe('ScheduleSidebarAction', () => {
  it('renders the wide row with the label and opens the view on click', () => {
    const { openView } = mount(true, false)
    const button = screen.getByRole('button', { name: zh['view.open'] })
    expect(button.textContent).toContain(zh['view.nav'])
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.hasAttribute('data-active')).toBe(false)
    fireEvent.click(button)
    expect(openView).toHaveBeenCalledTimes(1)
  })

  it('renders the rail icon button without the label when collapsed', () => {
    mount(false, false)
    const button = screen.getByRole('button', { name: zh['view.open'] })
    expect(button.textContent).not.toContain(zh['view.nav'])
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('mirrors live occupancy as the pressed affordance', () => {
    const { instance } = mount(true, true)
    const button = screen.getByRole('button', { name: zh['view.open'] })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.hasAttribute('data-active')).toBe(true)
    // The center view releasing the store fact clears the affordance.
    act(() => { instance.actions.setOpen(false) })
    expect(screen.getByRole('button', { name: zh['view.open'] }).getAttribute('aria-pressed')).toBe('false')
  })
})
