// @vitest-environment jsdom
/** The blank-session workbench chip in the input dock. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkbenchDockAction, type WorkbenchDockActionProps } from '../src/client/WorkbenchDockAction.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, {})

function mount(composerPhase: 'blank' | 'composing') {
  const openWorkbench = vi.fn()
  const useSession = vi.fn((selector: (state: { composerPhase: 'blank' | 'composing' }) => unknown) =>
    selector({ composerPhase }))
  const view = render(
    <WorkbenchDockAction
      {...{
        useSession, openWorkbench, closeWorkbench: vi.fn(), t,
      } as unknown as WorkbenchDockActionProps}
    />,
  )
  return { ...view, openWorkbench }
}

describe('WorkbenchDockAction', () => {
  afterEach(cleanup)

  it('offers the workbench while the session is still blank', () => {
    const { openWorkbench } = mount('blank')
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.open'] }))
    expect(openWorkbench).toHaveBeenCalledExactlyOnceWith()
  })

  it('yields to the header button once the session leaves its blank phase', () => {
    const { container } = mount('composing')
    expect(container.firstChild).toBeNull()
  })
})
