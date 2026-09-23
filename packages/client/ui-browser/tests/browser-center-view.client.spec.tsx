// @vitest-environment jsdom
/**
 * The browser panel center view as a user sees it: occupancy follows
 * mount/unmount, the session binds through the inject verb, the surface and the
 * placeholder are alternatives (so nothing paints over the empty state), the
 * address bar and history controls drive the controller verbs, pointer, wheel
 * and key events arrive in page coordinates, and every status banner
 * (refused navigation, page failure, read-only takeover, exhausted stream)
 * renders from the published panel state.
 *
 * jsdom has no layout engine: element geometry and ResizeObserver are stubbed
 * here, and the real pixel path (a live page rendering on the host, with its
 * traffic leaving the host) is asserted in apps/web/tests/browser-panel.e2e.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  BrowserInputEvent, HostBrowserEnvironment, HostBrowserPageId, HostBrowserPageInfo,
} from '@deepseek-ai/dsh-api-browser-controller/types'
import { createBrowserViewStore } from '../src/client/view-store.ts'
import { BrowserCenterView, type BrowserCenterViewProps } from '../src/client/BrowserCenterView.tsx'
import type { BrowserPanelState, BrowserSurface } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const t: BrowserCenterViewProps['t'] = makeTranslate(zh)

/** The empty panel state every mount starts from. */
const INITIAL: BrowserPanelState = {
  session: undefined, ready: false, pages: [], activeId: undefined, attached: false, inputOwned: false,
  environment: undefined, error: undefined, navigationError: undefined, reattaching: false, reattachFailed: false,
}

/** The environment fixture the panel state carries. */
const environment: HostBrowserEnvironment = {
  available: true, maxPages: 4, maxWidth: 2560, maxHeight: 1600, allowedHosts: [], allowPrivateAddresses: false,
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

/** A page info fixture. */
function page(id: string, overrides: Partial<HostBrowserPageInfo> = {}): HostBrowserPageInfo {
  return {
    id: id as HostBrowserPageId,
    url: 'https://example.test/',
    title: 'Example',
    width: 1280,
    height: 800,
    loading: false,
    state: 'ready',
    canGoBack: false,
    canGoForward: false,
    ...overrides,
  }
}

/** One live page: the state that mounts the surface. */
const ONE_PAGE = { pages: [page('p1')], activeId: 'p1' as HostBrowserPageId, ready: true, attached: true, inputOwned: true }

/** A session identity. */
const session = 'sess-1' as SessionId

/** Give every element a measurable box (jsdom reports zeros). */
function stubGeometry(width = 640, height = 480): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, height))
}

/** Install a recording ResizeObserver double. */
function stubResizeObserver(): { observed: Element[]; trigger: () => void } {
  const observed: Element[] = []
  let callback: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(fn: () => void) { callback = fn }
    observe(element: Element): void { observed.push(element) }
    disconnect(): void {}
  })
  return { observed, trigger: () => { callback?.() } }
}

/** Mount the panel over a real view store, a driven panel store, and spies. */
function mount(options: { session?: SessionId; panel?: Partial<BrowserPanelState>; request?: string } = {}) {
  const instance = createBrowserViewStore().create()
  const panelStore = createSnapshotStore<BrowserPanelState>({ ...INITIAL, ...options.panel })
  const sessions = staticStore({ current: options.session })
  const verbs = {
    closeView: vi.fn(), bindSession: vi.fn(), activate: vi.fn(), create: vi.fn(), close: vi.fn(),
    navigate: vi.fn(), act: vi.fn(), input: vi.fn<(event: BrowserInputEvent) => void>(), resize: vi.fn(),
    takeInput: vi.fn(),
  }
  const surfaces: BrowserSurface[] = []
  const bindSurface = vi.fn((surface: BrowserSurface | undefined) => {
    if (surface !== undefined) surfaces.push(surface)
  })
  const view = render(
    <BrowserCenterView
      {...{
        ...(options.request === undefined ? {} : { request: options.request }),
        useSessions: hookOf(sessions),
        useStore: hookOf(instance),
        actions: instance.actions,
        usePanel: hookOf(panelStore),
        t,
        ...verbs,
        bindSurface,
      } as unknown as BrowserCenterViewProps}
    />,
  )
  /** The page image sink element. */
  const image = (): HTMLImageElement => {
    const element = view.container.querySelector('img')
    if (element === null) throw new Error('the panel surface is not mounted')
    return element
  }
  return { ...view, instance, panelStore, sessions, verbs, bindSurface, surfaces, image }
}

