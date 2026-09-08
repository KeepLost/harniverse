// @vitest-environment jsdom
/**
 * CommandSeat rendering spec, props-direct: the plus button renders with the
 * launcher copy and popup semantics, its expanded state rides the launcher
 * store, locked disables it, keepFocus suppresses the mousedown default, and
 * a click routes the captured bar context through the injected toggle (a
 * missing context — no textarea — is a no-op).
 */
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import { CommandSeat } from '../src/client/CommandSeat.tsx'
import type { CommandToggleContext } from '../src/client/slots.ts'

const t = makeTranslate(zh, commonZh)

const CONTEXT: CommandToggleContext = {
  selection: { start: 0, end: 0 },
  leading: true,
  draftRev: 3,
  dismissPopup: () => {},
}

// Test-local selector-hook binding over the store (the render machinery's
// own binding lives in web-react, which this package rightly does not depend on).
function useLauncherFrom(store: { subscribe(fn: () => void): () => void; getSnapshot(): string | null }) {
  const subscribe = store.subscribe.bind(store)
  const getSnapshot = store.getSnapshot.bind(store)
  return <R,>(selector: (snapshot: string | null) => R): R =>
    useSyncExternalStore(subscribe, () => selector(getSnapshot()))
}

function bench(over?: {
  locked?: boolean
  launcher?: string | null
  toggle?: (context: CommandToggleContext) => void
  captureContext?: () => CommandToggleContext | undefined
}) {
  const launcher = createSnapshotStore<string | null>(over?.launcher ?? null)
  const toggle = over?.toggle ?? vi.fn()
  const captureContext = over?.captureContext ?? (() => CONTEXT)
  const keepFocus = vi.fn((event: { preventDefault: () => void }) => { event.preventDefault() })
  const view = render(
    <CommandSeat
      locked={over?.locked ?? false}
      keepFocus={keepFocus}
      captureContext={captureContext}
      toggle={toggle}
      useLauncher={useLauncherFrom(launcher)}
      t={t}
    />,
  )
  return { view, launcher, toggle, keepFocus, captureContext }
}

describe('CommandSeat', () => {
  afterEach(() => { cleanup() })

  it('renders the launcher button with popup semantics; locked disables it', () => {
    const { view } = bench()
    const button = view.getByLabelText('命令')
    expect(button.getAttribute('aria-haspopup')).toBe('listbox')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect((button as HTMLButtonElement).disabled).toBe(false)
    cleanup()
    const lockedView = bench({ locked: true })
    expect((lockedView.view.getByLabelText('命令') as HTMLButtonElement).disabled).toBe(true)
  })

  it('reflects the launcher store in aria-expanded', () => {
    const { view, launcher } = bench()
    const button = view.getByLabelText('命令')
    act(() => { launcher.set('command') })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => { launcher.set(null) })
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('a click routes the captured context through the toggle; the mousedown keeps focus', () => {
    const { view, toggle, keepFocus } = bench()
    const button = view.getByLabelText('命令')
    fireEvent.mouseDown(button)
    expect(keepFocus).toHaveBeenCalledOnce()
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledExactlyOnceWith(CONTEXT)
  })

  it('a click without a captured context (no textarea) is a no-op', () => {
    const { view, toggle } = bench({ captureContext: () => undefined })
    fireEvent.click(view.getByLabelText('命令'))
    expect(toggle).not.toHaveBeenCalled()
  })
})
