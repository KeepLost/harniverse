// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createDashboardViewStore } from '../src/client/stores.ts'
import { DashboardView, type DashboardViewProps, type DashboardTabsSource } from '../src/client/DashboardView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: DashboardViewProps['t'] = makeTranslate(zh)

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

/** A tabs ledger stub: fixed descriptors, count-less subscription. */
const tabsOf = (descriptors: readonly { id: string; label: string }[]): DashboardTabsSource => ({
  list: () => descriptors,
  subscribe: () => () => {},
  version: () => 0,
})

/** Mount the shell with a real store instance and a recording child renderer. */
function mount(descriptors: readonly { id: string; label: string }[]) {
  const instance = createDashboardViewStore().create()
  const useStore = hookOf(instance)
  const closeView = vi.fn()
  const renderedOnly: string[] = []
  const renderSlot = ((_key: string, _owner: unknown, opts?: { only?: string }) => {
    renderedOnly.push(opts?.only ?? '*')
    return <p>{`tab-body:${opts?.only ?? '*'}`}</p>
  }) as unknown as DashboardViewProps['renderSlot']
  render(
    <DashboardView
      {...{
        useStore,
        actions: instance.actions,
        closeView,
        tabs: tabsOf(descriptors),
        renderSlot,
        t,
      } as unknown as DashboardViewProps}
    />,
  )
  return { calls: instance, closeView, renderedOnly }
}

describe('DashboardView', () => {
  it('renders the dashboard title and dismisses through the layout exit', () => {
    const { closeView } = mount([{ id: 'schedules', label: zh['view.nav'] }])
    expect(screen.getByRole('region', { name: zh['view.title'] })).toBeDefined()
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(screen.getByText(zh['view.close']))
    expect(closeView).toHaveBeenCalledTimes(1)
  })

  it('keeps one tab out of the tab ring: a lone contribution renders directly', () => {
    const { renderedOnly } = mount([{ id: 'schedules', label: zh['view.nav'] }])
    expect(renderedOnly.length).toBeGreaterThan(0)
    expect(renderedOnly.every(only => only === 'schedules')).toBe(true)
  })

  it('renders the tab ring over every contribution and switches the rendered child', () => {
    const descriptors = [
      { id: 'schedules', label: '定时任务' },
      { id: 'resources', label: '本机资源' },
    ]
    const { renderedOnly } = mount(descriptors)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['定时任务', '本机资源'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(renderedOnly.at(0) ?? renderedOnly.at(-1)).toBe('schedules')
    fireEvent.click(tabs[1]!)
    expect(screen.getByText('tab-body:resources')).toBeDefined()
    expect(renderedOnly[renderedOnly.length - 1]).toBe('resources')
  })

  it('renders nothing when the ledger is empty', () => {
    const instance = createDashboardViewStore().create()
    const renderSlot = (() => <p>tab-body</p>) as unknown as DashboardViewProps['renderSlot']
    render(
      <DashboardView
        {...{
          useStore: hookOf(instance),
          actions: instance.actions,
          closeView: () => {},
          tabs: tabsOf([]),
          renderSlot,
          t,
        } as unknown as DashboardViewProps}
      />,
    )
    expect(screen.queryByText('tab-body')).toBeNull()
  })

  it('falls back to the first descriptor when the stored tab id is unknown', () => {
    const instance = createDashboardViewStore().create()
    instance.actions.setTab('gone')
    const renderSlot = (() => <p>tab-body</p>) as unknown as DashboardViewProps['renderSlot']
    render(
      <DashboardView
        {...{
          useStore: hookOf(instance),
          actions: instance.actions,
          closeView: () => {},
          tabs: tabsOf([
            { id: 'schedules', label: '定时任务' },
            { id: 'resources', label: '本机资源' },
          ]),
          renderSlot,
          t,
        } as unknown as DashboardViewProps}
      />,
    )
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true')
  })
})
