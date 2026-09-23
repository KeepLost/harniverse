/**
 * The terminal panel (终端) workbench section: the authenticated user's shell
 * surface over the terminal-controller streams. One xterm.js terminal renders
 * the active tab; opening a tab claims the exclusive input attachment, and a
 * demoted attachment renders read-only with a takeover affordance. The
 * bounded slow-follower recovery surfaces as a reconnecting banner; the
 * terminal list, shell discovery, create/rename/close verbs, and container
 * resize all ride the panel controller through the inject face.
 *
 * xterm.js paints its own opaque screen and takes colors and metrics as
 * JavaScript values, so the surface declares them as local custom properties
 * in its stylesheet and this component reads the computed values back: the
 * presentation contract (tokens, per-form font size) stays in CSS, and the
 * appearance revision published by the theme service re-resolves them when the
 * palette or the content font size changes.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCloseFill14,
  IconEditOutline16,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalAppearance, TerminalPanelState, TerminalSurface } from './controller.ts'
import { NS } from './locales.ts'
import css from './TerminalPanelView.module.css'
import './xterm-base.module.css'

/** Injected business face of the panel shell. */
export interface TerminalPanelInjected {
  hooks: {
    /** Panel controller state bound by the renderer as useTerminals. */
    terminals: SnapshotStore<TerminalPanelState>
    /** Theme revision bound by the renderer as useAppearance. */
    appearance: SnapshotStore<TerminalAppearance>
  }
  /** Close the workbench column; the controller keeps terminals alive. */
  closeView: () => void
  /** Bind the controller to the current session (undefined clears it). */
  bindSession: (sessionId: TerminalPanelState['session']) => void
  /** Make one terminal the rendered one (undefined picks the first). */
  activate: (id: WebTerminalId | undefined) => void
  /** Create a terminal with the chosen shell path (undefined = default). */
  create: (shellPath: string | undefined) => void
  /** Close one terminal (idempotent) and stop rendering it. */
  close: (id: WebTerminalId) => void
  /** Rename one terminal (trimmed, 1–120 characters). */
  rename: (id: WebTerminalId, title: string) => void
  /** Deliver raw input to the active terminal when input is owned. */
  write: (data: string) => void
  /** Record fitted container dimensions and push them to the PTY. */
  resize: (cols: number, rows: number) => void
  /** Re-open the follow stream: take (back) the input attachment. */
  takeInput: () => void
  /** Register (or release) the xterm.js frame sink. */
  bindSurface: (surface: TerminalSurface | undefined) => void
}

/** Full props composed by the workbench section-panel slot. */
export type TerminalPanelViewProps =
  PropsRuntime<'workbench.section.panel'>
  & InjectFace<TerminalPanelInjected>
  & PropsLocale<typeof NS>

/** Locale key of each terminal state chip. */
const CHIP_KEYS = {
  running: 'state.running',
  exited: 'state.exited',
  failed: 'state.failed',
} as const

/**
 * Keys a soft keyboard cannot produce, as the raw sequences a PTY expects.
 * Without them a touch surface cannot interrupt a command, complete a path,
 * or leave a full-screen editor. The bar is a touch affordance: its stylesheet
 * reveals it in the phone form and on coarse pointers.
 */
const KEY_BAR = [
  { id: 'esc', label: 'Esc', data: '\u001B' },
  { id: 'tab', label: 'Tab', data: '\t' },
  { id: 'ctrl-c', label: 'Ctrl C', data: '\u0003' },
  { id: 'ctrl-d', label: 'Ctrl D', data: '\u0004' },
  { id: 'ctrl-z', label: 'Ctrl Z', data: '\u001A' },
  { id: 'up', label: '↑', data: '\u001B[A' },
  { id: 'down', label: '↓', data: '\u001B[B' },
  { id: 'left', label: '←', data: '\u001B[D' },
  { id: 'right', label: '→', data: '\u001B[C' },
] as const

