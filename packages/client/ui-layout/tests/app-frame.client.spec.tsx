// @vitest-environment jsdom
/**
 * AppFrame interaction spec under the four-share props form: real layout
 * store instance (createLayoutStore().create() — the test-sanctioned engine
 * path), a recording renderSlot stub, and a render-prop SessionProvider stub
 * (the real one is framework-wired to the renderer host; its own behavior is
 * web-react's spec territory). Drag sequences (pointer capture + rAF flush),
 * concession response to viewport change, and details staying mounted at
 * zero width are the preserved behavior assertions. jsdom has no layout
 * engine, so the frame width comes from a mocked getBoundingClientRect and
 * resizes are driven through the ResizeObserver stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AppFrame } from '../src/client/AppFrame.tsx'
import type { AppFrameProps } from '../src/client/AppFrame.tsx'
import { SIDEBAR_COLLAPSED } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-layout/src/client/locales.ts'
import { createLayoutStore, PROVISIONAL_RIGHT_ACCOUNT_PREFIX } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import type {
  SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'

// Session selection controls for the SessionProvider and useSessions stubs.
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
const selectedSessionCwd = { current: '/projects/test' }
const baselinesReady = { current: true }
const workspaceItems = { current: [] as WorkspaceView[] }
const t: AppFrameProps['t'] = makeTranslate(zh, commonZh)

// Render-prop contract stub fed through the standard seat prop (the renderer
// injects the real one in production): session mode runs children(id), empty
// mode runs the empty branch — the frame must work against exactly this
// shape. Typed as the seat's own component type so the branded sessionId
// parameter stays contract-checked.
const SessionProviderStub: AppFrameProps['SessionProvider'] = ({ children, empty }) =>
  selectedSession.current === undefined ? <>{empty?.() ?? null}</> : <>{children(selectedSession.current)}</>


/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

function mountFrame() {
  window.innerWidth = frameWidth // first-render viewport source before the observer fires
  const instance = createLayoutStore().create()
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <button type="button" data-testid="sidebar-content">Sidebar</button>
    if (key === 'conversation') return <div data-testid="center-content" />
    if (key === 'details') return <div data-testid="details-content" />
    if (key === 'workbench') return <div data-testid="workbench-content"><button type="button">Workbench first</button><div style={{ display: 'none' }}><button type="button">Workbench hidden</button></div><button type="button">Workbench last</button></div>
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    return <div data-testid="other-content" />
  }) as AppFrameProps['renderSlot']
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    const current = selectedSession.current
    const sessionState = {
      ids: current === undefined ? [] : [current],
      byId: current === undefined
        ? {}
        : { [current]: { id: current, displayTitle: 'Test', cwd: selectedSessionCwd.current, running: false, blank: selectedSessionBlank.current, updatedAt: 1 } },
      current,
      phase: 'ready',
    } as SessionListState
    return sel(sessionState)
  }) as never
  const useWorkspaces = ((sel: (s: WorkspaceListState) => unknown) => sel({
    items: workspaceItems.current, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: baselinesReady.current, recentWorkspaceId: undefined,
  })) as never
  const element = () => (
    <AppFrame
      useStore={hookOf(instance)}
      actions={instance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useWorkspaces={useWorkspaces}
      SessionProvider={SessionProviderStub}
      t={t}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return { instance, frame, slotCalls, rerenderFrame: () => { utils.rerender(element()) }, ...utils }
}

function tracks(frame: HTMLElement): number[] {
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px$/.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(m[1]), Number(m[2])]
}

function drag(handle: Element, fromX: number, toX: number): void {
  const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: fromX, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, clientX: toX, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, clientX: toX, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

beforeEach(() => {
  localStorage.clear()
  frameWidth = 1920
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  selectedSessionCwd.current = '/projects/test'
  baselinesReady.current = true
  workspaceItems.current = []
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  Element.prototype.getBoundingClientRect = function () {
    const className = typeof this.className === 'string' ? this.className : ''
    if (className.includes('sidebarCol')) {
      return { width: 280, height: 1080, top: 0, left: 0, right: 280, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) }
    }
    if (className.includes('detailsCol')) {
      const columns = /^(\d+)px minmax\(0, 1fr\) (\d+)px$/.exec(this.parentElement?.style.gridTemplateColumns ?? '')
      const width = Number(columns?.[2] ?? 0)
      return {
        width, height: 1080, top: 0, left: frameWidth - width, right: frameWidth,
        bottom: 1080, x: frameWidth - width, y: 0, toJSON: () => ({}),
      }
    }
    return { width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) }
  }
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture gates pass.
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AppFrame', () => {
  it('renders three tracks from store state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('renders the session pair with empty owner shares (sessionId is framework-standard)', () => {
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    const keys = slotCalls.map(c => c.key)
    expect(keys).toContain('conversation')
    expect(keys).toContain('details')
    expect(keys).not.toContain('conversation.empty')
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
  })

  it('keeps the conversation slot mounted while no session is current', () => {
    // No current session: the session-maybe conversation shell owns the New
    // Session view itself — the center column renders it unconditionally.
    selectedSession.current = undefined
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // No loading gate: a bare loading status reads worse than the shell's own
    // pending rendering — both occupants mount from first paint.
    baselinesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('keeps an ungrouped right preference across Session switches', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().rightByAccount['']?.widths.details).toBe(360)

    selectedSession.current = 's-next' as SessionId
    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])
  })

  it('keeps details closed when the first Session materializes', () => {
    selectedSession.current = undefined
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().rightByAccount).toEqual({})

    selectedSession.current = 's-first' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('sidebar slot receives live concession output as owner props', () => {
    const { slotCalls } = mountFrame()
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({ collapsed: false, width: 280 })
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 280, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('resizes both columns with an accessible keyboard separator', () => {
    const { frame, instance } = mountFrame()
    const sidebar = frame.querySelectorAll('[role="separator"]')[0]!
    expect(sidebar.getAttribute('tabindex')).toBe('0')
    expect(sidebar.getAttribute('aria-valuemin')).toBe('264')
    fireEvent.keyDown(sidebar, { key: 'ArrowRight' })
    expect(tracks(frame)[0]).toBe(290)
    fireEvent.keyDown(sidebar, { key: 'ArrowLeft' })
    fireEvent.keyDown(sidebar, { key: 'Home' })
    expect(tracks(frame)[0]).toBe(264)
    fireEvent.keyDown(sidebar, { key: 'End' })
    expect(tracks(frame)[0]).toBe(420)
    fireEvent.keyDown(sidebar, { key: 'Escape' })

    act(() => { instance.actions.openDetails() })
    const details = frame.querySelectorAll('[role="separator"]')[1]!
    expect(details.getAttribute('aria-valuenow')).toBe('360')
    fireEvent.keyDown(details, { key: 'ArrowLeft' })
    expect(tracks(frame)[1]).toBe(370)
    fireEvent.keyDown(details, { key: 'ArrowRight' })
    expect(tracks(frame)[1]).toBe(360)
  })

  it('drag base is the rendered (concession-clamped) width, not the preference', () => {
    frameWidth = 1250 // step-2 squeeze: details renders 330 while preference is 360
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 330])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 920, 930) // shrink by 10 from the rendered width
    expect(instance.getSnapshot().rightByAccount['']?.widths.details).toBe(320)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(getByTestId('details-content').parentElement?.hasAttribute('inert')).toBe(true)
    expect(getByTestId('details-content').parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
  })

  it('closed sidebar keeps its compact rail with mounted slot content and collapsed owner props', () => {
    const { frame, instance, slotCalls, getByTestId } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    const lastSidebarCall = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    expect(lastSidebarCall.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
  })

  it('viewport shrink triggers the concession chain via ResizeObserver', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
    expect(frame.style.getPropertyValue('--dsh-frame-sidebar-width')).toBe('280px')
    expect(frame.style.getPropertyValue('--dsh-frame-right-width')).toBe('330px')
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 360])
    expect(frame.style.getPropertyValue('--dsh-frame-right-width')).toBe('360px')
  })

  it('drag handles disappear for collapsed columns', () => {
    const { frame, instance } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('switches the physical right region to the workbench with its own width', () => {
    const { frame, instance, slotCalls, getByTestId, queryByTestId } = mountFrame()
    act(() => { instance.actions.openWorkbench() })
    expect(tracks(frame)).toEqual([280, 760])
    expect(frame.style.getPropertyValue('--dsh-frame-right-width')).toBe('760px')
    expect(getByTestId('workbench-content')).toBeTruthy()
    expect(queryByTestId('details-content')).toBeNull()
    expect(frame.getAttribute('data-right-mode')).toBe('workbench')
    expect(slotCalls.filter(call => call.key === 'workbench').at(-1)?.props).toEqual({ drawer: false })
    expect(slotCalls.filter(call => call.key === 'shell.overlay').at(-1)?.props).toEqual({
      rightMode: 'workbench',
      rightOpen: true,
      rightDrawer: false,
    })
    const column = getByTestId('workbench-content').parentElement
    act(() => { instance.actions.closeWorkbench() })
    expect(column?.hasAttribute('inert')).toBe(true)
    expect(column?.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps provisional right-panel actions when a late Workspace baseline resolves', () => {
    baselinesReady.current = false
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(instance.getSnapshot().activeRightAccount).toBe(`${PROVISIONAL_RIGHT_ACCOUNT_PREFIX}s-test`)
    act(() => { instance.actions.openWorkbench() })

    workspaceItems.current = [{
      workspaceId: 'workspace-a' as WorkspaceId,
      path: '/projects/test',
      title: 'Workspace A',
      sessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]
    baselinesReady.current = true
    act(() => { rerenderFrame() })

    expect(instance.getSnapshot().activeRightAccount).toBe('workspace-a')
    expect(instance.getSnapshot().rightByAccount['workspace-a']).toMatchObject({ mode: 'workbench', open: true })
    expect(Object.keys(instance.getSnapshot().rightByAccount)
      .some(account => account.startsWith(PROVISIONAL_RIGHT_ACCOUNT_PREFIX))).toBe(false)
    expect(tracks(frame)).toEqual([280, 760])
  })

  it('accounts a cwd-matched Session to its Workspace right-panel preference', () => {
    workspaceItems.current = [{
      workspaceId: 'workspace-a' as WorkspaceId,
      path: '/projects/test',
      title: 'Workspace A',
      sessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]
    const { frame, instance } = mountFrame()

    act(() => { instance.actions.openWorkbench() })

    expect(tracks(frame)).toEqual([280, 760])
    expect(instance.getSnapshot().activeRightAccount).toBe('workspace-a')
    expect(instance.getSnapshot().rightByAccount['workspace-a']).toMatchObject({ mode: 'workbench', open: true })
    expect(instance.getSnapshot().rightByAccount['']).toBeUndefined()
  })

  it('prefers explicit Session membership over an earlier cwd match for right-panel accounting', () => {
    workspaceItems.current = [
      {
        workspaceId: 'cwd-match' as WorkspaceId,
        path: '/projects/test',
        title: 'Cwd Match',
        sessionIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        workspaceId: 'member' as WorkspaceId,
        path: '/projects/member',
        title: 'Member',
        sessionIds: ['s-test' as SessionId],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]

    const { instance } = mountFrame()
    act(() => { instance.actions.openWorkbench() })

    expect(instance.getSnapshot().activeRightAccount).toBe('member')
    expect(instance.getSnapshot().rightByAccount.member).toMatchObject({ mode: 'workbench', open: true })
    expect(instance.getSnapshot().rightByAccount['cwd-match']).toBeUndefined()
  })

  it('renders the workbench as a full-frame drawer below its breakpoint without changing width', () => {
    frameWidth = 1200
    const { frame, instance, slotCalls, getByRole, getByTestId } = mountFrame()
    getByTestId('sidebar-content').focus()
    act(() => { instance.actions.openWorkbench() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(frame.style.getPropertyValue('--dsh-frame-right-width')).toBe('0px')
    expect(frame.hasAttribute('data-right-drawer')).toBe(true)
    expect(getByTestId('workbench-content').parentElement?.hasAttribute('data-right-drawer')).toBe(true)
    expect(instance.getSnapshot().rightByAccount['']?.widths.workbench).toBe(760)
    expect(slotCalls.filter(call => call.key === 'workbench').at(-1)?.props).toEqual({ drawer: true })
    expect(slotCalls.filter(call => call.key === 'shell.overlay').at(-1)?.props).toEqual({
      rightMode: 'workbench',
      rightOpen: true,
      rightDrawer: true,
    })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
    const dialog = getByRole('dialog', { name: '工作区工作台' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(getByTestId('sidebar-content').parentElement?.hasAttribute('inert')).toBe(true)
    const first = getByRole('button', { name: 'Workbench first' })
    const last = getByRole('button', { name: 'Workbench last' })
    const hidden = getByRole('button', { name: 'Workbench hidden', hidden: true })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    expect(document.activeElement).not.toBe(hidden)
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(dialog, { key: 'Tab' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(frame.hasAttribute('data-right-drawer')).toBe(false)
    expect(document.activeElement).toBe(getByTestId('sidebar-content'))
  })

  it('closes a drawer on Escape after its focused descendant loses focus', () => {
    frameWidth = 1200
    const { frame, instance, getByRole } = mountFrame()
    act(() => { instance.actions.openWorkbench() })
    getByRole('button', { name: 'Workbench first' }).blur()
    expect(document.activeElement).toBe(document.body)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(frame.hasAttribute('data-right-drawer')).toBe(false)
  })

  it('restores focus outside when a docked control becomes a closed drawer', () => {
    const { frame, instance, getByRole, getByTestId } = mountFrame()
    act(() => { instance.actions.openWorkbench() })
    getByRole('button', { name: 'Workbench first' }).focus()

    frameWidth = 1200
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    const dialog = getByRole('dialog', { name: '工作区工作台' })
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(frame.hasAttribute('data-right-drawer')).toBe(false)
    expect(document.activeElement).toBe(getByTestId('sidebar-content'))
  })

  it('labels the session-details drawer independently', () => {
    frameWidth = 800
    const { frame, instance, getByRole } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const dialog = getByRole('dialog', { name: '会话详情' })
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(frame.hasAttribute('data-right-drawer')).toBe(false)
  })
})

describe('AppFrame — narrow-viewport auto-collapse', () => {
  it('mounts collapsed below the breakpoint with no sidebar handle', () => {
    frameWidth = 980
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('narrow toggle re-expands over the squeezed center and back', () => {
    frameWidth = 980
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
  })

  it('a wide-closed preference re-expands at the contract default while narrow', () => {
    frameWidth = 1920
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() }) // close while wide: preference 0
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().sidebar).toBe(0) // preference untouched
  })

  it('shrinking across the breakpoint auto-collapses; re-widening restores the drag width', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.setSidebar(400) })
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0])
  })
})

describe('AppFrame — guard branches', () => {
  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    // Move + up without a preceding pointerdown: hasPointerCapture is false.
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 500, bubbles: true }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 500, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      // Two moves before the frame flushes: the second must ride the pending
      // rAF (frame.current ??= guard), and the flush sees the latest x.
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      // No timer advance: the rAF is still pending when pointerup arrives.
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 360, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(360)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // Track template still reflects the last non-zero viewport.
    expect(tracks(frame)).toEqual([280, 0])
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    act(() => { fireResize?.() }) // rAF scheduled, NOT flushed
    unmount()
    // Flushing after unmount must be a no-op (the frame was cancelled).
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (??= guard)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
  })
})
