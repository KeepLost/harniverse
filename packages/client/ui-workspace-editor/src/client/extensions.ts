/**
 * CodeMirror construction: the extension set (line numbers, undo history,
 * line wrapping, tab size 2, bracket/indent assists, search) and the
 * keymap (Mod-s manual save; Escape closes the search panel first and
 * otherwise requests the preview close). The view restores a serialized
 * history when the entry carries one, so overlay↔drawer switches keep the
 * undo stack.
 * @module ui-workspace-editor/extensions
 */
import { EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyField, historyKeymap } from '@codemirror/commands'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { languageExtensions } from './languages.ts'

/** Inputs to one editor view construction. */
export interface EditorViewInputs {
  /** Host element the view mounts into. */
  readonly host: HTMLDivElement
  /** Initial draft text (restored documents carry their serialized doc). */
  readonly entry: { readonly draft: string; readonly history?: unknown }
  /** Document path driving the language mapping. */
  readonly languagePath: string
  /** Notification for every user document change. */
  readonly onDocChanged: () => void
  /** Manual save trigger (Mod-s). */
  readonly onSave: () => void
  /** Escape fell through the editor's own bindings. */
  readonly onRequestClose: () => void
}

/**
 * Assemble the shared extension set for one document.
 * @param inputs - the document's callbacks.
 * @returns the CodeMirror extensions.
 */
export function editorExtensions(inputs: EditorViewInputs): Extension[] {
  return [
    lineNumbers(),
    history(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    search({ top: true }),
    highlightSelectionMatches(),
    EditorState.tabSize.of(2),
    indentUnit.of('  '),
    EditorView.lineWrapping,
    ...languageExtensions(inputs.languagePath),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      { key: 'Mod-s', preventDefault: true, run: () => { inputs.onSave(); return true } },
      // After searchKeymap: an open search panel consumes Escape itself, and
      // only a fallen-through Escape asks the owner to close the preview.
      { key: 'Escape', run: () => { inputs.onRequestClose(); return true } },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) inputs.onDocChanged()
    }),
  ]
}

/**
 * Create the CodeMirror view for one document, restoring a serialized
 * history when the entry carries one.
 * @param inputs - the document's host, entry, and callbacks.
 * @returns the mounted view.
 */
export function createEditorView(inputs: EditorViewInputs): EditorView {
  const extensions = editorExtensions(inputs)
  const state = inputs.entry.history !== undefined && isSerializedState(inputs.entry.history)
    ? EditorState.fromJSON(inputs.entry.history, { extensions }, { history: historyField })
    : EditorState.create({ doc: inputs.entry.draft, extensions })
  return new EditorView({ state, parent: inputs.host })
}

/** Whether a stored history payload looks like a serialized EditorState. */
function isSerializedState(history: unknown): history is { doc: string } {
  return typeof history === 'object' && history !== null && typeof (history as { doc?: unknown }).doc === 'string'
}