describe('BrowserCenterView occupancy and session binding', () => {
  it('claims the center column while mounted and releases it on unmount', () => {
    const { instance, unmount } = mount({ session })
    expect(instance.getSnapshot().open).toBe(true)
    unmount()
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('binds the displayed session and rebinds when the user switches', () => {
    const { verbs, sessions } = mount({ session })
    expect(verbs.bindSession).toHaveBeenLastCalledWith(session)
    act(() => { sessions.set({ current: 'sess-2' as SessionId }) })
    expect(verbs.bindSession).toHaveBeenLastCalledWith('sess-2' as SessionId)
  })
})

describe('BrowserCenterView opener request', () => {
  it('opens the destination an opener asked for, and shows it in the address bar', () => {
    const { verbs } = mount({ session, request: 'https://asked.test/page', panel: { ready: true, environment } })
    expect(verbs.navigate).toHaveBeenCalledExactlyOnceWith('https://asked.test/page')
    expect(screen.getByLabelText<HTMLInputElement>(zh['url.label']).value).toBe('https://asked.test/page')
  })

  it('opens nothing when the panel was opened from its own trigger', () => {
    const { verbs } = mount({ session, panel: ONE_PAGE })
    expect(verbs.navigate).not.toHaveBeenCalled()
  })
})

describe('BrowserCenterView placeholders', () => {
  it('asks for a session before anything else, and mounts no surface', () => {
    const { container } = mount()
    expect(screen.getByText(zh['view.no-session'])).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('application')).toBeNull()
  })

  it('reports a host without a browser program, and what the host probed for', () => {
    const reason = 'No browser executable was found in this execution environment (probed chromium)'
    mount({ session, panel: {
      ready: true, environment: { ...environment, available: false, unavailableReason: reason },
    } })
    expect(screen.getByText(zh['view.unavailable'])).toBeTruthy()
    // The remedy lives on the host machine, so the host's own probe result is
    // the only actionable part of this notice.
    expect(screen.getByText(reason)).toBeTruthy()
  })

  it('reports a host without a browser program that said nothing further', () => {
    mount({ session, panel: { ready: true, environment: { ...environment, available: false } } })
    expect(screen.getByText(zh['view.unavailable'])).toBeTruthy()
  })

  it('shows the loading notice until the list settles, then the empty hint', () => {
    const { panelStore } = mount({ session, panel: { environment } })
    expect(screen.getByText(zh['view.loading'])).toBeTruthy()
    act(() => { panelStore.update((draft) => { Object.assign(draft, { ready: true }) }) })
    expect(screen.getByText(zh['view.empty'])).toBeTruthy()
  })

  it('never renders the surface beside a placeholder: the image appears only with a page', () => {
    const { container, panelStore, bindSurface } = mount({ session, panel: { ready: true, environment } })
    expect(container.querySelector('img')).toBeNull()
    expect(bindSurface).not.toHaveBeenCalled()
    act(() => { panelStore.update((draft) => { Object.assign(draft, ONE_PAGE) }) })
    expect(container.querySelector('img')).not.toBeNull()
    expect(screen.queryByText(zh['view.empty'])).toBeNull()
    expect(bindSurface).toHaveBeenCalledTimes(1)
  })

  it('releases the sink when the last page closes', () => {
    const { panelStore, bindSurface } = mount({ session, panel: ONE_PAGE })
    expect(bindSurface).toHaveBeenCalledTimes(1)
    act(() => { panelStore.update((draft) => { Object.assign(draft, { pages: [], activeId: undefined }) }) })
    expect(bindSurface).toHaveBeenLastCalledWith(undefined)
  })
})

describe('BrowserCenterView page surface', () => {
  it('renders each screencast image into the sink without a re-render', () => {
    const { surfaces, image } = mount({ session, panel: ONE_PAGE })
    const sink = surfaces[0]
    expect(sink).toBeDefined()
    act(() => { sink!.render({ data: 'QUFB', width: 1280, height: 800 }) })
    expect(image().getAttribute('src')).toBe('data:image/jpeg;base64,QUFB')
  })

  it('labels the surface with the page title, falling back to the generic label', () => {
    const { image, panelStore } = mount({ session, panel: ONE_PAGE })
    expect(image().getAttribute('alt')).toBe('Example')
    act(() => { panelStore.update((draft) => { Object.assign(draft, { pages: [page('p1', { title: '' })] }) }) })
    expect(image().getAttribute('alt')).toBe(zh['surface.label'])
  })

  it('publishes the measured surface size and follows later resizes', () => {
    stubGeometry(1024, 768)
    const observer = stubResizeObserver()
    const { verbs } = mount({ session, panel: ONE_PAGE })
    expect(verbs.resize).toHaveBeenLastCalledWith(1024, 768)
    expect(observer.observed).toHaveLength(1)
    act(() => { observer.trigger() })
    expect(verbs.resize).toHaveBeenCalledTimes(2)
  })

  it('publishes nothing while the surface has no measurable box', () => {
    stubResizeObserver()
    const { verbs } = mount({ session, panel: ONE_PAGE })
    expect(verbs.resize).not.toHaveBeenCalled()
  })

  it('tolerates a host without ResizeObserver', () => {
    stubGeometry(800, 600)
    vi.stubGlobal('ResizeObserver', undefined)
    const { verbs } = mount({ session, panel: ONE_PAGE })
    expect(verbs.resize).not.toHaveBeenCalled()
  })

  it('drops a frame that arrives after the view is gone', () => {
    const { surfaces, unmount } = mount({ session, panel: ONE_PAGE })
    const sink = surfaces[0]
    unmount()
    expect(() => { sink!.render({ data: 'QUFB', width: 1, height: 1 }) }).not.toThrow()
  })
})

describe('BrowserCenterView input forwarding', () => {
  /** Mount with geometry and a natural image size so scaling is exercised. */
  function interactive(natural = { width: 1280, height: 800 }) {
    stubGeometry(640, 400)
    const harness = mount({ session, panel: ONE_PAGE })
    const element = harness.image()
    Object.defineProperty(element, 'naturalWidth', { value: natural.width, configurable: true })
    Object.defineProperty(element, 'naturalHeight', { value: natural.height, configurable: true })
    return { ...harness, element }
  }

  it('scales pointer coordinates from the rendered frame into page space', () => {
    const { element, verbs } = interactive()
    fireEvent.pointerDown(element, { clientX: 320, clientY: 200, button: 0 })
    expect(verbs.input).toHaveBeenLastCalledWith({
      kind: 'mouse', type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1, modifiers: 0,
    })
    fireEvent.pointerUp(element, { clientX: 0, clientY: 0, button: 2, shiftKey: true })
    expect(verbs.input).toHaveBeenLastCalledWith({
      kind: 'mouse', type: 'mouseReleased', x: 0, y: 0, button: 'right', clickCount: 1, modifiers: 8,
    })
    fireEvent.pointerMove(element, { clientX: 320, clientY: 100 })
    expect(verbs.input).toHaveBeenLastCalledWith({
      kind: 'mouse', type: 'mouseMoved', x: 640, y: 200, button: 'none', clickCount: 0, modifiers: 0,
    })
  })

  it('names the middle button and maps the modifier bitmask', () => {
    const { element, verbs } = interactive()
    fireEvent.pointerDown(element, { clientX: 0, clientY: 0, button: 1, altKey: true, ctrlKey: true, metaKey: true })
    expect(verbs.input).toHaveBeenLastCalledWith(expect.objectContaining({ button: 'middle', modifiers: 7 }))
    fireEvent.pointerDown(element, { clientX: 0, clientY: 0, button: 4 })
    expect(verbs.input).toHaveBeenLastCalledWith(expect.objectContaining({ button: 'none' }))
  })

  it('uses the rendered box when the image has no intrinsic size yet', () => {
    const { element, verbs } = interactive({ width: 0, height: 0 })
    fireEvent.pointerDown(element, { clientX: 320, clientY: 200, button: 0 })
    expect(verbs.input).toHaveBeenLastCalledWith(expect.objectContaining({ x: 320, y: 200 }))
  })

  it('forwards wheel deltas in page space', () => {
    const { element, verbs } = interactive()
    fireEvent.wheel(element, { clientX: 320, clientY: 200, deltaX: 0, deltaY: 120 })
    expect(verbs.input).toHaveBeenLastCalledWith({
      kind: 'wheel', x: 640, y: 400, deltaX: 0, deltaY: 120, modifiers: 0,
    })
  })

  it('drops pointer and wheel events while the surface has no box', () => {
    const { image, verbs } = mount({ session, panel: ONE_PAGE })
    fireEvent.pointerDown(image(), { clientX: 10, clientY: 10, button: 0 })
    fireEvent.wheel(image(), { clientX: 10, clientY: 10, deltaX: 0, deltaY: 1 })
    expect(verbs.input).not.toHaveBeenCalled()
  })

  it('suppresses the browser context menu over the page', () => {
    const { element } = interactive()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('sends printable keys with their text and navigation keys with a virtual code', () => {
    const { verbs } = mount({ session, panel: ONE_PAGE })
    const surface = screen.getByRole('application')
    fireEvent.keyDown(surface, { key: 'a', code: 'KeyA' })
    expect(verbs.input).toHaveBeenLastCalledWith({
      kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0, text: 'a',
    })
    fireEvent.keyUp(surface, { key: 'a', code: 'KeyA' })
    expect(verbs.input).toHaveBeenLastCalledWith({
      kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0,
    })
    fireEvent.keyDown(surface, { key: 'Enter', code: 'Enter' })
    expect(verbs.input).toHaveBeenLastCalledWith({
      kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 0, windowsVirtualKeyCode: 13,
    })
    // A chord is a command, not text.
    fireEvent.keyDown(surface, { key: 'c', code: 'KeyC', ctrlKey: true })
    expect(verbs.input).toHaveBeenLastCalledWith({
      kind: 'key', type: 'keyDown', key: 'c', code: 'KeyC', modifiers: 2,
    })
  })

  it('claims the keys the page owns so the harness itself does not act on them', () => {
    mount({ session, panel: ONE_PAGE })
    const surface = screen.getByRole('application')
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    surface.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('sends no keys while the page is read-only', () => {
    const { verbs } = mount({ session, panel: { ...ONE_PAGE, inputOwned: false } })
    fireEvent.keyDown(screen.getByRole('application'), { key: 'a', code: 'KeyA' })
    expect(verbs.input).not.toHaveBeenCalled()
  })
})

describe('BrowserCenterView address bar and history', () => {
  it('opens the typed destination and keeps the field in step with the page', () => {
    const { verbs, panelStore } = mount({ session, panel: { ...ONE_PAGE, pages: [page('p1', { url: '' })] } })
    const field = screen.getByLabelText<HTMLInputElement>(zh['url.label'])
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: 'example.test' } })
    fireEvent.click(screen.getByRole('button', { name: zh['url.go'] }))
    expect(verbs.navigate).toHaveBeenLastCalledWith('example.test')
    // The host's committed URL wins over the draft.
    act(() => { panelStore.update((draft) => { Object.assign(draft, { pages: [page('p1', { url: 'https://committed.test/' })] }) }) })
    expect(screen.getByLabelText<HTMLInputElement>(zh['url.label']).value).toBe('https://committed.test/')
  })

  it('disables the address bar with no session', () => {
    mount()
    expect(screen.getByLabelText<HTMLInputElement>(zh['url.label']).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['url.go'] }).disabled).toBe(true)
  })

  it('enables each history move only when the page offers it and this window controls it', () => {
    const { verbs, panelStore } = mount({
      session, panel: { ...ONE_PAGE, pages: [page('p1', { canGoBack: true, canGoForward: true })] },
    })
    const back = screen.getByRole<HTMLButtonElement>('button', { name: zh['nav.back'] })
    const forward = screen.getByRole<HTMLButtonElement>('button', { name: zh['nav.forward'] })
    expect(back.disabled).toBe(false)
    fireEvent.click(back)
    expect(verbs.act).toHaveBeenLastCalledWith('back')
    fireEvent.click(forward)
    expect(verbs.act).toHaveBeenLastCalledWith('forward')
    act(() => { panelStore.update((draft) => { Object.assign(draft, { inputOwned: false }) }) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['nav.back'] }).disabled).toBe(true)
  })

  it('turns reload into stop while the page is loading', () => {
    const { verbs, panelStore } = mount({ session, panel: ONE_PAGE })
    fireEvent.click(screen.getByRole('button', { name: zh['nav.reload'] }))
    expect(verbs.act).toHaveBeenLastCalledWith('reload')
    act(() => { panelStore.update((draft) => { Object.assign(draft, { pages: [page('p1', { loading: true })] }) }) })
    fireEvent.click(screen.getByRole('button', { name: zh['nav.stop'] }))
    expect(verbs.act).toHaveBeenLastCalledWith('stop')
  })

  it('returns the center column to the conversation', () => {
    const { verbs } = mount({ session, panel: ONE_PAGE })
    fireEvent.click(screen.getByRole('button', { name: zh['view.close'] }))
    expect(verbs.closeView).toHaveBeenCalledTimes(1)
  })
})

