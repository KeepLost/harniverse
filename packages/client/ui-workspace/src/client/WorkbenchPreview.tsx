/**
 * The workbench's file-preview surface: document tabs over one rendered
 * document, presented as a panel that slides in from the left over the
 * conversation.
 *
 * Two placements share this component (WorkbenchPreview.module.css owns the
 * geometry): `overlay` rides the frame-wide overlay layer while the workbench
 * is docked, and `in-column` fills the workbench region while that region is a
 * drawer. Closed keeps the subtree mounted, so tabs survive a dismiss.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  CodeBlock, IconCloseOutline16, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceWorkbenchProps } from './contract/slots.ts'
import type { WorkbenchTab } from './stores.ts'
import { parseCsvPreview } from './preview-kind.ts'
import css from './WorkbenchPreview.module.css'

type WorkbenchTranslate = WorkspaceWorkbenchProps['t']

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

function focusTargetForPath(path: string | undefined): HTMLElement | null {
  if (path === undefined) return null
  return [...document.querySelectorAll<HTMLElement>('[data-workbench-focus-path]')]
    .find(element => element.dataset.workbenchFocusPath === path) ?? null
}

interface ObjectUrlState {
  tabId: string
  dataBase64: string
  mediaType: string
  url: string
}

function useObjectUrl(tab: WorkbenchTab | undefined): ObjectUrlState | undefined {
  const [state, setState] = useState<ObjectUrlState>()
  useEffect(() => {
    if (tab?.dataBase64 === undefined || tab.mediaType === undefined || typeof URL.createObjectURL !== 'function') {
      setState(undefined)
      return
    }
    let binary: string
    try {
      binary = atob(tab.dataBase64)
    } catch {
      setState(undefined)
      return
    }
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const next = URL.createObjectURL(new Blob([bytes], { type: tab.mediaType }))
    setState({ tabId: tab.id, dataBase64: tab.dataBase64, mediaType: tab.mediaType, url: next })
    return () => { URL.revokeObjectURL(next) }
  }, [tab?.dataBase64, tab?.id, tab?.mediaType])
  return state
}

/** Package-internal bounded CSV presentation, exported for direct component accounting. */
export function CsvTable({ content, t }: { content: string; t: WorkbenchTranslate }) {
  const parsed = parseCsvPreview(content)
  const [header, ...body] = parsed.rows
  if (header === undefined) return <div className={css.emptyPreview}>{t('workbench.csvEmpty')}</div>
  return (
    <div className={css.csvWrap}>
      <table className={css.csvTable}>
        <thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}>{cell}</td>)}</tr>
        ))}</tbody>
      </table>
      {parsed.truncated && <div className={css.previewNotice}>{t('workbench.csvTruncated')}</div>}
    </div>
  )
}

/** Package-internal unified-diff presentation, exported for direct component accounting. */
export function DiffPreview({ content }: { content: string }) {
  return (
    <pre className={css.diffPreview}>
      {content.split('\n').map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---')
          ? 'header'
          : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : line.startsWith('@@') ? 'range' : undefined
        return <span key={index} data-kind={kind}>{line}{'\n'}</span>
      })}
    </pre>
  )
}

/** Package-internal document-tab presentation, exported for direct component accounting. */
export function TabStrip(props: {
  tabs: WorkbenchTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  t: WorkbenchTranslate
}) {
  return (
    <div className={css.tabStrip} role="tablist" tabIndex={-1} aria-label={props.t('workbench.tabsAria')}>
      {props.tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={css.documentTab}
          data-active={props.activeTabId === tab.id || undefined}
        >
          <button
            type="button"
            id={`workspace-workbench-tab-${encodeURIComponent(tab.id)}`}
            role="tab"
            aria-controls="workspace-workbench-panel"
            aria-selected={props.activeTabId === tab.id}
            tabIndex={props.activeTabId === tab.id ? 0 : -1}
            className={css.tabSelect}
            onClick={() => { props.onSelect(tab.id) }}
            onKeyDown={(event) => {
              let next = index
              if (event.key === 'ArrowLeft') next = (index + props.tabs.length - 1) % props.tabs.length
              else if (event.key === 'ArrowRight') next = (index + 1) % props.tabs.length
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = props.tabs.length - 1
              else return
              event.preventDefault()
              const nextTab = props.tabs[next]
              /* v8 ignore next -- navigation derives an in-range index from the rendered non-empty tab list. */
              if (nextTab === undefined) throw new Error('tab navigation produced an invalid index')
              props.onSelect(nextTab.id)
              event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
            }}
          >
            <span>{tab.title}</span>
            {tab.loading && <span className={css.loadingDot} aria-label={props.t('workbench.tabLoading')} />}
          </button>
          <button
            type="button"
            aria-label={props.t('workbench.tabClose', { name: tab.title })}
            className={css.tabClose}
            onClick={(event) => {
              const tablist = event.currentTarget.closest<HTMLElement>('[role="tablist"]') as HTMLElement
              const active = props.activeTabId === tab.id
              const nextIndex = active ? Math.min(index, props.tabs.length - 2) : -1
              props.onClose(tab.id)
              queueMicrotask(() => {
                if (nextIndex >= 0) tablist.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus()
                else if (!active) tablist.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
                else {
                  const currentTablist = tablist.parentElement?.querySelector<HTMLElement>('[role="tablist"]')
                  if (currentTablist?.isConnected === true && currentTablist.closest('[inert]') === null) currentTablist.focus()
                }
              })
            }}
          ><IconCloseOutline16 size={12} /></button>
        </div>
      ))}
    </div>
  )
}

