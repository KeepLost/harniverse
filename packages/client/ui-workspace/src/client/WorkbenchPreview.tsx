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
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  CodeBlock, IconCloseOutline16, IconRightUpOutline16, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PreviewDocumentOwnerProps, WorkspaceWorkbenchProps } from './contract/slots.ts'
import type { WorkbenchPreviewMode, WorkbenchTab } from './stores.ts'
import { parseCsvPreview } from './preview-kind.ts'
import css from './WorkbenchPreview.module.css'

type WorkbenchTranslate = WorkspaceWorkbenchProps['t']

const FOCUSABLE_SELECTOR = 'iframe, button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

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

/** Delimited-table family the bounded preview renders (delimiter and copy derive from it). */
export type CsvFamily = 'csv' | 'tsv'

/** Package-internal bounded delimited (CSV/TSV) presentation, exported for direct component accounting. */
export function CsvTable({ content, family, t }: { content: string; family: CsvFamily; t: WorkbenchTranslate }) {
  const parsed = parseCsvPreview(content, undefined, undefined, family === 'tsv' ? '\t' : ',')
  const [header, ...body] = parsed.rows
  if (header === undefined) {
    return <div className={css.emptyPreview}>{t('workbench.tableEmpty', { format: family.toUpperCase() })}</div>
  }
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

/** Encodings offered by the "reopen with encoding" selector, iconv names as values. */
const REOPEN_ENCODINGS: readonly { value: string; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GB18030 / GBK' },
  { value: 'big5', label: 'Big5' },
  { value: 'shiftjis', label: 'Shift_JIS' },
  { value: 'eucjp', label: 'EUC-JP' },
  { value: 'cp949', label: 'EUC-KR' },
  { value: 'windows-1251', label: 'Windows-1251' },
  { value: 'windows-1252', label: 'Windows-1252' },
]

/** Preview families an editing occupant may take over; every other family stays read-only. */
const EDITABLE_KINDS: ReadonlySet<WorkbenchTab['kind']> = new Set(['markdown', 'html', 'code', 'text', 'csv', 'tsv'])

/** Editor-occupant wiring the preview threads from its entry's renderSlot seat. */
export interface EditorSeat {
  /** Workspace owning the previewed documents. */
  workspaceId: string
  /** Which placement this surface renders. */
  placement: 'overlay' | 'in-column'
  /** Render the preview-document occupant for one document, or null while the hole is empty. */
  render: (owner: PreviewDocumentOwnerProps) => ReactNode
  /** Whether a document holds unsaved edits (the preview then shows the saved version with a notice). */
  isDirty: (path: string) => boolean
  /** Report a document's dirty fact; the entry confirms before closing a dirty document. */
  onDirtyChange: (path: string, dirty: boolean) => void
  /** The occupant saved a document; the entry re-reads it so the preview shows the saved text. */
  onSaved: (path: string) => void
  /** The occupant requested the preview to close after its own Escape handling; a dirty document confirms first. */
  onRequestClose: (path: string, title: string) => void
}

/**
 * Package-internal preview dispatcher, exported for direct component
 * accounting. An editable family shows its rendered preview unless the owner's
 * mode selects the editor seat; the header toggle appears exactly while that
 * choice exists.
 */
export function FilePreview({ tab, onDismiss, t, onFrameLoad, onOpenExternal, onReopenEncoding, editor, mode = 'preview', onModeChange }: {
  tab: WorkbenchTab | undefined
  onDismiss: () => void
  t: WorkbenchTranslate
  onFrameLoad?: (frame: HTMLIFrameElement) => void
  /** Open the previewed file with the Host's default application; absent hides the action. */
  onOpenExternal?: () => void
  /** Re-read the previewed file with an explicit encoding (`undefined` re-detects); text tabs only. */
  onReopenEncoding?: (encoding: string | undefined) => void
  /** Editor-occupant wiring; absent keeps every family on its read-only renderer. */
  editor?: EditorSeat
  /** Surface the tab shows while editor-eligible; absent means its rendered preview. */
  mode?: WorkbenchPreviewMode | undefined
  /** Switch the tab's surface; absent hides the Preview / Edit toggle and keeps the preview. */
  onModeChange?: (mode: WorkbenchPreviewMode) => void
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
  // The Preview / Edit toggle exists only where an occupant could take the
  // document; an explicit-encoding re-open stays in Preview because the
  // editor cannot reproduce its bytes.
  const editable = editor !== undefined && onModeChange !== undefined && tab.content !== undefined
    && EDITABLE_KINDS.has(tab.kind) && tab.truncated !== true
  const explicit = tab.encodingSource === 'explicit'
  const editing = editable && mode === 'edit' && !explicit
  let body
  if (tab.loading) body = <div className={css.emptyPreview}>{t('workbench.previewReading', { name: tab.title })}</div>
  else if (tab.error !== undefined) body = <div className={css.previewError}>{tab.error}</div>
  else if (tab.content === undefined && objectUrl === undefined) body = <div className={css.emptyPreview}>{t('workbench.previewUnavailable')}</div>
  else {
    const content = tab.content as string
    const editorNode = editing
      ? editor.render({
        workspaceId: editor.workspaceId as PreviewDocumentOwnerProps['workspaceId'],
        path: tab.path,
        // EDITABLE_KINDS gated the render; the cast only satisfies the union.
        kind: tab.kind as PreviewDocumentOwnerProps['kind'],
        ...(tab.language === undefined ? {} : { language: tab.language }),
        active: true,
        placement: editor.placement,
        onDirtyChange: (dirty) => { editor.onDirtyChange(tab.path, dirty) },
        onSaved: () => { editor.onSaved(tab.path) },
        onRequestClose: () => { editor.onRequestClose(tab.path, tab.title) },
      })
      : null
    if (editorNode != null) body = editorNode
    else switch (tab.kind) {
      case 'markdown': body = <article className={css.markdownPreview}><MarkdownText text={content} /></article>; break
      case 'html': body = <iframe className={css.htmlPreview} title={tab.title} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={content} onLoad={event => onFrameLoad?.(event.currentTarget)} />; break
      case 'code': body = <div className={css.codePreview}><CodeBlock code={content} lang={tab.language} /></div>; break
      case 'text': body = <pre className={css.textPreview}>{tab.content}</pre>; break
      case 'csv': body = <CsvTable content={content} family="csv" t={t} />; break
      case 'tsv': body = <CsvTable content={content} family="tsv" t={t} />; break
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
        {editable && (
          <div className={css.modeToggle} role="group" aria-label={t('workbench.modeAria')}>
            <button
              type="button"
              data-active={!editing || undefined}
              aria-pressed={!editing}
              onClick={() => { onModeChange('preview') }}
            >
              {t('workbench.modePreview')}
            </button>
            <button
              type="button"
              data-active={editing || undefined}
              aria-pressed={editing}
              disabled={explicit}
              title={explicit ? t('workbench.editorUnavailableExplicit') : undefined}
              onClick={() => { onModeChange('edit') }}
            >
              {t('workbench.modeEdit')}
            </button>
          </div>
        )}
        {tab.encoding !== undefined && (
          <small>
            {t('workbench.encodingLabel')}: {tab.encoding}
            {tab.bom ? ' · BOM' : ''} · {tab.eol}
          </small>
        )}
        {onReopenEncoding !== undefined && (
          <select
            className={css.encodingSelect}
            aria-label={t('workbench.encodingReopen')}
            value={tab.encodingSource === 'explicit' ? tab.encoding : ''}
            onChange={(event) => {
              onReopenEncoding(event.currentTarget.value === '' ? undefined : event.currentTarget.value)
            }}
          >
            <option value="">{t('workbench.encodingAuto')}</option>
            {REOPEN_ENCODINGS.map(entry => (
              <option key={entry.value} value={entry.value}>{entry.label}</option>
            ))}
          </select>
        )}
        {tab.bytes !== undefined && <small>{tab.bytes.toLocaleString()} B</small>}
        {onOpenExternal !== undefined && tab.error === undefined && (
          <button
            type="button"
            className={css.closeButton}
            aria-label={t('workbench.previewOpenExternal')}
            onClick={onOpenExternal}
          >
            <IconRightUpOutline16 />
          </button>
        )}
        <button type="button" className={css.closeButton} aria-label={t('workbench.previewClose')} onClick={onDismiss}>
          <IconCloseOutline16 />
        </button>
      </div>
      {editable && !editing && editor.isDirty(tab.path) && (
        <div className={css.staleNotice} role="status">{t('workbench.previewStale')}</div>
      )}
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
  /** Open the previewed file with the Host's default application; absent hides the action. */
  onOpenExternal?: () => void
  placement: WorkbenchPreviewPlacement
  t: WorkbenchTranslate
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onDismiss: () => void
  /** Re-read the active file tab with an explicit encoding; absent hides the selector. */
  onReopenEncoding?: (path: string, encoding: string | undefined) => void
  /** Editor-occupant wiring; absent keeps every family on its read-only renderer. */
  editor?: EditorSeat
  /** Surface the active tab shows; absent means its rendered preview. */
  mode?: WorkbenchPreviewMode | undefined
  /** Switch one tab's surface; absent hides the Preview / Edit toggle. */
  onModeChange?: (tabId: string, mode: WorkbenchPreviewMode) => void
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
        const panel = frame.closest<HTMLElement>('[data-preview-host]')
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
    activeTab?.kind, activeTab?.loading, activeTab?.mediaType, props.mode, props.open, props.placement,
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
      // The preview-document occupant owns Escape while focus is inside it
      // (its search panel, multi-cursor dismissal, its own close request);
      // the event reaches the occupant's keymap only when this capture
      // listener lets it pass.
      if (event.target instanceof Element && event.target.closest('[data-workspace-editor]') !== null) return
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
      data-preview-host
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
      <FilePreview
        tab={activeTab}
        t={props.t}
        onDismiss={props.onDismiss}
        onFrameLoad={bindFrame}
        mode={props.mode}
        {...(props.editor === undefined ? {} : { editor: props.editor })}
        {...(props.onModeChange === undefined || activeTab === undefined ? {} : {
          onModeChange: (mode: WorkbenchPreviewMode) => { props.onModeChange?.(activeTab.id, mode) },
        })}
        {...(props.onOpenExternal === undefined ? {} : { onOpenExternal: props.onOpenExternal })}
        {...(props.onReopenEncoding === undefined || activeTab === undefined ? {} : {
          onReopenEncoding: (encoding: string | undefined) => { props.onReopenEncoding?.(activeTab.path, encoding) },
        })}
      />
    </div>
  )
  return props.placement === 'overlay'
    ? <div className={css.overlayClip}>{surface}</div>
    : surface
}