describe('BrowserCenterView tab strip', () => {
  it('names each page, marks the rendered one, and switches on click', () => {
    const { verbs } = mount({
      session,
      panel: {
        ...ONE_PAGE,
        pages: [page('p1'), page('p2', { title: '', url: 'https://second.test/' }), page('p3', { title: '', url: '' })],
      },
    })
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['Example', 'https://second.test/', zh['tabs.blank']])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    fireEvent.click(tabs[1]!)
    expect(verbs.activate).toHaveBeenLastCalledWith('p2' as HostBrowserPageId)
  })

  it('closes one page and opens another', () => {
    const { verbs } = mount({ session, panel: ONE_PAGE })
    fireEvent.click(screen.getByRole('button', { name: zh['tabs.close'] }))
    expect(verbs.close).toHaveBeenLastCalledWith('p1' as HostBrowserPageId)
    fireEvent.click(screen.getByRole('button', { name: zh['tabs.new'] }))
    expect(verbs.create).toHaveBeenCalledTimes(1)
  })

  it('shows no tab strip before the first page exists', () => {
    mount({ session, panel: { ready: true, environment } })
    expect(screen.queryByRole('tablist')).toBeNull()
  })
})

describe('BrowserCenterView notices', () => {
  it('shows a refused destination and a page failure', () => {
    mount({
      session,
      panel: {
        ...ONE_PAGE,
        navigationError: '目标地址不被允许',
        pages: [page('p1', { error: 'net::ERR_NAME_NOT_RESOLVED' })],
      },
    })
    expect(screen.getByText('目标地址不被允许')).toBeTruthy()
    expect(screen.getByText('net::ERR_NAME_NOT_RESOLVED')).toBeTruthy()
  })

  it('shows an RPC failure banner', () => {
    mount({ session, panel: { ...ONE_PAGE, error: 'browser service is absent' } })
    expect(screen.getByText('browser service is absent')).toBeTruthy()
  })

  it('offers control back when another window owns the page', () => {
    const { verbs } = mount({ session, panel: { ...ONE_PAGE, inputOwned: false } })
    expect(screen.getByText(zh['control.readonly'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['control.take'] }))
    expect(verbs.takeInput).toHaveBeenCalledTimes(1)
  })

  it('offers a reconnect after the stream ladder is exhausted', () => {
    const { verbs } = mount({ session, panel: { ...ONE_PAGE, attached: false, reattachFailed: true } })
    expect(screen.getByText(zh['recover.failed'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['recover.retry'] }))
    expect(verbs.takeInput).toHaveBeenCalledTimes(1)
  })

  it('stays quiet while the panel controls the page', () => {
    mount({ session, panel: ONE_PAGE })
    expect(screen.queryByText(zh['control.readonly'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
