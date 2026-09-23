// @vitest-environment jsdom
/** The browser section tab: aria shape, active state, and selection verb. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { BrowserSectionTab, type BrowserSectionTabProps } from '../src/client/BrowserSectionTab.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, {})

function mount(current: string) {
  const select = vi.fn()
  const view = render(
    <BrowserSectionTab {...{ current, select, request: undefined, t } as unknown as BrowserSectionTabProps} />,
  )
  return { ...view, select }
}

describe('BrowserSectionTab', () => {
  afterEach(cleanup)

  it('renders the workbench section tab shape', () => {
    const { container } = mount('files')
    const tab = screen.getByRole('tab', { name: zh['view.title'] })
    expect(tab.id).toBe('workspace-workbench-section-browser')
    expect(tab.getAttribute('aria-controls')).toBe('workspace-workbench-navigation')
    expect(tab.getAttribute('aria-selected')).toBe('false')
    expect(tab.tabIndex).toBe(-1)
    expect(container.querySelector('[data-active]')).toBeNull()
  })

  it('marks itself showing while its section is current', () => {
    const { container } = mount('browser')
    const tab = screen.getByRole('tab', { name: zh['view.title'] })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(tab.tabIndex).toBe(0)
    expect(container.querySelector('[data-active]')).toBe(tab)
  })

  it('selects its own section on click', () => {
    const { select } = mount('files')
    fireEvent.click(screen.getByRole('tab', { name: zh['view.title'] }))
    expect(select).toHaveBeenCalledExactlyOnceWith('browser')
  })
})
