/**
 * The preview-document occupant: a CodeMirror 6 editor with a manual-save
 * toolbar, dirty/failure status, and the conflict bar (reload / compare /
 * overwrite). Everything reactive arrives through the owner props and the
 * injected face; the draft account lives in the plugin store, so switching
 * the preview placement (overlay ↔ drawer) unmounts this component, gets
 * its document state serialized into the store, and remounts it with the
 * undo history restored. Escape reaches this surface before the preview's
 * window-capture close (the preview defers while focus is inside
 * `[data-workspace-editor]`).
 * @module ui-workspace-editor/EditorDocument
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { historyField } from '@codemirror/commands'
import { DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { PreviewDocumentOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createEditorView } from './extensions.ts'
import { editorEntry, editorKey } from './stores.ts'
import type { WorkspaceEditorState } from './stores.ts'
import type { EditorSnapshot } from './editor-controller.ts'
import type { WorkspaceEditorKey } from './locales.ts'
import css from './EditorDocument.module.css'

/** Translate seat over the editor namespace. */
type Translate = (key: WorkspaceEditorKey, params?: Record<string, string | number>) => string

/** Injected face: the plugin apply's machine binding plus the controller verbs. */
export interface WorkspaceEditorInjected {
  /** Machine partition the current registration serves. */
  readonly machineKey: string
  /** Reserved reactive compartment: the draft-account store. */
  readonly hooks: {
    readonly editorState: SnapshotStore<WorkspaceEditorState>
  }
  /** Ensure the document is loaded and watched. */
  readonly attach: (workspaceId: string, path: string) => void
  /** Serialize and release one occupant. */
  readonly detach: (workspaceId: string, path: string, snapshot: EditorSnapshot | undefined) => void
  /** Mark the document dirty from a live edit. */
  readonly markDirty: (workspaceId: string, path: string) => void
  /** Save the current text under the version CAS. */
  readonly save: (workspaceId: string, path: string, content: string) => Promise<void>
  /** Overwrite after an explicit conflict confirmation. */
  readonly confirmOverwrite: (workspaceId: string, path: string, content: string) => Promise<void>
  /** Discard the draft and re-open from disk. */
  readonly reload: (workspaceId: string, path: string) => Promise<void>
}

/** Component-side view of the injected share (the hooks compartment bound). */
export type WorkspaceEditorDocumentProps = PreviewDocumentOwnerProps & Omit<WorkspaceEditorInjected, 'hooks'> & {
  /** Selector hook over the draft-account store. */
  readonly useEditorState: SnapshotSelectorHook<WorkspaceEditorState>
  /** Translate seat over the editor namespace. */
  readonly t: Translate
}

/** The minimal EditorView surface this module touches (jsdom-testable). */
interface EditorViewLike {
  readonly state: { toJSON(fields?: Record<string, unknown>): unknown; doc: { toString(): string } }
  destroy(): void
}

/** Serialize the live editor state for the draft store. */
function snapshotOf(view: EditorViewLike | null): EditorSnapshot | undefined {
  if (view === null) return undefined
  const json = view.state.toJSON({ history: historyField })
  return { draft: view.state.doc.toString(), history: json }
}

/**
 * The editable document surface for one previewed file.
 * @param props - owner conversation plus the injected verbs and store hook.
 * @returns the editor surface, or its loading/read-only fallback notice.
 */
