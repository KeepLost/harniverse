// @vitest-environment jsdom
/**
 * The terminal panel center view as a user sees it: occupancy follows
 * mount/unmount, the session binds through the inject verb, the real xterm.js
 * surface mounts into the container (snapshot frames land in the DOM) only
 * once there is a terminal to render, the tab bar and shell picker drive the
 * controller verbs, the touch key bar sends the sequences a soft keyboard
 * cannot, and every status banner (read-only takeover, reconnecting,
 * exhausted retries, RPC errors) renders from the published panel state.
 *
 * jsdom has no layout engine and does not resolve the surface's declared
 * presentation properties, so FitAddon dimensions are stubbed and the
 * appearance contract itself is asserted against the real browser in
 * apps/web/tests/terminal-panel.e2e.ts — a jsdom assertion about colors or
 * columns would only be asserting the fallback path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { TerminalEnvironment, TerminalShell, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { createTerminalViewStore } from '../src/client/view-store.ts'
import { TerminalPanelView, type TerminalPanelViewProps } from '../src/client/TerminalPanelView.tsx'
import type { TerminalPanelState, TerminalSurface } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

beforeAll(() => {
  // xterm.js probes matchMedia at construction; jsdom ships none.
  window.matchMedia = window.matchMedia ?? ((): MediaQueryList => ({
    matches: false, media: '', onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }))
})

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const t: TerminalPanelViewProps['t'] = makeTranslate(zh)

/** The empty panel state every mount starts from. */
const INITIAL: TerminalPanelState = {
  session: undefined, ready: false, terminals: [], activeId: undefined, attached: false,
  inputOwned: false, shells: [], environment: undefined, error: undefined,
  reattaching: false, reattachFailed: false,
}

/** A minimal notifying stand-in store the useSessions share can read. */
function staticStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    getSnapshot: (): T => value,
    set: (next: T): void => {
      value = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

/** A terminal info fixture with the host defaults. */
function info(id: string, overrides: Partial<WebTerminalInfo> = {}): WebTerminalInfo {
  const shell: TerminalShell = { path: '/bin/bash', args: [], name: 'bash' }
  return {
    id: id as WebTerminalId, title: `term ${id}`, shell, cwd: '/tmp', cols: 80, rows: 24,
    state: 'running', exitCode: null, ...overrides,
  }
}

/** One running terminal: the state that mounts the xterm surface. */
const ONE_TERMINAL = { terminals: [info('t1')], activeId: 't1' as WebTerminalId }

/** The environment fixture the panel state carries. */
const environment: TerminalEnvironment = { cwd: '/tmp', maxInputBytes: 4096, maxCols: 500, maxRows: 200, scrollback: 2000 }

/** Mount the panel over a real view store, a driven panel store, and spies. */
function mount(options: { session?: SessionId; panel?: Partial<TerminalPanelState> } = {}) {
  const instance = createTerminalViewStore().create()
  const panelStore = createSnapshotStore<TerminalPanelState>({ ...INITIAL, ...options.panel })
  const sessions = staticStore({ current: options.session })
  const appearanceStore = staticStore({ revision: 1 })
  const verbs = {
    closeView: vi.fn(), bindSession: vi.fn(), activate: vi.fn(), create: vi.fn(), close: vi.fn(),
    rename: vi.fn(), write: vi.fn(), resize: vi.fn(), takeInput: vi.fn(),
  }
  const surfaces: TerminalSurface[] = []
  const bindSurface = vi.fn((surface: TerminalSurface | undefined) => {
    if (surface !== undefined) surfaces.push(surface)
  })
  const { container } = render(
    <TerminalPanelView
      {...{
        useSessions: hookOf(sessions),
        useStore: hookOf(instance),
        actions: instance.actions,
        useTerminals: hookOf(panelStore),
        useAppearance: hookOf(appearanceStore),
        t,
        ...verbs,
        bindSurface,
      } as unknown as TerminalPanelViewProps}
    />,
  )
  const setPanel = (patch: Partial<TerminalPanelState>): void => {
    act(() => { panelStore.set({ ...panelStore.getSnapshot(), ...patch }) })
  }
  return { container, instance, sessions, appearanceStore, setPanel, surfaces, bindSurface, ...verbs }
}

/** The pristine implementation, captured before any spy wraps it. */
const nativeComputedStyle = window.getComputedStyle.bind(window)

/**
 * Serve the surface's declared presentation properties, which jsdom resolves
 * to the empty string because it applies no stylesheet. Everything else keeps
 * the real declaration, so xterm's own measurements are untouched.
 */
function stubPresentation(values: Record<string, string>): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const declaration = nativeComputedStyle(element, pseudo)
    return new Proxy(declaration, {
      get: (target, key) => key === 'getPropertyValue'
        ? (name: string): string => values[name] ?? target.getPropertyValue(name)
        : Reflect.get(target, key) as unknown,
    })
  })
}

