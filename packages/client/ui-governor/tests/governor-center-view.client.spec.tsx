// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createGovernorViewStore } from '../src/client/stores.ts'
import { GovernorCenterView, type GovernorCenterViewProps, type GovernorTabsSource } from '../src/client/GovernorCenterView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: GovernorCenterViewProps['t'] = makeTranslate(zh)

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

/** A tabs ledger stub: fixed descriptors, count-less subscription. */
const tabsOf = (descriptors: readonly { id: string; label: string }[]): GovernorTabsSource => ({
  list: () => descriptors,
  subscribe: () => () => {},
  version: () => 0,
})

/** Mount the shell with a real store instance and a recording child renderer. */
function mount(descriptors: readonly { id: string; label: string }[]) {
  const instance = createGovernorViewStore().create()
  const useStore = hookOf(instance)
  const closeView = vi.fn()
  const renderedOnly: string[] = []
  const renderSlot = ((_key: string, _owner: unknown, opts?: { only?: string }) => {
    renderedOnly.push(opts?.only ?? '*')
    return <p>{`tab-body:${opts?.only ?? '*'}`}</p>
  }) as unknown as GovernorCenterViewProps['renderSlot']
  render(
    <GovernorCenterView
      {...{
        useStore,
        actions: instance.actions,
        closeView,
        tabs: tabsOf(descriptors),
        renderSlot,
        t,
      } as unknown as GovernorCenterViewProps}
    />,
  )
  return { calls: instance, closeView, renderedOnly }
}

describe('GovernorCenterView', () => {
  it('renders the panel title and dismisses through the layout exit', () => {
    const { closeView } = mount([{ id: 'resources', label: zh['tab.resources'] }])
    expect(screen.getByRole('region', { name: zh['view.title'] })).toBeDefined()
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(screen.getByText(zh['view.close']))
    expect(closeView).toHaveBeenCalledTimes(1)
  })

  it('keeps one tab out of the tab ring: a lone contribution renders directly', () => {
    const { renderedOnly } = mount([{ id: 'resources', label: zh['tab.resources'] }])
    expect(renderedOnly.length).toBeGreaterThan(0)
    expect(renderedOnly.every(only => only === 'resources')).toBe(true)
  })

  it('renders the tab ring over every contribution and switches the rendered child', () => {
    const descriptors = [
      { id: 'resources', label: zh['tab.resources'] },
      { id: 'queue', label: '消息队列' },
    ]
    const { renderedOnly } = mount(descriptors)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual([zh['tab.resources'], '消息队列'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(renderedOnly.at(0) ?? renderedOnly.at(-1)).toBe('resources')
    fireEvent.click(tabs[1]!)
    expect(screen.getByText('tab-body:queue')).toBeDefined()
    expect(renderedOnly[renderedOnly.length - 1]).toBe('queue')
  })

  it('falls back to the first descriptor when the stored tab id is unknown', () => {
    const instance = createGovernorViewStore().create()
    instance.actions.setTab('gone')
    const renderSlot = (() => <p>tab-body</p>) as unknown as GovernorCenterViewProps['renderSlot']
    render(
      <GovernorCenterView
        {...{
          useStore: hookOf(instance),
          actions: instance.actions,
          closeView: () => {},
          tabs: tabsOf([
            { id: 'resources', label: zh['tab.resources'] },
            { id: 'queue', label: '消息队列' },
          ]),
          renderSlot,
          t,
        } as unknown as GovernorCenterViewProps}
      />,
    )
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true')
  })
})
