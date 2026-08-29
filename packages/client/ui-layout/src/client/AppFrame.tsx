/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details), the drag handles (pointer capture + rAF throttle), the concession
 * chain (columns.ts), and the child-slot render decisions: the sidebar slot
 * renders HERE with live parameters from the concession solve, and the
 * session-aware occupants render in fixed column positions; strict entries
 * gate themselves on current-session availability while session-maybe
 * entries retain identity. Pure component: everything arrives
 * through the three framework shares — zero cordis or framework imports,
 * zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  computeColumns, DETAILS_DRAWER_BREAKPOINT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, WORKBENCH_CENTER_MIN,
  WORKBENCH_DRAWER_BREAKPOINT, WORKBENCH_MAX, WORKBENCH_MIN,
} from './columns.ts'
import {
  PROVISIONAL_RIGHT_ACCOUNT_PREFIX, rightPreferenceFor, UNGROUPED_RIGHT_ACCOUNT, type createLayoutStore,
} from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'workbench' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'layout'>

const FOCUSABLE_SELECTOR = 'iframe, button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function visibleFocusableDescendants(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    let current: HTMLElement | null = element
    while (current !== null) {
      if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false
      const style = window.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      if (current === root) break
      current = current.parentElement
    }
    return true
  })
}

function canRestoreFocus(element: HTMLElement): boolean {
  if (!element.isConnected || !element.matches(FOCUSABLE_SELECTOR)) return false
  let current: HTMLElement | null = element
  while (current !== null) {
    if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false
    const style = window.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    current = current.parentElement
  }
  return true
}