/** The scroll element xterm paints the resolved theme background onto. */
function viewport(surface: HTMLElement): HTMLElement {
  const element = surface.querySelector<HTMLElement>('.xterm-scrollable-element')
  if (element === null) throw new Error('xterm scroll element not mounted')
  return element
}

/** The cell metrics xterm resolved, readable from its measurement element. */
function cells(surface: HTMLElement): { fontFamily: string; fontSize: string } {
  const element = surface.querySelector<HTMLElement>('.xterm-char-measure-element')
  if (element === null) throw new Error('xterm measurement element not mounted')
  return { fontFamily: element.style.fontFamily, fontSize: element.style.fontSize }
}

/** The mounted xterm surface element, once the effect has attached it. */
async function xtermSurface(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const surface = container.querySelector('.xterm')
    if (surface === null) throw new Error('xterm surface not mounted yet')
    return surface as HTMLElement
  })
}

describe('TerminalPanelView', () => {
  it('renders the no-session notice with disabled creation affordances', () => {
    const { container } = mount()
    expect(screen.getByRole('region', { name: zh['view.title'] })).toBeDefined()
    expect(screen.getByText(zh['view.no-session'])).toBeDefined()
    expect(screen.getByRole('button', { name: zh['tab.new'] })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(zh['shell.label'])).toHaveProperty('disabled', true)
    // xterm paints an opaque screen over whatever shares its box, so the
    // guidance and the surface are alternatives, never siblings.
    expect(container.querySelector('.xterm')).toBeNull()
  })

  it('renders the empty hint for a session without terminals and no surface behind it', () => {
    const { container } = mount({ session: 's1' as SessionId })
    expect(screen.getByText(zh['view.empty'])).toBeDefined()
    expect(screen.getByRole('button', { name: zh['tab.new'] })).toHaveProperty('disabled', false)
    expect(container.querySelector('.xterm')).toBeNull()
    expect(screen.queryByLabelText(zh['surface.label'])).toBeNull()
  })

  it('mounts the surface when the first terminal appears and retires it with the last', async () => {
    const harness = mount({ session: 's1' as SessionId })
    harness.setPanel(ONE_TERMINAL)
    await xtermSurface(harness.container)
    expect(screen.queryByText(zh['view.empty'])).toBeNull()
    harness.setPanel({ terminals: [], activeId: undefined })
    expect(harness.container.querySelector('.xterm')).toBeNull()
    expect(screen.getByText(zh['view.empty'])).toBeDefined()
    expect(harness.bindSurface).toHaveBeenLastCalledWith(undefined)
  })

  it('claims occupancy on mount, releases it on unmount, and rebinds the session', () => {
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    expect(harness.instance.getSnapshot().open).toBe(true)
    expect(harness.bindSession).toHaveBeenCalledWith('s1' as SessionId)
    act(() => { harness.sessions.set({ current: 's2' as SessionId }) })
    expect(harness.bindSession).toHaveBeenCalledWith('s2' as SessionId)
    act(() => { harness.sessions.set({ current: undefined }) })
    expect(harness.bindSession).toHaveBeenCalledWith(undefined)
    cleanup()
    expect(harness.instance.getSnapshot().open).toBe(false)
    expect(harness.bindSurface).toHaveBeenLastCalledWith(undefined)
  })

  it('mounts the xterm surface and renders snapshot frames into it', async () => {
    const { container, surfaces } = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    const surface = await xtermSurface(container)
    const panel = surfaces[0]
    if (panel === undefined) throw new Error('surface not registered')
    act(() => { panel.reset('hello prompt') })
    await waitFor(() => { expect(surface.textContent).toContain('hello prompt') })
    act(() => { panel.write(' and more') })
    await waitFor(() => { expect(surface.textContent).toContain('and more') })
  })

  it('focuses the xterm textarea when the wrapper gains focus', async () => {
    const { container } = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    await xtermSurface(container)
    const wrapper = screen.getByLabelText(zh['surface.label'])
    fireEvent.focus(wrapper)
    const textarea = container.querySelector('.xterm-helper-textarea')
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  it('routes typed keys from the xterm textarea into the write verb', async () => {
    const { container, write } = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    await xtermSurface(container)
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    fireEvent.focus(textarea)
    fireEvent.keyPress(textarea, { key: 'a', code: 'KeyA', charCode: 97, keyCode: 97, which: 97, bubbles: true })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
    await waitFor(() => { expect(write).toHaveBeenCalledWith('a') })
    expect(write).toHaveBeenCalledWith('\r')
  })

  it('reports fitted dimensions through the resize verb', async () => {
    const propose = vi.spyOn(FitAddon.prototype, 'proposeDimensions')
      .mockReturnValue({ cols: 90, rows: 30 })
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    await xtermSurface(harness.container)
    expect(harness.resize).toHaveBeenCalledWith(90, 30)
    propose.mockReturnValue({ cols: Number.NaN, rows: 30 })
    harness.resize.mockClear()
    fireEvent.focus(screen.getByLabelText(zh['surface.label']))
    expect(harness.resize).not.toHaveBeenCalled()
  })

  it('observes container resizes when the browser provides ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    await xtermSurface(harness.container)
    expect(harness.surfaces).toHaveLength(1)
    expect(typeof harness.surfaces[0]?.reset).toBe('function')
  })

  it('renders the cells with the presentation the surface declares', async () => {
    stubPresentation({
      '--dsh-terminal-bg': ' #101014 ',
      '--dsh-terminal-fg': '#e6e6e6',
      '--dsh-terminal-cursor': '#4d6bfe',
      '--dsh-terminal-selection': '#2b2b33',
      '--dsh-terminal-font-family': "'SF Mono', monospace",
      '--dsh-terminal-font-size': '13px',
    })
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    const surface = await xtermSurface(harness.container)
    expect(cells(surface).fontFamily).toContain('SF Mono')
    expect(cells(surface).fontSize).toBe('13px')
    expect(viewport(surface).style.backgroundColor).toBe('rgb(16, 16, 20)')
  })

  it('falls back to a monospace stack and the default size when only the paints resolve', async () => {
    stubPresentation({ '--dsh-terminal-bg': 'rgb(255, 255, 255)', '--dsh-terminal-fg': '#101014' })
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    const surface = await xtermSurface(harness.container)
    expect(cells(surface).fontFamily).toBe('monospace')
    expect(cells(surface).fontSize).toBe('13px')
    expect(viewport(surface).style.backgroundColor).toBe('rgb(255, 255, 255)')
  })

  it('re-resolves the presentation when the theme revision changes', async () => {
    stubPresentation({
      '--dsh-terminal-bg': 'rgb(16, 16, 20)', '--dsh-terminal-fg': '#e6e6e6', '--dsh-terminal-font-size': '13px',
    })
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    const surface = await xtermSurface(harness.container)
    stubPresentation({
      '--dsh-terminal-bg': 'rgb(255, 255, 255)', '--dsh-terminal-fg': '#101014', '--dsh-terminal-font-size': '16px',
    })
    act(() => { harness.appearanceStore.set({ revision: 2 }) })
    await waitFor(() => { expect(cells(surface).fontSize).toBe('16px') })
    expect(viewport(surface).style.backgroundColor).toBe('rgb(255, 255, 255)')
  })

  it('leaves the terminal on its own defaults while the stylesheet resolves nothing', async () => {
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    const surface = await xtermSurface(harness.container)
    // jsdom applies no stylesheet, so the declared properties read empty and
    // the view must not invent a palette of its own.
    expect(viewport(surface).style.backgroundColor).toBe('rgb(0, 0, 0)')
    act(() => { harness.appearanceStore.set({ revision: 2 }) })
    expect(viewport(surface).style.backgroundColor).toBe('rgb(0, 0, 0)')
  })

  it('refits once the declared font stack has loaded', async () => {
    let settle = (): void => {}
    const ready = new Promise<void>((resolve) => { settle = resolve })
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } })
    const propose = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 100, rows: 40 })
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    await xtermSurface(harness.container)
    harness.resize.mockClear()
    // The first fit measured fallback metrics; the loaded stack fits narrower.
    propose.mockReturnValue({ cols: 96, rows: 40 })
    await act(async () => { settle(); await ready })
    expect(harness.resize).toHaveBeenCalledWith(96, 40)
  })

  it('abandons the font-load refit when the surface is already gone', async () => {
    let settle = (): void => {}
    const ready = new Promise<void>((resolve) => { settle = resolve })
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } })
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    await xtermSurface(harness.container)
    act(() => { harness.setPanel({ terminals: [], activeId: undefined }) })
    harness.resize.mockClear()
    await act(async () => { settle(); await ready })
    expect(harness.resize).not.toHaveBeenCalled()
  })

  it('applies the host scrollback setting to the mounted terminal', async () => {
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    await xtermSurface(harness.container)
    act(() => { harness.setPanel({ environment }) })
    // The terminal instance is view-private; the effect is smoke-asserted by
    // the surface staying mounted and later frames still rendering.
    const surface = harness.surfaces[0]
    if (surface === undefined) throw new Error('surface not registered')
    act(() => { surface.write('still here') })
    await waitFor(() => { expect(harness.container.querySelector('.xterm')?.textContent).toContain('still here') })
  })

  it('renders the tab bar and drives activation and closing', () => {
    const harness = mount({
      session: 's1' as SessionId,
      panel: {
        terminals: [info('t1'), info('t2', { state: 'exited', exitCode: 0, title: 'done' })],
        activeId: 't1' as WebTerminalId,
        attached: true, inputOwned: true,
      },
    })
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('term t1')
    expect(screen.getByRole('tab', { selected: false }).textContent).toContain('done')
    fireEvent.click(screen.getByRole('tab', { selected: false }))
    expect(harness.activate).toHaveBeenCalledWith('t2' as WebTerminalId)
    const closeButtons = screen.getAllByRole('button', { name: zh['tab.close'] })
    const closeOther = closeButtons[1]
    if (closeOther === undefined) throw new Error('second close button missing')
    fireEvent.click(closeOther)
    expect(harness.close).toHaveBeenCalledWith('t2' as WebTerminalId)
  })

  it('renders the state chip for each terminal outcome', () => {
    mount({
      session: 's1' as SessionId,
      panel: {
        terminals: [info('t1', { state: 'exited', exitCode: 3 })],
        activeId: 't1' as WebTerminalId,
      },
    })
    expect(screen.getByText('已退出（代码 3）')).toBeDefined()
    const banner = mount({
      session: 's1' as SessionId,
      panel: { terminals: [info('t1')], activeId: 't1' as WebTerminalId },
    })
    banner.setPanel({ terminals: [info('t1', { state: 'exited', exitCode: null })] })
    expect(screen.getByText('已退出（代码 ?）')).toBeDefined()
    banner.setPanel({ terminals: [info('t1', { state: 'failed', error: 'spawn failed' })] })
    expect(screen.getByText(zh['state.failed'])).toBeDefined()
    expect(screen.getByText('spawn failed')).toBeDefined()
    banner.setPanel({ terminals: [info('t1')] })
    expect(screen.getByText(zh['state.running'])).toBeDefined()
  })

  it('renames through the inline form and cancels on Escape', () => {
    const harness = mount({
      session: 's1' as SessionId,
      panel: { terminals: [info('t1')], activeId: 't1' as WebTerminalId },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['tab.rename'] }))
    const input = screen.getByLabelText(zh['rename.label']) as HTMLInputElement
    expect(input.value).toBe('term t1')
    fireEvent.change(input, { target: { value: 'builds' } })
    // A non-Escape key leaves the form open.
    fireEvent.keyDown(input, { key: 'a' })
    expect(screen.getByLabelText(zh['rename.label'])).toBeDefined()
    fireEvent.submit(input.form as HTMLFormElement)
    expect(harness.rename).toHaveBeenCalledWith('t1' as WebTerminalId, 'builds')
    expect(screen.queryByLabelText(zh['rename.label'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['tab.rename'] }))
    fireEvent.keyDown(screen.getByLabelText(zh['rename.label']), { key: 'Escape' })
    expect(screen.queryByLabelText(zh['rename.label'])).toBeNull()
    expect(harness.rename).toHaveBeenCalledTimes(1)
  })

  it('a rename whose terminal vanished from the list commits nothing', () => {
    const harness = mount({
      session: 's1' as SessionId,
      panel: { terminals: [info('t1')], activeId: 't1' as WebTerminalId },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['tab.rename'] }))
    const input = screen.getByLabelText(zh['rename.label']) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'builds' } })
    harness.setPanel({ terminals: [], activeId: undefined })
    fireEvent.submit(input.form as HTMLFormElement)
    expect(harness.rename).not.toHaveBeenCalled()
  })

  it('creates with the chosen shell and with the default', () => {
    const harness = mount({
      session: 's1' as SessionId,
      panel: { shells: [{ path: '/bin/zsh', args: [], name: 'zsh' }] },
    })
    const select = screen.getByLabelText(zh['shell.label']) as HTMLSelectElement
    expect(select).toHaveProperty('disabled', false)
    expect(screen.getByRole('option', { name: 'zsh' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['tab.new'] }))
    expect(harness.create).toHaveBeenCalledWith(undefined)
    fireEvent.change(select, { target: { value: '/bin/zsh' } })
    fireEvent.click(screen.getByRole('button', { name: zh['tab.new'] }))
    expect(harness.create).toHaveBeenCalledWith('/bin/zsh')
  })

  it('closes the view back to the conversation', () => {
    const harness = mount({ session: 's1' as SessionId })
    fireEvent.click(screen.getByRole('button', { name: zh['view.close'] }))
    expect(harness.closeView).toHaveBeenCalledTimes(1)
  })

  it('renders the RPC error banner as an alert', () => {
    const harness = mount({ session: 's1' as SessionId })
    harness.setPanel({ error: 'terminal-limit-reached: too many' })
    expect(screen.getByRole('alert').textContent).toContain('terminal-limit-reached: too many')
  })

  it('renders the reconnecting banner, then the exhausted banner with retry', () => {
    const harness = mount({
      session: 's1' as SessionId,
      panel: { terminals: [info('t1')], activeId: 't1' as WebTerminalId },
    })
    harness.setPanel({ reattaching: true })
    expect(screen.getByText(zh['reconnect.pending'])).toBeDefined()
    harness.setPanel({ reattaching: false, reattachFailed: true })
    expect(screen.getByText(zh['reconnect.failed'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['reconnect.retry'] }))
    expect(harness.takeInput).toHaveBeenCalledTimes(1)
  })

  it('sends the control sequences a soft keyboard cannot produce', async () => {
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    await xtermSurface(harness.container)
    const bar = screen.getByRole('group', { name: zh['keys.label'] })
    const keys = [...bar.querySelectorAll('button')].map(button => button.textContent)
    expect(keys).toEqual(['Esc', 'Tab', 'Ctrl C', 'Ctrl D', 'Ctrl Z', '↑', '↓', '←', '→'])
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Ctrl C' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl C' }))
    expect(harness.write).toHaveBeenCalledWith('\u0003')
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }))
    expect(harness.write).toHaveBeenCalledWith('\t')
    fireEvent.click(screen.getByRole('button', { name: '↑' }))
    expect(harness.write).toHaveBeenCalledWith('\u001B[A')
    // The key bar is useless if pressing it dismisses the soft keyboard, so
    // the press must not take focus from the surface.
    const textarea = harness.container.querySelector('.xterm-helper-textarea')
    expect(document.activeElement).toBe(textarea)
  })

  it('keeps rendering frames across an appearance revision', async () => {
    const harness = mount({ session: 's1' as SessionId, panel: ONE_TERMINAL })
    const surface = await xtermSurface(harness.container)
    act(() => { harness.appearanceStore.set({ revision: 2 }) })
    const sink = harness.surfaces[0]
    if (sink === undefined) throw new Error('surface not registered')
    act(() => { sink.write('after retheme') })
    await waitFor(() => { expect(surface.textContent).toContain('after retheme') })
  })

  it('renders the read-only banner with the takeover verb while another window holds input', () => {
    const harness = mount({
      session: 's1' as SessionId,
      panel: { terminals: [info('t1')], activeId: 't1' as WebTerminalId, attached: true, inputOwned: false },
    })
    expect(screen.getByText(zh['readonly.notice'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['readonly.take'] }))
    expect(harness.takeInput).toHaveBeenCalledTimes(1)
    harness.setPanel({ inputOwned: true })
    expect(screen.queryByText(zh['readonly.notice'])).toBeNull()
  })
})
