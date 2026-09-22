// @vitest-environment jsdom
/**
 * The browser panel center view as a user sees it: the URL form drives
 * navigation through the real policy (refusals render inline and never
 * reach the frame), history controls walk the app-owned trail, the reload
 * button remounts the frame, and occupancy follows mount/unmount. The
 * allowlist arrives through the settings-scope hook exactly as the renderer
 * would bind it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { createBrowserViewStore } from '../src/client/history.ts'
import {
  BrowserCenterView,
  type BrowserCenterViewProps,
  type BrowserPanelSettings,
} from '../src/client/BrowserCenterView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: BrowserCenterViewProps['t'] = makeTranslate(zh)

const SELF_ORIGIN = 'http://localhost:3000'

/** Test-local selector hook over a framework-neutral store or scope. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

/** Mount the panel over a real store instance and a stubbed settings scope. */
function mount() {
  const instance = createBrowserViewStore().create()
  const scopeStub = stubSettingsScope<BrowserPanelSettings>()
  const closeView = vi.fn()
  const { container } = render(
    <BrowserCenterView
      {...{
        useStore: hookOf(instance),
        actions: instance.actions,
        useConfig: hookOf(scopeStub.scope),
        selfOrigin: SELF_ORIGIN,
        closeView,
        t,
      } as unknown as BrowserCenterViewProps}
    />,
  )
  return { container, instance, scopeStub, closeView }
}

/** The rendered frame, once navigation has happened. */
function frameOf(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector('iframe')
  if (frame === null) throw new Error('expected the panel frame to be rendered')
  return frame
}

/** Submit the URL bar with the given raw text. */
function submit(container: HTMLElement, raw: string) {
  fireEvent.change(screen.getByLabelText(zh['url.label']), { target: { value: raw } })
  fireEvent.submit(container.querySelector('form')!)
}

describe('BrowserCenterView', () => {
  it('renders the empty panel as a landmark with disabled history controls', () => {
    const { instance } = mount()
    expect(screen.getByRole('region', { name: zh['view.title'] })).toBeDefined()
    expect(screen.getByText(zh['view.empty'])).toBeDefined()
    expect(screen.getByRole('button', { name: zh['nav.back'] })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['nav.forward'] })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['nav.reload'] })).toHaveProperty('disabled', true)
    expect(instance.getSnapshot().entries).toEqual([])
  })

  it('claims occupancy on mount and releases it on unmount', () => {
    const { instance } = mount()
    expect(instance.getSnapshot().open).toBe(true)
    cleanup()
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('navigates an accepted URL into the sandboxed frame and the trail', () => {
    const { container, instance } = mount()
    submit(container, '  https://example.com/docs  ')
    const frame = frameOf(container)
    expect(frame.getAttribute('src')).toBe('https://example.com/docs')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups allow-downloads')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.getAttribute('title')).toBe(zh['frame.title'])
    expect(instance.getSnapshot().entries).toEqual(['https://example.com/docs'])
    expect(screen.getByLabelText<HTMLInputElement>(zh['url.label']).value).toBe('https://example.com/docs')
  })

  it('refuses the harness origin and non-http schemes inline, never touching the frame', () => {
    const { container, instance } = mount()
    submit(container, `${SELF_ORIGIN}/session`)
    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByText(zh['reject.self-origin'])).toBeDefined()
    submit(container, 'file:///etc/passwd')
    expect(screen.getByText(zh['reject.scheme'])).toBeDefined()
    expect(container.querySelector('iframe')).toBeNull()
    expect(instance.getSnapshot().entries).toEqual([])
  })

  it('shows the refused raw URL with parseable refusals but not the empty one', () => {
    const { container } = mount()
    submit(container, 'not-a-url')
    expect(screen.getByRole('alert')).toBeDefined()
    expect(screen.getByText('not-a-url')).toBeDefined()
    submit(container, '   ')
    expect(screen.getByText(zh['reject.empty'])).toBeDefined()
    expect(screen.queryByText('   ')).toBeNull()
  })

  it('dismisses the refusal once a valid URL navigates', () => {
    const { container } = mount()
    submit(container, 'javascript:alert(1)')
    expect(screen.getByRole('alert')).toBeDefined()
    submit(container, 'https://example.com/')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(frameOf(container).getAttribute('src')).toBe('https://example.com/')
  })

  it('walks back and forward over the app-owned trail', () => {
    const { container } = mount()
    submit(container, 'https://a.example/')
    submit(container, 'https://b.example/')
    const back = screen.getByRole('button', { name: zh['nav.back'] })
    const forward = screen.getByRole('button', { name: zh['nav.forward'] })
    expect(back).toHaveProperty('disabled', false)
    expect(forward).toHaveProperty('disabled', true)
    fireEvent.click(back)
    expect(frameOf(container).getAttribute('src')).toBe('https://a.example/')
    expect(screen.getByLabelText<HTMLInputElement>(zh['url.label']).value).toBe('https://a.example/')
    expect(forward).toHaveProperty('disabled', false)
    fireEvent.click(forward)
    expect(frameOf(container).getAttribute('src')).toBe('https://b.example/')
  })

  it('remounts the frame on reload, keeping the same URL', () => {
    const { container } = mount()
    submit(container, 'https://example.com/')
    const before = frameOf(container)
    fireEvent.click(screen.getByRole('button', { name: zh['nav.reload'] }))
    const after = frameOf(container)
    expect(after).not.toBe(before)
    expect(after.getAttribute('src')).toBe('https://example.com/')
  })

  it('releases the center column through the injected exit', () => {
    const { closeView } = mount()
    fireEvent.click(screen.getByText(zh['view.close']))
    expect(closeView).toHaveBeenCalledTimes(1)
  })

  it('enforces a ready allowlist and lifts it while the scope is not ready', () => {
    const { container, scopeStub } = mount()
    scopeStub.publish({ status: 'ready' })
    submit(container, 'https://valueless.example.net/')
    expect(frameOf(container).getAttribute('src')).toBe('https://valueless.example.net/')
    scopeStub.publish({ status: 'ready', value: { allowedHosts: ['example.com'] } })
    submit(container, 'https://elsewhere.example.net/')
    expect(screen.getByText(zh['reject.host-not-allowed'])).toBeDefined()
    submit(container, 'https://example.com/')
    expect(frameOf(container).getAttribute('src')).toBe('https://example.com/')
    // The settings layer materializes an absent allowlist as []: open browsing.
    scopeStub.publish({ status: 'ready', value: { allowedHosts: [] } })
    submit(container, 'https://anywhere.example.net/')
    expect(frameOf(container).getAttribute('src')).toBe('https://anywhere.example.net/')
    scopeStub.publish({ status: 'ready', value: {} })
    submit(container, 'https://elsewhere.example.net/')
    expect(frameOf(container).getAttribute('src')).toBe('https://elsewhere.example.net/')
    scopeStub.publish({ status: 'unavailable' })
    submit(container, 'https://open.example.net/')
    expect(frameOf(container).getAttribute('src')).toBe('https://open.example.net/')
  })
})