/** Local custom properties the surface stylesheet declares for xterm.js. */
const PRESENTATION_PROPERTIES = {
  background: '--dsh-terminal-bg',
  foreground: '--dsh-terminal-fg',
  cursor: '--dsh-terminal-cursor',
  selection: '--dsh-terminal-selection',
  fontFamily: '--dsh-terminal-font-family',
  fontSize: '--dsh-terminal-font-size',
} as const

/** Resolved xterm.js presentation read back from the surface element. */
interface TerminalPresentation {
  /** Font stack for the rendered cells. */
  fontFamily: string
  /** Cell font size in px. */
  fontSize: number
  /** Screen, text, cursor, and selection paints. */
  theme: { background: string; foreground: string; cursor: string; selectionBackground: string }
}

/** Fallback metrics when the stylesheet has not resolved (no layout engine). */
const FALLBACK_FONT_SIZE = 13

/**
 * Read the surface's declared presentation contract.
 * @param element - the mounted surface element carrying the properties.
 * @returns the resolved presentation, or undefined when the sheet resolved nothing.
 */
function resolvePresentation(element: HTMLElement): TerminalPresentation | undefined {
  const style = getComputedStyle(element)
  const read = (name: string): string => style.getPropertyValue(name).trim()
  const background = read(PRESENTATION_PROPERTIES.background)
  const foreground = read(PRESENTATION_PROPERTIES.foreground)
  if (background === '' || foreground === '') return undefined
  const cursor = read(PRESENTATION_PROPERTIES.cursor)
  const selectionBackground = read(PRESENTATION_PROPERTIES.selection)
  const size = Number.parseFloat(read(PRESENTATION_PROPERTIES.fontSize))
  const fontFamily = read(PRESENTATION_PROPERTIES.fontFamily)
  return {
    fontFamily: fontFamily === '' ? 'monospace' : fontFamily,
    fontSize: Number.isFinite(size) && size > 0 ? size : FALLBACK_FONT_SIZE,
    theme: {
      background,
      foreground,
      cursor: cursor === '' ? foreground : cursor,
      selectionBackground: selectionBackground === '' ? foreground : selectionBackground,
    },
  }
}

/**
 * The panel shell: header with the active terminal's state chip and rename
 * form, the tab bar over the session's terminals, the shell picker with the
 * create verb, status banners, and the fitted xterm.js surface. Terminal
 * lifetime is host-owned: leaving the view keeps terminals alive.
 * @param props - center slot currency, the shared store, the panel verbs, and the translator.
 * @returns the panel shell.
 */
export function TerminalPanelView(props: TerminalPanelViewProps) {
  // The workbench renders every contributed section body; only the showing
  // one mounts, so the panel's whole lifecycle (xterm surface, input
  // attachment) rides the section's own activation.
  if (props.current !== 'terminal') return null
  return <TerminalPanelBody {...props} />
}

/**
 * The panel shell: mounted only while the terminal section shows.
 * @param props - section slot currency, the panel verbs, and the translator.
 * @returns the panel shell.
 */