/** Package-internal preview dispatcher, exported for direct component accounting. */
export function FilePreview({ tab, onDismiss, t, onFrameLoad }: {
  tab: WorkbenchTab | undefined
  onDismiss: () => void
  t: WorkbenchTranslate
  onFrameLoad?: (frame: HTMLIFrameElement) => void
}) {
  const objectUrlState = useObjectUrl(tab)
  const objectUrl = objectUrlState !== undefined && tab !== undefined
    && objectUrlState.tabId === tab.id
    && objectUrlState.dataBase64 === tab.dataBase64
    && objectUrlState.mediaType === tab.mediaType
    ? objectUrlState.url
    : undefined
  if (tab === undefined) {
    return (
      <div className={css.emptyPreview}>
        <div className={css.emptyMark}>W</div>
        <strong>{t('workbench.previewEmptyTitle')}</strong>
        <span>{t('workbench.previewEmptyDescription')}</span>
      </div>
    )
  }
  let body
  if (tab.loading) body = <div className={css.emptyPreview}>{t('workbench.previewReading', { name: tab.title })}</div>
  else if (tab.error !== undefined) body = <div className={css.previewError}>{tab.error}</div>
  else if (tab.content === undefined && objectUrl === undefined) body = <div className={css.emptyPreview}>{t('workbench.previewUnavailable')}</div>
  else {
    const content = tab.content as string
    switch (tab.kind) {
      case 'markdown': body = <article className={css.markdownPreview}><MarkdownText text={content} /></article>; break
      case 'html': body = <iframe className={css.htmlPreview} title={tab.title} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={content} onLoad={event => onFrameLoad?.(event.currentTarget)} />; break
      case 'code': body = <div className={css.codePreview}><CodeBlock code={content} lang={tab.language} /></div>; break
      case 'text': body = <pre className={css.textPreview}>{tab.content}</pre>; break
      case 'csv': body = <CsvTable content={content} t={t} />; break
      case 'diff': body = <DiffPreview content={content} />; break
      case 'image': body = <div className={css.imagePreview}><img src={objectUrl} alt={tab.title} /></div>; break
      case 'pdf': body = <iframe className={css.pdfPreview} title={tab.title} sandbox="allow-same-origin" src={objectUrl} onLoad={event => onFrameLoad?.(event.currentTarget)} />; break
    }
  }
  const surface = (
    <div
      id="workspace-workbench-panel"
      className={css.previewPane}
      role="tabpanel"
      aria-labelledby={`workspace-workbench-tab-${encodeURIComponent(tab.id)}`}
    >
      <div className={css.previewHeader}>
        {/* Right-to-left ellipsis keeps the filename visible on a long path;
            the bidi isolate stops the base direction from reordering it. */}
        <span className={css.previewPath} title={tab.path}>&#8296;{tab.path}&#8297;</span>
        {tab.bytes !== undefined && <small>{tab.bytes.toLocaleString()} B</small>}
        <button type="button" className={css.closeButton} aria-label={t('workbench.previewClose')} onClick={onDismiss}>
          <IconCloseOutline16 />
        </button>
      </div>
      <div className={css.previewBody}>{body}</div>
      {tab.truncated && <div className={css.previewNotice}>{t('workbench.previewTruncated')}</div>}
    </div>
  )
  return surface
}

/** Where the surface is mounted, which decides its geometry. */
export type WorkbenchPreviewPlacement = 'overlay' | 'in-column'

