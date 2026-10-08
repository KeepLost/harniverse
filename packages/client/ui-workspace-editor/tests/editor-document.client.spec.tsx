// @vitest-environment jsdom
/**
 * Component specs for the preview-document occupant: rendering over the
 * real controller and a scripted wire — dirty marking on edits, the manual
 * save button and its aria contract, the owner's saved callback, the dirty
 * fact standing across unmounts while the draft is held, the conflict bar
 * (reload / compare / overwrite), Escape falling through to the owner's close
 * request, the in-flight save states, and the read-only fallbacks
 * (owner-level and Host refusal).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { WorkspaceEditorController } from '../src/client/editor-controller.ts'
import { WorkspaceEditorDocument } from '../src/client/EditorDocument.tsx'
import type { WorkspaceEditorInjected } from '../src/client/EditorDocument.tsx'
import { createWorkspaceEditorStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locales.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFileOpenResult } from '@deepseek-ai/dsh-api-remotes/client'

// jsdom's Range lacks the geometry APIs CodeMirror's measure loop calls;
// empty rect lists keep the view functional without a layout engine.
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = (): DOMRectList => [] as unknown as DOMRectList
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = (): DOMRect => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const t = makeTranslate(zh, commonZh) as unknown as Parameters<typeof WorkspaceEditorDocument>[0]['t']

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

const openBody = (content: string, version: string): WorkspaceFileOpenResult => ({
  content, version, bytes: content.length, encoding: 'utf-8', encodingSource: 'utf8', bom: false, eol: 'LF',
})

/** One scripted composition: controller + store + bound props. */
function setup(options: {
  owner?: Partial<Parameters<typeof WorkspaceEditorDocument>[0]>
  saveGate?: () => Promise<RemoteResult<{ version: string }>>
} = {}) {
  const store = createWorkspaceEditorStore()
  const saves: Array<{ content: string; baseVersion: string; saveId: string }> = []
  let saveResult: RemoteResult<{ version: string }> = ok({ version: 'v2' })
  const controller = new WorkspaceEditorController(store, {
    open: async () => ok(openBody('first\nsecond\n', 'v1')),
    stat: async () => ok({ version: 'v1' }),
    save: async (_workspaceId, _path, request) => {
      saves.push(request)
      if (options.saveGate !== undefined) return await options.saveGate()
      return saveResult
    },
  })
  const useEditorState = bindSnapshotSelector(store)
  const injected: Omit<WorkspaceEditorInjected, 'hooks'> = {
    machineKey: 'host',
    attach: (workspaceId, path) => { controller.attach('host', workspaceId, path) },
    detach: (workspaceId, path, snapshot) => { controller.detach('host', workspaceId, path, snapshot) },
    markDirty: (workspaceId, path) => { controller.markDirty('host', workspaceId, path) },
    save: (workspaceId, path, content) => controller.save('host', workspaceId, path, content),
    confirmOverwrite: (workspaceId, path, content) => controller.confirmOverwrite('host', workspaceId, path, content),
    reload: (workspaceId, path) => controller.reload('host', workspaceId, path),
  }
  const onDirtyChange = vi.fn<(dirty: boolean) => void>()
  const onRequestClose = vi.fn<() => void>()
  const owner = {
    workspaceId: 'ws-1' as never,
    path: 'a.ts',
    kind: 'code' as const,
    active: true,
    placement: 'overlay' as const,
    onDirtyChange,
    onRequestClose,
    ...options.owner,
  }
  const element = (patch: Partial<Parameters<typeof WorkspaceEditorDocument>[0]> = {}) => (
    <WorkspaceEditorDocument
      {...owner}
      {...patch}
      {...injected}
      useEditorState={useEditorState}
      t={t}
    />
  )
  const view = render(element())
  return {
    view,
    store,
    saves,
    setSaveResult: (result: RemoteResult<{ version: string }>): void => { saveResult = result },
    owner,
    onDirtyChange,
    onRequestClose,
    element,
  }
}

/** Type a character at the start of the mounted document and wait for the save button to enable. */
async function editDocument(view: ReturnType<typeof render>, text = 'x'): Promise<void> {
  await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
  const { EditorView } = await import('@codemirror/view')
  const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
  editor.dispatch({ changes: { from: 0, insert: text } })
  await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
}