function FrameRegion(props: { children?: ReactNode; className: string | undefined; blocked: boolean; overlay?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => { ref.current?.toggleAttribute('inert', props.blocked) }, [props.blocked])
  return (
    <div ref={ref} className={props.className} data-shell-overlay={props.overlay || undefined} aria-hidden={props.blocked || undefined}>
      {props.children}
    </div>
  )
}

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode; blocked: boolean }) {
  return <FrameRegion className={css.centerCol} blocked={props.blocked}>{props.children}</FrameRegion>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode; drawer: boolean; blocked: boolean; label: string; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => { ref.current?.toggleAttribute('inert', props.blocked) }, [props.blocked])
  useEffect(() => {
    if (!props.drawer) return
    const panel = ref.current
    /* v8 ignore next -- the column div is attached whenever this mounted component's effect runs. */
    if (panel === null) return
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreFocus.current = active !== null && !panel.contains(active) ? active : null
    const focusable = visibleFocusableDescendants(panel)
    if (active === null || !focusable.includes(active)) {
      const first = focusable[0]
      ;(first ?? panel).focus()
    }
    const onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      props.onDismiss()
    }
    document.addEventListener('keydown', onDocumentKeyDown)
    return () => {
      document.removeEventListener('keydown', onDocumentKeyDown)
      const target = restoreFocus.current
      restoreFocus.current = null
      if (target !== null && canRestoreFocus(target)) target.focus()
      else if (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        visibleFocusableDescendants(document.body).find(element => !panel.contains(element))?.focus()
      }
    }
  }, [props.drawer, props.onDismiss])
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!props.drawer) return
    if (event.key !== 'Tab') return
    const focusable = visibleFocusableDescendants(event.currentTarget)
    if (focusable.length === 0) {
      event.preventDefault()
      event.currentTarget.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
  return (
    <div
      ref={ref}
      className={css.detailsCol}
      data-right-drawer={props.drawer || undefined}
      role={props.drawer ? 'dialog' : undefined}
      aria-modal={props.drawer || undefined}
      aria-label={props.drawer ? props.label : undefined}
      aria-hidden={props.blocked || undefined}
      tabIndex={props.drawer ? -1 : undefined}
      onKeyDown={onKeyDown}
    >{props.children}</div>
  )
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: {
  side: 'sidebar' | 'details'
  left: number
  value: number
  min: number
  max: number
  onSet: (value: number) => void
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
  onReset?: () => void
  label: string
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number
    if (e.key === 'ArrowLeft') next = props.value + (props.side === 'sidebar' ? -10 : 10)
    else if (e.key === 'ArrowRight') next = props.value + (props.side === 'sidebar' ? 10 : -10)
    else if (e.key === 'Home') next = props.min
    else if (e.key === 'End') next = props.max
    else return
    e.preventDefault()
    props.onSet(Math.min(props.max, Math.max(props.min, next)))
  }, [props.max, props.min, props.onSet, props.side, props.value])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={props.onReset}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  useWorkspaces,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const detailsCwd = useSessions(s => detailsSession === undefined ? undefined : s.byId[detailsSession]?.cwd)
  const rightAccount = useWorkspaces((state) => {
    if (detailsSession === undefined) return UNGROUPED_RIGHT_ACCOUNT
    if (!state.baselinesReady) return `${PROVISIONAL_RIGHT_ACCOUNT_PREFIX}${detailsSession}`
    return (state.items.find(workspace => workspace.sessionIds.includes(detailsSession))
      ?? state.items.find(workspace => workspace.path === detailsCwd))?.workspaceId as string | undefined
      ?? UNGROUPED_RIGHT_ACCOUNT
  })
  const retainedAccounts = useWorkspaces(state => state.baselinesReady
    ? [UNGROUPED_RIGHT_ACCOUNT, ...state.items.map(workspace => workspace.workspaceId as string)]
    : null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  useLayoutEffect(() => {
    actions.setActiveRightAccount(rightAccount)
  }, [actions, rightAccount])
  useEffect(() => {
    if (retainedAccounts !== null) actions.retainRightAccounts(retainedAccounts)
  }, [actions, retainedAccounts])

  // Track the frame and its animated grid tracks: rAF-throttled observation
  // keeps the frame-wide overlay aligned with the actual used geometry, not
  // just the next target widths React has assigned to the grid.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    const sidebar = el.querySelector<HTMLElement>(`.${css.sidebarCol}`)
    const details = el.querySelector<HTMLElement>(`.${css.detailsCol}`)
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
        const frameBox = el.getBoundingClientRect()
        const sidebarWidth = sidebar?.getBoundingClientRect().width
        const detailsLeft = details?.getBoundingClientRect().left
        if (sidebarWidth !== undefined) el.style.setProperty('--dsh-frame-sidebar-width', `${String(sidebarWidth)}px`)
        if (detailsLeft !== undefined) {
          const rightWidth = el.hasAttribute('data-right-drawer') ? 0 : Math.max(0, frameBox.right - detailsLeft)
          el.style.setProperty('--dsh-frame-right-width', `${String(rightWidth)}px`)
        }
      })
    })
    observer.observe(el)
    if (sidebar !== null) observer.observe(sidebar)
    if (details !== null) observer.observe(details)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a narrow re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const right = rightPreferenceFor(panels, rightAccount)
  const rightOpen = detailsSession !== undefined && right.open
  const rightLimits = right.mode === 'workbench'
    ? { centerMin: WORKBENCH_CENTER_MIN, rightMin: WORKBENCH_MIN, rightMax: WORKBENCH_MAX }
    : { centerMin: 640, rightMin: DETAILS_MIN, rightMax: DETAILS_MAX }
  const preferredRightWidth = rightOpen ? right.widths[right.mode] : 0
  const dockedCols = computeColumns(viewport, sidebarPreference, preferredRightWidth, rightLimits)
  const rightDrawer = rightOpen && (
    viewport < (right.mode === 'workbench' ? WORKBENCH_DRAWER_BREAKPOINT : DETAILS_DRAWER_BREAKPOINT)
    || dockedCols.details === 0
  )
  const cols = rightDrawer ? computeColumns(viewport, sidebarPreference, 0, rightLimits) : dockedCols
  const colsRef = useRef(cols)
  colsRef.current = cols

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setRightWidth(right.mode, detailsBase.current - dx)
  }, [actions, right.mode])
  const onDetailsReset = useCallback(() => {
    actions.resetRightWidth(right.mode)
  }, [actions, right.mode])
  const closeRight = useCallback(() => {
    if (right.mode === 'workbench') actions.closeWorkbench()
    else actions.closeDetails()
  }, [actions, right.mode])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px`,
        // Initial target widths, published for surfaces outside the columns
        // (the shell.overlay layer spans the whole frame and has no other way
        // to learn where a column's edge sits). The observer above refines
        // them to the animated used widths after layout.
        '--dsh-frame-sidebar-width': `${String(cols.sidebar)}px`,
        '--dsh-frame-right-width': `${String(cols.details)}px`,
      } as React.CSSProperties}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-right-mode={right.mode}
      data-right-drawer={rightDrawer || undefined}
      data-dragging={dragging || undefined}
    >
      <FrameRegion className={css.sidebarCol} blocked={rightDrawer}>
        {/* Render-site slot call with live concession output: a closed
            sidebar keeps the mounted slot at the compact-rail width, and the
            component sees its rendered state as owner params decided here
            (collapsed follows the resolved rail, so a derived auto-collapse
            renders the rail UI too). */}
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: cols.sidebar,
        })}
      </FrameRegion>
      <>
        {/* Both column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current. */}
        <CenterColumn blocked={rightDrawer}>{renderSlot('conversation', {})}</CenterColumn>
        <DetailsColumn
          drawer={rightDrawer}
          blocked={!rightOpen}
          label={t(right.mode === 'workbench' ? 'drawer.workbench' : 'drawer.details')}
          onDismiss={closeRight}
        >
          {right.mode === 'workbench' ? renderSlot('workbench', { drawer: rightDrawer }) : renderSlot('details', {})}
        </DetailsColumn>
      </>
      <FrameRegion className={css.overlayLayer} blocked={rightDrawer} overlay>
        {renderSlot('shell.overlay', {
          rightMode: right.mode,
          rightOpen,
          rightDrawer,
        })}
      </FrameRegion>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!rightDrawer && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} value={cols.sidebar} min={SIDEBAR_MIN} max={SIDEBAR_MAX} label={t('resize.sidebar')} onSet={actions.setSidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {cols.details > 0 && !rightDrawer && <DragHandle side="details" left={viewport - cols.details} value={cols.details} min={rightLimits.rightMin} max={rightLimits.rightMax} label={t('resize.right')} onSet={(value) => { actions.setRightWidth(right.mode, value) }} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} onReset={onDetailsReset} />}
    </div>
  )
}