/** The preview surface: tab strip over one rendered document. */
export function WorkbenchPreview(props: {
  tabs: WorkbenchTab[]
  activeTabId: string | null
  open: boolean
  /** Identity of the visible owner, which restarts focus management on a switch. */
  focusScopeKey?: string
  /** Workspace-relative path used to hand the opener across placements. */
  focusReturnPath?: string
  placement: WorkbenchPreviewPlacement
  t: WorkbenchTranslate
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const frameCleanups = useRef(new Map<HTMLIFrameElement, () => void>())
  const onDismiss = useRef(props.onDismiss)
  onDismiss.current = props.onDismiss
  const activeTab = props.tabs.find(tab => tab.id === props.activeTabId)
  const clearFrameListeners = (): void => {
    for (const cleanup of frameCleanups.current.values()) cleanup()
    frameCleanups.current.clear()
  }
  const bindFrame = (frame: HTMLIFrameElement): void => {
    if (!props.open || ref.current?.contains(frame) !== true) return
    frameCleanups.current.get(frame)?.()
    try {
      const contentWindow = frame.contentWindow
      if (contentWindow === null) return
      const onFrameKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopImmediatePropagation()
          onDismiss.current()
          return
        }
        if (event.key !== 'Tab' || props.placement !== 'in-column') return
        const panel = ref.current
        if (panel === null) return
        const focusable = visibleFocusableDescendants(panel)
        const index = focusable.indexOf(frame)
        if (index === -1) return
        event.preventDefault()
        focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus()
      }
      contentWindow.addEventListener('keydown', onFrameKeyDown, true)
      frameCleanups.current.set(frame, () => { contentWindow.removeEventListener('keydown', onFrameKeyDown, true) })
    } catch {
      // Opaque sandboxed frames remain parent-level focus targets but cannot
      // accept a listener from the outer document.
      return
    }
  }
  useEffect(() => clearFrameListeners, [
    activeTab?.content, activeTab?.dataBase64, activeTab?.error, activeTab?.id,
    activeTab?.kind, activeTab?.loading, activeTab?.mediaType, props.open, props.placement,
  ])
  useLayoutEffect(() => { ref.current?.toggleAttribute('inert', !props.open) }, [props.open])
  useEffect(() => {
    if (!props.open) return
    const panel = ref.current
    /* v8 ignore next -- the surface div is attached whenever this mounted component's effect runs. */
    if (panel === null) return
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreFocus.current = focusTargetForPath(props.focusReturnPath)
      ?? (active !== null && !panel.contains(active) ? active : null)
    const focusable = visibleFocusableDescendants(panel)
    if (active === null || !focusable.includes(active)) {
      const selected = panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      const first = selected !== null && focusable.includes(selected) ? selected : focusable[0]
      ;(first ?? panel).focus()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      // The preview is nested inside the shell drawer on narrow screens. Stop
      // its document listener from also closing the whole workbench.
      event.stopImmediatePropagation()
      onDismiss.current()
    }
    // Capture at Window so this runs before the shell drawer's Document
    // listener even when the preview opens after that drawer mounted.
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const target = restoreFocus.current
      restoreFocus.current = null
      if (target !== null && canRestoreFocus(target)) target.focus()
      else if (
        target !== null
        && target.isConnected
        && props.focusReturnPath !== undefined
        && target.closest('[inert]') === null
      ) {
        // Keep the logical opener for the next placement to restore after its
        // navigation surface becomes visible again.
      } else if (target !== null || (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement))) {
        visibleFocusableDescendants(document.body).find(element => !panel.contains(element))?.focus()
      }
    }
  }, [props.focusScopeKey, props.open, props.placement])
  const surface = (
    <div
      ref={ref}
      className={clsx(
        css.host,
        props.placement === 'in-column' && css.docked,
        !props.open && css.hidden,
      )}
      role={props.open ? 'region' : undefined}
      aria-label={props.t('workbench.previewAria')}
      aria-hidden={props.open ? undefined : true}
      tabIndex={props.open ? -1 : undefined}
    >
      <TabStrip
        tabs={props.tabs}
        activeTabId={props.activeTabId}
        t={props.t}
        onSelect={props.onSelect}
        onClose={props.onClose}
      />
      <FilePreview tab={activeTab} t={props.t} onDismiss={props.onDismiss} onFrameLoad={bindFrame} />
    </div>
  )
  return props.placement === 'overlay'
    ? <div className={css.overlayClip}>{surface}</div>
    : surface
}