/** The mounted CodeMirror content DOM. */
function cmContent(view: ReturnType<typeof render>): HTMLElement {
  const host = view.container.querySelector('[data-workspace-editor] .cm-content') as HTMLElement | null
  if (host === null) throw new Error('CodeMirror content not mounted')
  return host
}

describe('WorkspaceEditorDocument', () => {
  it('loads, edits mark dirty, and the save button persists content', async () => {
    const { view, saves } = setup()
    await waitFor(() => { expect(view.getByRole('button', { name: '保存对 a.ts 的修改' })).toBeTruthy() })
    expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(true)
    // A direct transaction is the deterministic jsdom edit route (jsdom has
    // no layout, so beforeinput composition does not run).
    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 0, insert: '# ' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    expect(view.getByText('有未保存的修改')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(saves).toHaveLength(1) })
    expect(saves[0]).toMatchObject({ content: '# first\nsecond\n', baseVersion: 'v1' })
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
  })

  it('reports the dirty fact to the owner and leaves it standing when the unmount keeps the draft', async () => {
    const { view, onDirtyChange } = setup()
    await editDocument(view)
    await waitFor(() => { expect(onDirtyChange).toHaveBeenCalledWith(true) })
    onDirtyChange.mockClear()
    view.unmount()
    // The draft stays in the account, so the owner keeps confirming a close.
    expect(onDirtyChange).not.toHaveBeenCalled()
  })

  it('reports a clean entry once and does not report again on unmount', async () => {
    const { view, onDirtyChange } = setup()
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
    expect(onDirtyChange.mock.calls).toEqual([[false]])
    view.unmount()
    expect(onDirtyChange.mock.calls).toEqual([[false]])
  })

  it('reports false when a save settles the entry clean while mounted', async () => {
    const { view, onDirtyChange } = setup()
    await editDocument(view)
    await waitFor(() => { expect(onDirtyChange).toHaveBeenLastCalledWith(true) })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(onDirtyChange).toHaveBeenLastCalledWith(false) })
  })

  it('restores the held draft and reports it dirty again when the occupant remounts', async () => {
    const { view, element, onDirtyChange } = setup()
    await editDocument(view, '# ')
    await waitFor(() => { expect(onDirtyChange).toHaveBeenLastCalledWith(true) })
    view.unmount()

    const remountedOwner = vi.fn()
    const remounted = render(element({ onDirtyChange: remountedOwner }))
    await waitFor(() => { expect(remounted.getByText('有未保存的修改')).toBeTruthy() })
    expect(remounted.container.querySelector('[data-workspace-editor] .cm-content')?.textContent).toContain('# first')
    expect(remountedOwner).toHaveBeenCalledWith(true)
    expect(remountedOwner).not.toHaveBeenCalledWith(false)
  })

  it('keeps each document\'s dirty fact when the occupant is reused for another path', async () => {
    const { view, element, onDirtyChange } = setup()
    await editDocument(view)
    await waitFor(() => { expect(onDirtyChange).toHaveBeenLastCalledWith(true) })
    onDirtyChange.mockClear()

    const other = vi.fn()
    view.rerender(element({ path: 'b.ts', onDirtyChange: other }))
    await waitFor(() => { expect(other).toHaveBeenCalledWith(false) })
    // The first document stays dirty: nothing retracts it on the switch.
    expect(onDirtyChange).not.toHaveBeenCalled()

    // Returning to it finds the held draft and reports the fact again.
    const back = vi.fn()
    view.rerender(element({ path: 'a.ts', onDirtyChange: back }))
    await waitFor(() => { expect(back).toHaveBeenCalledWith(true) })
  })

  it('tells the owner when a save lands, from the button and from the keymap', async () => {
    const onSaved = vi.fn()
    const { view, saves } = setup({ owner: { onSaved } })
    await editDocument(view)
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(onSaved).toHaveBeenCalledTimes(1) })
    expect(saves).toHaveLength(1)

    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 0, insert: 'k' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    cmContent(view).focus()
    fireEvent.keyDown(cmContent(view), { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    await waitFor(() => { expect(onSaved).toHaveBeenCalledTimes(2) })
  })

  it('does not tell the owner about a refused save, a conflict, or a save that never started', async () => {
    const onSaved = vi.fn()
    const { view, setSaveResult, saves } = setup({ owner: { onSaved } })
    await editDocument(view)
    setSaveResult({ ok: false, error: { code: 'unmappable', message: 'nope', details: {} } })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getByRole('alert').textContent).toContain('保存失败') })

    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 1, insert: 'y' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    setSaveResult({ ok: false, error: { code: 'stale-version', message: 'changed', details: { currentVersion: 'v9' } } })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getAllByText('文件在磁盘上已被修改').length).toBeGreaterThanOrEqual(2) })

    // Ctrl+S during the conflict is ignored by the controller: no save, no callback.
    cmContent(view).focus()
    fireEvent.keyDown(cmContent(view), { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(saves).toHaveLength(2)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('tells the owner when a confirmed conflict overwrite lands', async () => {
    const onSaved = vi.fn()
    const { view, setSaveResult } = setup({ owner: { onSaved } })
    await editDocument(view)
    setSaveResult({ ok: false, error: { code: 'stale-version', message: 'changed', details: { currentVersion: 'v9' } } })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getAllByText('文件在磁盘上已被修改').length).toBeGreaterThanOrEqual(2) })
    expect(onSaved).not.toHaveBeenCalled()
    setSaveResult(ok({ version: 'v10' }))
    fireEvent.click(view.getByRole('button', { name: '覆盖磁盘版本' }))
    await waitFor(() => { expect(onSaved).toHaveBeenCalledTimes(1) })
  })

  it('retracts the dirty fact itself when a save settles after the occupant unmounted', async () => {
    let release: (value: RemoteResult<{ version: string }>) => void = () => {}
    const gate = new Promise<RemoteResult<{ version: string }>>((resolve) => { release = resolve })
    const onSaved = vi.fn()
    const { view, onDirtyChange } = setup({ saveGate: () => gate, owner: { onSaved } })
    await editDocument(view)
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getByText('保存中…')).toBeTruthy() })
    onDirtyChange.mockClear()
    // A Preview toggle mid-save: no mounted effect is left to report the clean entry.
    view.unmount()
    expect(onDirtyChange).not.toHaveBeenCalled()
    release(ok({ version: 'v3' }))
    await waitFor(() => { expect(onDirtyChange).toHaveBeenCalledWith(false) })
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('surfaces a stale save as the conflict bar with reload and overwrite', async () => {
    const { view, setSaveResult, saves } = setup()
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 0, insert: 'x' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    setSaveResult({ ok: false, error: { code: 'stale-version', message: 'changed', details: { currentVersion: 'v9' } } })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getAllByText('文件在磁盘上已被修改').length).toBeGreaterThanOrEqual(2) })
    fireEvent.click(view.getByRole('button', { name: '对比修改' }))
    expect(view.container.querySelector('[data-workspace-editor]')).toBeTruthy()
    setSaveResult(ok({ version: 'v10' }))
    fireEvent.click(view.getByRole('button', { name: '覆盖磁盘版本' }))
    await waitFor(() => { expect(saves.at(-1)).toMatchObject({ baseVersion: 'v9' }) })
  })

  it('routes a fallen-through Escape to the owner close request', async () => {
    const { view, onRequestClose } = setup()
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
    const content = cmContent(view)
    content.focus()
    fireEvent.keyDown(content, { key: 'Escape', bubbles: true })
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('renders the owner-level read-only fallback with a reason', () => {
    const { view } = setup({ owner: { readOnlyFallback: { reason: 'opened with an explicit encoding' } } })
    expect(view.getByText('此文件不可编辑：opened with an explicit encoding')).toBeTruthy()
    expect(view.container.querySelector('.cm-editor')).toBeNull()
  })

  it('renders the Host refusal as a read-only notice', async () => {
    const store = createWorkspaceEditorStore()
    const controller = new WorkspaceEditorController(store, {
      open: async () => ({ ok: false, error: { code: 'mixed-eol', message: 'mixed line endings', details: {} } }),
      stat: async () => ok({ version: 'v1' }),
      save: async () => { throw new Error('unreachable') },
    })
    const view = render(
      <WorkspaceEditorDocument
        workspaceId={'ws-1' as never}
        path="mix.txt"
        kind="text"
        active
        placement="in-column"
        onDirtyChange={vi.fn()}
        onRequestClose={vi.fn()}
        machineKey="host"
        attach={(workspaceId, path) => { controller.attach('host', workspaceId, path) }}
        detach={(workspaceId, path, snapshot) => { controller.detach('host', workspaceId, path, snapshot) }}
        markDirty={(workspaceId, path) => { controller.markDirty('host', workspaceId, path) }}
        save={(workspaceId, path, content) => controller.save('host', workspaceId, path, content)}
        confirmOverwrite={(workspaceId, path, content) => controller.confirmOverwrite('host', workspaceId, path, content)}
        reload={(workspaceId, path) => controller.reload('host', workspaceId, path)}
        useEditorState={bindSnapshotSelector(store)}
        t={t}
      />,
    )
    await waitFor(() => { expect(view.getByText('此文件不可编辑：mixed line endings')).toBeTruthy() })
    expect(view.container.querySelector('.cm-editor')).toBeNull()
  })
})