function TerminalPanelBody({
  useSessions, useTerminals, useAppearance, closeView, bindSession, activate, create, close, rename,
  write, resize, takeInput, bindSurface, t,
}: TerminalPanelViewProps) {
  const session = useSessions(state => state.current)
  const panel = useTerminals(state => state)
  const appearance = useAppearance(state => state.revision)
  const active = panel.terminals.find(info => info.id === panel.activeId)

  // Latest-verb refs keep the xterm effect mounted once per surface lifetime.
  const verbs = useRef({ write, resize, bindSurface })
  verbs.current = { write, resize, bindSurface }
  const terminalRef = useRef<Terminal | undefined>(undefined)
  const refitRef = useRef<(() => void) | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const [shellPath, setShellPath] = useState<string>('')
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState(false)

  useEffect(() => { bindSession(session) }, [bindSession, session])

  // The surface only mounts with a terminal to render: xterm paints an opaque
  // screen over whatever shares its box, so a placeholder and the surface are
  // alternatives, never siblings.
  const placeholder = useMemo(() => {
    if (session === undefined) return 'view.no-session' as const
    if (panel.terminals.length === 0) return 'view.empty' as const
    return undefined
  }, [panel.terminals.length, session])
  const mounted = placeholder === undefined

  useEffect(() => {
    if (!mounted) return
    const container = containerRef.current
    // The surface div renders in the same commit that runs this effect.
    /* v8 ignore next -- the ref is always attached here */
    if (container === null) return
    const presentation = resolvePresentation(container)
    const terminal = new Terminal({
      scrollback: 1000,
      ...(presentation === undefined ? {} : presentation),
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.onData((data) => { verbs.current.write(data) })
    const applyFit = () => {
      fit.fit()
      const dims = fit.proposeDimensions()
      if (dims === undefined || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
      verbs.current.resize(dims.cols, dims.rows)
    }
    refitRef.current = applyFit
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(applyFit) : undefined
    observer?.observe(container)
    // A soft keyboard shrinks the visual viewport without resizing the layout
    // viewport, so the frame's own box never changes and only this listener
    // reports the usable height.
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', applyFit)
    viewport?.addEventListener('scroll', applyFit)
    applyFit()
    // The first fit measures fallback-font metrics; the real column count is
    // only knowable once the declared font stack has loaded. The declared type
    // overstates availability: jsdom and older engines ship no FontFaceSet.
    const fonts = (document as { fonts: FontFaceSet | undefined }).fonts
    let live = true
    void fonts?.ready.then(() => { if (live) applyFit() })
    const surface: TerminalSurface = {
      reset: (screen) => { terminal.reset(); terminal.write(screen) },
      write: (data) => { terminal.write(data) },
    }
    verbs.current.bindSurface(surface)
    return () => {
      live = false
      observer?.disconnect()
      viewport?.removeEventListener('resize', applyFit)
      viewport?.removeEventListener('scroll', applyFit)
      verbs.current.bindSurface(undefined)
      terminal.dispose()
      terminalRef.current = undefined
      refitRef.current = undefined
    }
  }, [mounted])

  useEffect(() => {
    const terminal = terminalRef.current
    const container = containerRef.current
    if (terminal === undefined || container === null) return
    const presentation = resolvePresentation(container)
    if (presentation === undefined) return
    terminal.options.theme = presentation.theme
    terminal.options.fontFamily = presentation.fontFamily
    terminal.options.fontSize = presentation.fontSize
    refitRef.current?.()
  }, [appearance, mounted])

  useEffect(() => {
    if (terminalRef.current === undefined || panel.environment === undefined) return
    terminalRef.current.options.scrollback = panel.environment.scrollback
  }, [mounted, panel.environment])

  const beginRename = () => {
    // The rename control only renders with an active terminal, so the title
    // is always present when the form opens.
    /* v8 ignore next 2 -- the control needs an active terminal */
    setDraft(active?.title ?? '')
    setRenaming(true)
  }

  const commitRename = () => {
    setRenaming(false)
    // The form unmounts together with the active terminal, so a commit
    // always has one to rename.
    /* v8 ignore next 2 -- the form needs an active terminal */
    if (active !== undefined) rename(active.id, draft)
  }

  const shellValue = shellPath === '' ? undefined : shellPath

  return (
    <section className={css.view} aria-label={t('view.title')}>
      <header className={css.header}>
        <h2 className={css.title}>{t('view.title')}</h2>
        {active !== undefined ? (
          renaming ? (
            <form
              className={css.renameForm}
              onSubmit={(event) => {
                event.preventDefault()
                commitRename()
              }}
            >
              <label className={css.shellLabel} htmlFor="terminal-panel-name">{t('rename.label')}</label>
              <input
                id="terminal-panel-name"
                className={css.renameInput}
                type="text"
                value={draft}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(event) => { setDraft(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(false)
                }}
              />
              <button type="submit" className={css.button}>{t('rename.save')}</button>
            </form>
          ) : (
            <>
              <span className={`${css.chip} ${css[`chip_${active.state}`]}`}>
                {active.state === 'exited'
                  ? t('state.exited', { code: active.exitCode ?? '?' })
                  : t(CHIP_KEYS[active.state])}
              </span>
              {active.state === 'failed' && active.error !== undefined ? (
                <span className={css.chipError} title={active.error}>{active.error}</span>
              ) : null}
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('tab.rename')}
                title={t('tab.rename')}
                onClick={beginRename}
              >
                <IconEditOutline16 />
              </button>
            </>
          )
        ) : null}
        <div className={css.headerActions}>
          <label className={css.shellLabel} htmlFor="terminal-panel-shell">{t('shell.label')}</label>
          <select
            id="terminal-panel-shell"
            className={css.shellSelect}
            value={shellValue ?? ''}
            disabled={session === undefined || panel.shells.length === 0}
            onChange={(event) => { setShellPath(event.target.value) }}
          >
            <option value="">{t('shell.default')}</option>
            {panel.shells.map(shell => (
              <option key={shell.path} value={shell.path}>{shell.name}</option>
            ))}
          </select>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('tab.new')}
            title={t('tab.new')}
            disabled={session === undefined}
            onClick={() => { create(shellValue) }}
          >
            <IconPlusOutline16 />
          </button>
          <button type="button" className={css.button} onClick={closeView}>{t('view.close')}</button>
        </div>
      </header>
      {panel.terminals.length > 0 ? (
        <div className={css.tabs} role="tablist" aria-label={t('view.title')}>
          {panel.terminals.map(info => (
            <div key={info.id} className={info.id === panel.activeId ? css.tabActive : css.tab}>
              <button
                type="button"
                role="tab"
                aria-selected={info.id === panel.activeId}
                className={css.tabButton}
                onClick={() => { activate(info.id) }}
              >
                <span className={css.tabTitle}>{info.title}</span>
                {info.state !== 'running' ? (
                  <span className={css.tabState}>· {t(CHIP_KEYS[info.state])}</span>
                ) : null}
              </button>
              <button
                type="button"
                className={css.tabClose}
                aria-label={t('tab.close')}
                title={t('tab.close')}
                onClick={() => { close(info.id) }}
              >
                <IconCloseFill14 />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {panel.error !== undefined ? (
        <p className={css.error} role="alert">{panel.error}</p>
      ) : null}
      {panel.reattaching ? (
        <p className={css.notice}>{t('reconnect.pending')}</p>
      ) : panel.reattachFailed ? (
        <p className={css.notice}>
          <span>{t('reconnect.failed')}</span>
          <button type="button" className={css.button} onClick={takeInput}>{t('reconnect.retry')}</button>
        </p>
      ) : panel.attached && !panel.inputOwned && active?.state === 'running' ? (
        <p className={css.notice}>
          <span>{t('readonly.notice')}</span>
          <button type="button" className={css.button} onClick={takeInput}>{t('readonly.take')}</button>
        </p>
      ) : null}
      {mounted ? (
        <>
          <div
            ref={containerRef}
            className={css.surface}
            aria-label={t('surface.label')}
            tabIndex={0}
            onFocus={() => { terminalRef.current?.focus() }}
          />
          <div className={css.keyBar} aria-label={t('keys.label')} role="group">
            {KEY_BAR.map(key => (
              <button
                key={key.id}
                type="button"
                className={css.keyButton}
                // Keeping focus on the surface is what makes the bar usable:
                // a soft keyboard closes the moment its input loses focus.
                onMouseDown={(event) => { event.preventDefault() }}
                onClick={() => {
                  write(key.data)
                  terminalRef.current?.focus()
                }}
              >
                {key.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className={css.empty}>{t(placeholder)}</p>
      )}
    </section>
  )
}