export function WorkspaceEditorDocument(props: WorkspaceEditorDocumentProps): ReactElement | null {
  const key = editorKey(props.workspaceId, props.path)
  const entry = props.useEditorState(state => editorEntry(state, props.machineKey, key))
  const status = entry?.status ?? 'loading'
  const [diffOpen, setDiffOpen] = useState(false)

  // Lifecycle: attach on mount, serialize + detach on unmount. The injected
  // members are created once per registration; identity-stable deps hold.
  const verbs = useRef(props)
  verbs.current = props
  useEffect(() => {
    const { workspaceId, path, attach } = verbs.current
    attach(workspaceId, path)
    return () => {
      const current = verbs.current
      current.detach(workspaceId, path, snapshotOf(viewRef.current))
    }
  }, [props.machineKey, props.path, props.workspaceId])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorViewLike | null>(null)
  const ready = entry !== undefined
    && status !== 'loading'
    && props.readOnlyFallback === undefined
    && status !== 'unavailable'
  const entryRef = useRef(entry)
  entryRef.current = entry

  // Create the editor once its entry is ready; destroy on unmount or when
  // the document identity changes. A clean reload swaps the document inside
  // the same view; a dirty or conflicting one never reaches this branch
  // (the controller only reloads clean entries).
  useEffect(() => {
    const host = hostRef.current
    const current = entryRef.current
    if (!ready || host === null || current === undefined) return
    const { workspaceId, path, markDirty } = verbs.current
    let suppressed = false
    const { view, destroy } = createEditor({
      host,
      entry: current,
      languagePath: path,
      onDocChanged: () => {
        /* v8 ignore next -- the suppression flag is set only in the destroy
           cleanup, after which no further update can reach this listener. */
        if (suppressed) return
        markDirty(workspaceId, path)
      },
      onSave: () => {
        const live = viewRef.current
        /* v8 ignore next -- the keymap fires only while its view is mounted,
           which is exactly when viewRef holds it. */
        if (live === null) return
        void verbs.current.save(workspaceId, path, live.state.doc.toString())
      },
      onRequestClose: () => {
        verbs.current.onRequestClose()
      },
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      suppressed = true
      destroy()
    }
  }, [props.path, props.workspaceId, ready])

  // A settled save marks the store clean; re-mark dirty when the live
  // document moved on while the save was in flight.
  const settledClean = status === 'clean'
  useEffect(() => {
    if (!settledClean) return
    const live = viewRef.current
    const current = entryRef.current
    if (live === null || current === undefined || current.draft === live.state.doc.toString()) return
    verbs.current.markDirty(props.workspaceId, props.path)
  }, [props.path, props.workspaceId, settledClean])

  // Report the dirty fact upward; the owner confirms before closing.
  const dirty = status === 'dirty' || status === 'saving' || status === 'conflict'
  useEffect(() => {
    verbs.current.onDirtyChange(dirty)
    return () => { verbs.current.onDirtyChange(false) }
  }, [dirty])

  /* v8 ignore next -- split always returns at least one element, so the
     fallback spelling is unreachable for every string path. */
  const name = props.path.split('/').pop() ?? props.path
  if (props.readOnlyFallback !== undefined) {
    return (
      <div className={css.notice} role="note">
        {props.t('editor.unavailable', { reason: props.readOnlyFallback.reason })}
      </div>
    )
  }
  if (entry === undefined || status === 'loading') {
    return <div className={css.notice}>{props.t('editor.loading', { name })}</div>
  }
  if (status === 'unavailable') {
    return <div className={css.notice} role="note">{props.t('editor.unavailable', { reason: entry.error ?? '' })}</div>
  }
  const statusText = status === 'saving'
    ? props.t('editor.saving')
    : status === 'conflict' ? props.t('editor.conflictTitle')
      : dirty ? props.t('editor.dirty') : props.t('editor.clean')
  return (
    <div className={css.host} data-workspace-editor aria-label={props.t('editor.editorAria', { path: props.path })}>
      <div className={css.toolbar}>
        <span
          className={css.statusText}
          data-status={status}
          aria-live="polite"
        >
          {statusText}
        </span>
        <small className={css.encoding}>
          {props.t('editor.encoding', {
            encoding: entry.encoding,
            bom: entry.bom ? props.t('editor.encodingBom') : '',
            eol: entry.eol,
          })}
        </small>
        <button
          type="button"
          className={css.saveButton}
          aria-label={status === 'conflict'
            ? props.t('editor.conflictOverwrite')
            : props.t('editor.saveAria', { name })}
          disabled={!dirty || status === 'saving'}
          onClick={() => {
            const live = viewRef.current
            /* v8 ignore next -- the toolbar renders only alongside a mounted
               view; the ref is empty solely inside the create-effect window
               before paint, which no click can target. */
            if (live === null) return
            if (status === 'conflict') {
              void props.confirmOverwrite(props.workspaceId, props.path, live.state.doc.toString())
            } else {
              void props.save(props.workspaceId, props.path, live.state.doc.toString())
            }
          }}
        >
          {status === 'conflict' ? props.t('editor.conflictOverwrite') : props.t('editor.save')}
        </button>
      </div>
      {status === 'error' && entry.error !== undefined && (
        <div className={css.error} role="alert">{props.t('editor.error', { reason: entry.error })}</div>
      )}
      {status === 'conflict' && entry.conflict !== undefined && (
        <div className={css.conflict} role="alert">
          <strong>{props.t('editor.conflictTitle')}</strong>
          <span>{props.t('editor.conflictDescription')}</span>
          <div className={css.conflictActions}>
            <button type="button" onClick={() => { setDiffOpen(open => !open) }}>
              {diffOpen ? props.t('editor.conflictHideDiff') : props.t('editor.conflictDiff')}
            </button>
            <button type="button" onClick={() => { void props.reload(props.workspaceId, props.path) }}>
              {props.t('editor.conflictReload')}
            </button>
          </div>
          {diffOpen && (
            <div className={css.diff}>
              <DiffBlock diffs={[
                { path: props.path, oldText: entry.conflict.diskContent ?? '', newText: entry.draft },
              ]} />
            </div>
          )}
        </div>
      )}
      {/* The contenteditable host; CodeMirror owns the textbox semantics and
          the aria-label names the file being edited. */}
      <div ref={hostRef} className={css.editor} aria-label={props.t('editor.contentAria', { path: props.path })} />
    </div>
  )
}

/** Create the CodeMirror view plus its destroy handle. */
function createEditor(options: {
  host: HTMLDivElement
  entry: { draft: string; history?: unknown }
  languagePath: string
  onDocChanged: () => void
  onSave: () => void
  onRequestClose: () => void
}): { view: EditorViewLike; destroy: () => void } {
  const view: EditorViewLike = createEditorView(options)
  return {
    view,
    destroy: () => { view.destroy() },
  }
}