describe('WorkspaceEditorDocument save lifecycle states', () => {
  it('shows the saving state while a save is in flight and disables the button', async () => {
    let release: (value: RemoteResult<{ version: string }>) => void = () => {}
    const gate = new Promise<RemoteResult<{ version: string }>>((resolve) => { release = resolve })
    const { view } = setup({ saveGate: () => gate })
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 0, insert: 'x' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getByText('保存中…')).toBeTruthy() })
    expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(true)
    release(ok({ version: 'v3' }))
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
  })

  it('re-marks dirty when the document moved on while the save was in flight', async () => {
    let release: (value: RemoteResult<{ version: string }>) => void = () => {}
    const gate = new Promise<RemoteResult<{ version: string }>>((resolve) => { release = resolve })
    const { view } = setup({ saveGate: () => gate })
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 0, insert: 'x' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getByText('保存中…')).toBeTruthy() })
    editor.dispatch({ changes: { from: 1, insert: 'y' } })
    release(ok({ version: 'v3' }))
    await waitFor(() => { expect(view.getByText('有未保存的修改')).toBeTruthy() })
  })

  it('surfaces a typed save refusal as an error alert', async () => {
    const { view, setSaveResult } = setup()
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 0, insert: 'x' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    setSaveResult({ ok: false, error: { code: 'unmappable', message: '🎉 (U+1F389) at line 1 column 2', details: {} } })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getByRole('alert').textContent).toContain('保存失败') })
    // The errored entry edits back to dirty.
    editor.dispatch({ changes: { from: 1, insert: 'z' } })
    await waitFor(() => { expect(view.getByText('有未保存的修改')).toBeTruthy() })
  })

  it('offers reload on the conflict bar and renders the disk diff', async () => {
    const { view, setSaveResult } = setup()
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 0, insert: 'x' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    setSaveResult({ ok: false, error: { code: 'stale-version', message: 'changed', details: { currentVersion: 'v9' } } })
    fireEvent.click(view.getByRole('button', { name: '保存对 a.ts 的修改' }))
    await waitFor(() => { expect(view.getAllByText('文件在磁盘上已被修改').length).toBeGreaterThanOrEqual(2) })
    fireEvent.click(view.getByRole('button', { name: '对比修改' }))
    await waitFor(() => { expect(view.container.querySelector('.cm-editor')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: '放弃修改并重新加载' }))
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
  })

  it('renders an unavailable entry without an error message', async () => {
    const store = createWorkspaceEditorStore()
    store.update((draft) => {
      draft.byMachine.host = {
        'ws-1\u0000gone.txt': {
          draft: '', baseVersion: 'v0', eol: 'LF', encoding: 'utf-8', bom: false, status: 'unavailable',
        },
      }
    })
    const controller = new WorkspaceEditorController(store, {
      open: async () => ok(openBody('x\n', 'v1')),
      stat: async () => ok({ version: 'v1' }),
      save: async () => ok({ version: 'v2' }),
    })
    const view = render(
      <WorkspaceEditorDocument
        workspaceId={'ws-1' as never}
        path="gone.txt"
        kind="text"
        active
        placement="in-column"
        onDirtyChange={vi.fn()}
        onRequestClose={vi.fn()}
        machineKey="host"
        attach={(workspaceId, path) => { controller.attach('host', workspaceId, path) }}
        detach={(workspaceId, path, snapshot) => { controller.detach('host', workspaceId, path, snapshot) }}
        markDirty={(workspaceId, path) => { controller.markDirty('host', workspaceId, path) }}
        save={(workspaceId, path, content) => controller.save('host', workspaceId, path, content)}
        confirmOverwrite={(workspaceId, path, content) => controller.confirmOverwrite('host', workspaceId, path, content)}
        reload={(workspaceId, path) => controller.reload('host', workspaceId, path)}
        useEditorState={bindSnapshotSelector(store)}
        t={t}
      />,
    )
    expect(view.getByText('此文件不可编辑：')).toBeTruthy()
  })
})

