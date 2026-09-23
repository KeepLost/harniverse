/**
 * The browser panel (浏览器) center view: an address bar and a live picture of
 * a page running on the harness host. The image is a JPEG screencast of a real
 * browser process, so the page's own network traffic leaves the host rather
 * than the user's device, and embedding refusals (`X-Frame-Options`,
 * `frame-ancestors`) cannot apply — there is no frame.
 *
 * Two rules the mounting follows deliberately. The surface and the empty state
 * are alternatives, never siblings, because an imperatively-driven surface
 * paints over any sibling placeholder. And pixels never pass through React
 * state: the controller pushes each frame into the `<img>` through the
 * registered sink, so the frame rate cannot become a render rate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseFill14,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  BrowserInputEvent, BrowserNavigationAction, HostBrowserPageId,
} from '@deepseek-ai/dsh-api-browser-controller/types'
import type { BrowserPanelState, BrowserSurface } from './controller.ts'
import type { createBrowserViewStore } from './view-store.ts'
import { NS } from './locales.ts'
import css from './BrowserCenterView.module.css'

/** Injected business face of the panel shell. */
export interface BrowserPanelInjected {
  hooks: {
    /** Panel controller snapshot bound by the renderer as usePanel. */
    panel: SnapshotStore<BrowserPanelState>
  }
  /** Bind the panel to the displayed session (undefined clears it). */
  bindSession: (sessionId: BrowserPanelState['session']) => void
  /** Make one page the rendered one. */
  activate: (id: HostBrowserPageId | undefined) => void
  /** Open a page for this session. */
  create: () => void
  /** Close one page. */
  close: (id: HostBrowserPageId) => void
  /** Navigate the active page, opening one when the panel is empty. */
  navigate: (url: string) => void
  /** Move through history, reload, or stop loading. */
  act: (action: BrowserNavigationAction) => void
  /** Forward one page-space input event. */
  input: (event: BrowserInputEvent) => void
  /** Publish the measured surface size. */
  resize: (width: number, height: number) => void
  /** Reclaim the control attachment. */
  takeInput: () => void
  /** Register or release the image sink. */
  bindSurface: (surface: BrowserSurface | undefined) => void
  /** Release the center column back to the conversation. */
  closeView: () => void
}

/** Full props composed by the center-view slot. */
export type BrowserCenterViewProps =
  PropsRuntime<'center.view'>
  & PropsStore<ReturnType<typeof createBrowserViewStore>>
  & InjectFace<BrowserPanelInjected>
  & PropsLocale<typeof NS>

/** CDP modifier bitmask: Alt 1, Control 2, Meta 4, Shift 8. */
function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

/** CDP mouse-button name for one DOM button index. */
function buttonOf(button: number): 'left' | 'middle' | 'right' | 'none' {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'none'
}

/**
 * Keys that produce no text but need a virtual key code for the page to see
 * them as editing or navigation commands.
 */
const VIRTUAL_KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}

/**
 * The panel shell: the address bar with history controls, the page tab strip,
 * and the streamed page surface.
 * @param props - center slot currency, the occupancy store, the panel hooks and verbs, and the translator.
 * @returns the panel shell.
 */
