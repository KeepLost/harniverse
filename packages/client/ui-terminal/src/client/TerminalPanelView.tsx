/**
 * The terminal panel (终端) center view: the authenticated user's shell
 * surface over the terminal-controller streams. One xterm.js terminal renders
 * the active tab; opening a tab claims the exclusive input attachment, and a
 * demoted attachment renders read-only with a takeover affordance. The
 * bounded slow-follower recovery surfaces as a reconnecting banner; the
 * terminal list, shell discovery, create/rename/close verbs, and container
 * resize all ride the panel controller through the inject face.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCloseFill14,
  IconEditOutline16,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { createTerminalViewStore } from './view-store.ts'
import type { TerminalPanelState, TerminalSurface } from './controller.ts'
import { NS } from './locales.ts'
import css from './TerminalPanelView.module.css'
import './xterm-base.module.css'

/** Injected business face of the panel shell. */
export interface TerminalPanelInjected {
  hooks: {
    /** Panel controller state bound by the renderer as useTerminals. */
    terminals: SnapshotStore<TerminalPanelState>
  }
  /** Release the center column back to the conversation. */
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

/** Full props composed by the center-view slot. */
export type TerminalPanelViewProps =
  PropsRuntime<'center.view'>
  & PropsStore<ReturnType<typeof createTerminalViewStore>>
  & InjectFace<TerminalPanelInjected>
  & PropsLocale<typeof NS>

/** Locale key of each terminal state chip. */
const CHIP_KEYS = {
  running: 'state.running',
  exited: 'state.exited',
  failed: 'state.failed',
} as const

/**
 * The panel shell: header with the active terminal's state chip and rename
 * form, the tab bar over the session's terminals, the shell picker with the
 * create verb, status banners, and the fitted xterm.js surface. Terminal
 * lifetime is host-owned: leaving the view keeps terminals alive.
 * @param props - center slot currency, the shared store, the panel verbs, and the translator.
 * @returns the panel shell.
 */
export function TerminalPanelView({
  useSessions, actions, useTerminals, closeView, bindSession, activate, create, close, rename,
  write, resize, takeInput, bindSurface, t,
}: TerminalPanelViewProps) {
  useEffect(() => { actions.setOpen(true); return () => { actions.setOpen(false) } }, [actions])
  const session = useSessions(state => state.current)
  const panel = useTerminals(state => state)
  const active = panel.terminals.find(info => info.id === panel.activeId)

  // Latest-verb refs keep the xterm effect mounted once per panel lifetime.
  const verbs = useRef({ write, resize, bindSurface })
  verbs.current = { write, resize, bindSurface }
  const terminalRef = useRef<Terminal | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const [shellPath, setShellPath] = useState<string>('')
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState(false)

  useEffect(() => { bindSession(session) }, [bindSession, session])

  useEffect(() => {
    const container = containerRef.current
    // The surface div renders in the same commit that runs this effect.
    /* v8 ignore next -- the ref is always attached here */
    if (container === null) return
    const terminal = new Terminal({ scrollback: 1000 })
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
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(applyFit) : undefined
    observer?.observe(container)
    applyFit()
    const surface: TerminalSurface = {
      reset: (screen) => { terminal.reset(); terminal.write(screen) },
      write: (data) => { terminal.write(data) },
    }
    verbs.current.bindSurface(surface)
    return () => {
      observer?.disconnect()
      verbs.current.bindSurface(undefined)
      terminal.dispose()
      terminalRef.current = undefined
    }
  }, [])

  useEffect(() => {
    if (terminalRef.current === undefined || panel.environment === undefined) return
    terminalRef.current.options.scrollback = panel.environment.scrollback
  }, [panel.environment])

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
      <div
        ref={containerRef}
        className={css.surface}
        aria-label={t('surface.label')}
        tabIndex={0}
        onFocus={() => { terminalRef.current?.focus() }}
      >
        {session === undefined ? (
          <p className={css.empty}>{t('view.no-session')}</p>
        ) : panel.terminals.length === 0 ? (
          <p className={css.empty}>{t('view.empty')}</p>
        ) : null}
      </div>
    </section>
  )
}
