// @vitest-environment jsdom
/** The terminal section tab: aria shape, active state, and selection verb. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TerminalSectionTab, type TerminalSectionTabProps } from '../src/client/TerminalSectionTab.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, {})

function mount(current: string) {
  const select = vi.fn()
  const view = render(
    <TerminalSectionTab {...{ current, select, request: undefined, t } as unknown as TerminalSectionTabProps} />,
  )
  return { ...view, select }
}

describe('TerminalSectionTab', () => {
  afterEach(cleanup)

  it('renders the workbench section tab shape', () => {
    const { container } = mount('files')
    const tab = screen.getByRole('tab', { name: zh['view.title'] })
    expect(tab.id).toBe('workspace-workbench-section-terminal')
    expect(tab.getAttribute('aria-controls')).toBe('workspace-workbench-navigation')
    expect(tab.getAttribute('aria-selected')).toBe('false')
    expect(tab.tabIndex).toBe(-1)
    expect(container.querySelector('[data-active]')).toBeNull()
  })

  it('marks itself showing while its section is current', () => {
    const { container } = mount('terminal')
    const tab = screen.getByRole('tab', { name: zh['view.title'] })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(tab.tabIndex).toBe(0)
    expect(container.querySelector('[data-active]')).toBe(tab)
  })

  it('selects its own section on click', () => {
    const { select } = mount('files')
    fireEvent.click(screen.getByRole('tab', { name: zh['view.title'] }))
    expect(select).toHaveBeenCalledExactlyOnceWith('terminal')
  })
})