export function BrowserCenterView({
  request, actions, useSessions, usePanel, bindSession, activate, create, close, navigate, act, input,
  resize, takeInput, bindSurface, closeView, t,
}: BrowserCenterViewProps) {
  useEffect(() => { actions.setOpen(true); return () => { actions.setOpen(false) } }, [actions])
  const session = useSessions(state => state.current)
  useEffect(() => { bindSession(session) }, [bindSession, session])

  const pages = usePanel(state => state.pages)
  const activeId = usePanel(state => state.activeId)
  const ready = usePanel(state => state.ready)
  const attached = usePanel(state => state.attached)
  const inputOwned = usePanel(state => state.inputOwned)
  const environment = usePanel(state => state.environment)
  const error = usePanel(state => state.error)
  const navigationError = usePanel(state => state.navigationError)
  const reattachFailed = usePanel(state => state.reattachFailed)

  const active = useMemo(() => pages.find(page => page.id === activeId), [pages, activeId])
  const [draft, setDraft] = useState('')
  const imageRef = useRef<HTMLImageElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { setDraft(active?.url ?? '') }, [active?.id, active?.url])

  // An opener (a conversation link) asked for a destination: honour it once per
  // request. The controller parks it until a page and its control attachment
  // exist, so this runs before any page is open.
  useEffect(() => {
    if (request === undefined) return
    setDraft(request)
    navigate(request)
  }, [navigate, request])

  const placeholder = session === undefined
    ? 'view.no-session'
    : environment?.available === false
      ? 'view.unavailable'
      : pages.length === 0
        ? 'view.empty'
        : undefined
  const mounted = placeholder === undefined

  // The sink is imperative on purpose: one assignment per frame, no render.
  useEffect(() => {
    if (!mounted) return
    const surface: BrowserSurface = {
      render: (image) => {
        const element = imageRef.current
        if (element === null) return
        element.src = `data:image/jpeg;base64,${image.data}`
      },
    }
    bindSurface(surface)
    return () => { bindSurface(undefined) }
  }, [bindSurface, mounted])

  useEffect(() => {
    const element = surfaceRef.current
    if (!mounted || element === null || typeof ResizeObserver === 'undefined') return
    const publish = (): void => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      resize(Math.round(rect.width), Math.round(rect.height))
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [mounted, resize])

  /** Project one pointer event into the page's coordinate space. */
  const pointOf = useCallback((
    element: HTMLImageElement,
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | undefined => {
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return undefined
    const width = element.naturalWidth > 0 ? element.naturalWidth : rect.width
    const height = element.naturalHeight > 0 ? element.naturalHeight : rect.height
    return {
      x: Math.round((clientX - rect.left) * (width / rect.width)),
      y: Math.round((clientY - rect.top) * (height / rect.height)),
    }
  }, [])

  /** Forward one pointer event as a CDP mouse event. */
  const onPointer = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') =>
    (event: React.PointerEvent<HTMLImageElement>) => {
      const point = pointOf(event.currentTarget, event.clientX, event.clientY)
      if (point === undefined) return
      if (type === 'mousePressed') surfaceRef.current?.focus()
      input({
        kind: 'mouse',
        type,
        x: point.x,
        y: point.y,
        button: type === 'mouseMoved' ? 'none' : buttonOf(event.button),
        clickCount: type === 'mouseMoved' ? 0 : 1,
        modifiers: modifiersOf(event),
      })
    }

  /** Forward one keyboard event, carrying text for printable keys. */
  const onKey = (type: 'keyDown' | 'keyUp') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!inputOwned) return
    // The page owns these keys once it has focus; letting the browser also act
    // on Tab or Backspace would move focus or navigate the harness itself.
    event.preventDefault()
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
    const code = VIRTUAL_KEY_CODES[event.key]
    input({
      kind: 'key',
      type,
      key: event.key,
      code: event.code,
      modifiers: modifiersOf(event),
      ...(code === undefined ? {} : { windowsVirtualKeyCode: code }),
      ...(printable && type === 'keyDown' ? { text: event.key } : {}),
    })
  }

  // The center-view header (title plus icon-button row) follows the governor
  // view's skeleton; the shared shape is the panel affordance, not the content.
  /* jscpd:ignore-start */
  return (
    <section className={css.view} aria-label={t('view.title')}>
      <header className={css.header}>
        <h2 className={css.title}>{t('view.title')}</h2>
        <div className={css.headerActions}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('nav.back')}
            title={t('nav.back')}
            disabled={active?.canGoBack !== true || !inputOwned}
            onClick={() => { act('back') }}
          >
            <IconChevronLeftOutline14 />
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('nav.forward')}
            title={t('nav.forward')}
            disabled={active?.canGoForward !== true || !inputOwned}
            onClick={() => { act('forward') }}
          >
            <IconChevronRightOutline14 />
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={active?.loading === true ? t('nav.stop') : t('nav.reload')}
            title={active?.loading === true ? t('nav.stop') : t('nav.reload')}
            disabled={active === undefined || !inputOwned}
            onClick={() => { act(active?.loading === true ? 'stop' : 'reload') }}
          >
            <IconRefreshOutline16 />
          </button>
          <button type="button" className={css.button} onClick={closeView}>{t('view.close')}</button>
        </div>
      </header>

      <form
        className={css.addressBar}
        onSubmit={(event) => { event.preventDefault(); navigate(draft) }}
      >
        <label className={css.urlLabel} htmlFor="browser-panel-url">{t('url.label')}</label>
        <input
          id="browser-panel-url"
          className={css.urlInput}
          type="text"
          value={draft}
          placeholder={t('url.placeholder')}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={session === undefined}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button type="submit" className={css.button} disabled={session === undefined}>{t('url.go')}</button>
      </form>

      {pages.length > 0 ? (
        <div className={css.tabs} role="tablist" aria-label={t('tabs.label')}>
          {pages.map(page => (
            <span key={page.id} className={css.tab} data-active={page.id === activeId || undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={page.id === activeId}
                className={css.tabButton}
                onClick={() => { activate(page.id) }}
              >
                {page.title === '' ? (page.url === '' ? t('tabs.blank') : page.url) : page.title}
              </button>
              <button
                type="button"
                className={css.tabClose}
                aria-label={t('tabs.close')}
                title={t('tabs.close')}
                onClick={() => { close(page.id) }}
              >
                <IconCloseFill14 />
              </button>
            </span>
          ))}
          <button type="button" className={css.iconButton} aria-label={t('tabs.new')} title={t('tabs.new')} onClick={create}>+</button>
        </div>
      ) : null}

      {navigationError !== undefined ? (
        <p className={css.notice} role="alert">{navigationError}</p>
      ) : null}
      {active?.error !== undefined ? (
        <p className={css.notice} role="alert">{active.error}</p>
      ) : null}
      {error !== undefined ? <p className={css.notice} role="alert">{error}</p> : null}
      {reattachFailed ? (
        <p className={css.notice} role="alert">
          {t('recover.failed')}
          <button type="button" className={css.button} onClick={takeInput}>{t('recover.retry')}</button>
        </p>
      ) : null}
      {mounted && attached && !inputOwned ? (
        <p className={css.notice}>
          {t('control.readonly')}
          <button type="button" className={css.button} onClick={takeInput}>{t('control.take')}</button>
        </p>
      ) : null}

      {mounted ? (
        <div
          className={css.surface}
          ref={surfaceRef}
          tabIndex={0}
          role="application"
          aria-label={t('surface.label')}
          onKeyDown={onKey('keyDown')}
          onKeyUp={onKey('keyUp')}
        >
          <img
            ref={imageRef}
            className={css.image}
            alt={active?.title === undefined || active.title === '' ? t('surface.label') : active.title}
            draggable={false}
            onPointerDown={onPointer('mousePressed')}
            onPointerUp={onPointer('mouseReleased')}
            onPointerMove={onPointer('mouseMoved')}
            onContextMenu={(event) => { event.preventDefault() }}
            onWheel={(event) => {
              const point = pointOf(event.currentTarget, event.clientX, event.clientY)
              if (point === undefined) return
              input({
                kind: 'wheel',
                x: point.x,
                y: point.y,
                deltaX: event.deltaX,
                deltaY: event.deltaY,
                modifiers: modifiersOf(event),
              })
            }}
          />
        </div>
      ) : (
        <div className={css.empty}>
          <p>{ready || session === undefined ? t(placeholder) : t('view.loading')}</p>
          {/* What the host probed for: the operator needs the machine's own
              facts to fix this, and only the host knows them. */}
          {placeholder === 'view.unavailable' && environment?.unavailableReason !== undefined && (
            <p className={css.emptyDetail}>{environment.unavailableReason}</p>
          )}
        </div>
      )}
    </section>
  )
  /* jscpd:ignore-end */
}