describe('WorkspaceEditorDocument keyboard and encoding metadata', () => {
  it('saves through the editor keymap shortcut', async () => {
    const { view, saves } = setup()
    await waitFor(() => { expect(view.getByText('无修改')).toBeTruthy() })
    const { EditorView } = await import('@codemirror/view')
    const editor = EditorView.findFromDOM(cmContent(view)) as InstanceType<typeof EditorView>
    editor.dispatch({ changes: { from: 0, insert: 'k' } })
    await waitFor(() => { expect((view.getByRole('button', { name: '保存对 a.ts 的修改' }) as HTMLButtonElement).disabled).toBe(false) })
    cmContent(view).focus()
    fireEvent.keyDown(cmContent(view), { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    await waitFor(() => { expect(saves).toHaveLength(1) })
    expect(saves[0]).toMatchObject({ content: 'kfirst\nsecond\n' })
  })

  it('renders the byte-order-mark note for a BOM file', async () => {
    const store = createWorkspaceEditorStore()
    const controller = new WorkspaceEditorController(store, {
      open: async () => ({ ok: true, value: { ...openBody('bom\n', 'v1'), bom: true, eol: 'CRLF' as const } }),
      stat: async () => ({ ok: true, value: { version: 'v1' } }),
      save: async () => ({ ok: true, value: { version: 'v2' } }),
    })
    const rendered = render(
      <WorkspaceEditorDocument
        workspaceId={'ws-1' as never}
        path="bom.ts"
        kind="code"
        active
        placement="overlay"
        onDirtyChange={vi.fn()}
        onRequestClose={vi.fn()}
        machineKey="host"
        attach={(workspaceId, path) => { controller.attach('host', workspaceId, path) }}
        detach={(workspaceId, path, snapshot) => { controller.detach('host', workspaceId, path, snapshot) }}
        markDirty={(workspaceId, path) => { controller.markDirty('host', workspaceId, path) }}
        save={(workspaceId, path, content) => controller.save('host', workspaceId, path, content)}
        confirmOverwrite={(workspaceId, path, content) => controller.confirmOverwrite('host', workspaceId, path, content)}
        reload={(workspaceId, path) => controller.reload('host', workspaceId, path)}
        useEditorState={bindSnapshotSelector(store)}
        t={t}
      />,
    )
    await waitFor(() => { expect(rendered.getByText(/BOM/u)).toBeTruthy() })
    expect(rendered.getByText(/CRLF/u)).toBeTruthy()
  })

  it('renders the conflict diff with an empty disk side when the disk read failed', async () => {
    const store = createWorkspaceEditorStore()
    store.update((draft) => {
      draft.byMachine.host = {
        'ws-1\u0000c.ts': {
          draft: 'mine\n', baseVersion: 'v1', eol: 'LF', encoding: 'utf-8', bom: false, status: 'conflict',
          conflict: { currentVersion: 'v2', diskContent: null },
        },
      }
    })
    const controller = new WorkspaceEditorController(store, {
      open: async () => ok(openBody('disk\n', 'v2')),
      stat: async () => ok({ version: 'v2' }),
      save: async () => ok({ version: 'v3' }),
    })
    const rendered = render(
      <WorkspaceEditorDocument
        workspaceId={'ws-1' as never}
        path="c.ts"
        kind="code"
        active
        placement="overlay"
        onDirtyChange={vi.fn()}
        onRequestClose={vi.fn()}
        machineKey="host"
        attach={(workspaceId, path) => { controller.attach('host', workspaceId, path) }}
        detach={(workspaceId, path, snapshot) => { controller.detach('host', workspaceId, path, snapshot) }}
        markDirty={(workspaceId, path) => { controller.markDirty('host', workspaceId, path) }}
        save={(workspaceId, path, content) => controller.save('host', workspaceId, path, content)}
        confirmOverwrite={(workspaceId, path, content) => controller.confirmOverwrite('host', workspaceId, path, content)}
        reload={(workspaceId, path) => controller.reload('host', workspaceId, path)}
        useEditorState={bindSnapshotSelector(store)}
        t={t}
      />,
    )
    fireEvent.click(rendered.getByRole('button', { name: '对比修改' }))
    await waitFor(() => { expect(rendered.getByText('c.ts')).toBeTruthy() })
    expect(rendered.getAllByText('mine').length).toBeGreaterThan(0)
  })
})
