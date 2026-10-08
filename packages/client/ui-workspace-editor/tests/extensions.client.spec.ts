// @vitest-environment jsdom
/**
 * Extension-mapping and view-construction specs: every mapped extension
 * resolves its language support, unmapped paths edit as plain text, and a
 * serialized history restores (rather than resets) the document state.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { historyField, undo } from '@codemirror/commands'
import { createEditorView, editorExtensions } from '../src/client/extensions.ts'
import { languageExtensions } from '../src/client/languages.ts'

// jsdom's Range lacks the geometry APIs CodeMirror's measure loop calls;
// empty rect lists keep the view functional without a layout engine.
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = (): DOMRectList => [] as unknown as DOMRectList
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = (): DOMRect => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('languageExtensions', () => {
  it.each([
    ['a.js'], ['a.mjs'], ['a.cjs'], ['a.jsx'],
    ['a.ts'], ['a.mts'], ['a.cts'], ['a.tsx'],
    ['a.json'], ['a.py'], ['a.html'], ['a.htm'], ['a.vue'], ['a.svelte'], ['a.css'], ['a.md'], ['a.markdown'],
  ])('maps %s to a language facet', (path) => {
    expect(languageExtensions(path)).toHaveLength(1)
  })

  it.each([
    ['plain.txt'], ['Makefile'], ['Dockerfile'], ['noext'],
  ])('leaves %s as plain text', (path) => {
    expect(languageExtensions(path)).toHaveLength(0)
  })
})

describe('editorExtensions', () => {
  it('wires the save and escape keys and the doc-change listener', () => {
    const events: string[] = []
    const view = createEditorView({
      host: document.createElement('div'),
      entry: { draft: 'x\n' },
      languagePath: 'plain.txt',
      onSave: () => { events.push('save') },
      onRequestClose: () => { events.push('close') },
      onDocChanged: () => { events.push('edit') },
    })
    expect(view.state.doc.toString()).toBe('x\n')
    view.focus()
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(events).toContain('save')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(events).toContain('close')
    view.dispatch({ changes: { from: 0, insert: 'y' } })
    expect(events).toContain('edit')
    // A selection-only update is not a document change.
    view.dispatch({ selection: { anchor: 1 } })
    expect(events.filter(event => event === 'edit')).toHaveLength(1)
    view.destroy()
  })

  it('restores a serialized history instead of resetting it', () => {
    const first = createEditorView({
      host: document.createElement('div'),
      entry: { draft: 'one\ntwo\n' },
      languagePath: 'a.ts',
      onSave: () => undefined,
      onRequestClose: () => undefined,
      onDocChanged: () => undefined,
    })
    first.dispatch({ changes: { from: 0, insert: 'x' } })
    first.dispatch({ changes: { from: 1, insert: 'y' } })
    const serialized: unknown = first.state.toJSON({ history: historyField })
    first.destroy()

    const second = createEditorView({
      host: document.createElement('div'),
      entry: { draft: 'one\ntwo\n', history: serialized },
      languagePath: 'a.ts',
      onSave: () => undefined,
      onRequestClose: () => undefined,
      onDocChanged: () => undefined,
    })
    expect(second.state.doc.toString()).toBe('xyone\ntwo\n')
    // The restored history undoes the serialized edits (grouped into one
    // event by their insertion time).
    undo({ state: second.state, dispatch: (transaction) => { second.update([transaction]) } })
    expect(second.state.doc.toString()).toBe('one\ntwo\n')
    second.destroy()
  })

  it('ignores a malformed history payload and starts from the draft', () => {
    const view = createEditorView({
      host: document.createElement('div'),
      entry: { draft: 'plain\n', history: { bogus: true } },
      languagePath: 'plain.txt',
      onSave: () => undefined,
      onRequestClose: () => undefined,
      onDocChanged: () => undefined,
    })
    expect(view.state.doc.toString()).toBe('plain\n')
    view.destroy()
  })

  it('builds the extension set deterministically', () => {
    const extensions = editorExtensions({
      host: document.createElement('div'),
      entry: { draft: 'x\n' },
      languagePath: 'plain.txt',
      onDocChanged: () => undefined,
      onSave: () => undefined,
      onRequestClose: () => undefined,
    })
    expect(Array.isArray(extensions)).toBe(true)
    expect(extensions.length).toBeGreaterThan(0)
  })
})
