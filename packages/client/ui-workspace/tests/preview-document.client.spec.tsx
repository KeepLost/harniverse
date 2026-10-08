// @vitest-environment jsdom
/**
 * Preview-document occupancy specs: an editable family shows its rendered
 * preview by default and takes the editor seat in Edit mode (everything else
 * keeps its read-only render), the Preview / Edit toggle drives the mode the
 * workbench store keeps per tab across tab and placement switches, the
 * occupant defers window-capture Escape, and its dirty fact gates closing
 * through the owner's confirmation.
 */
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { WorkbenchPreview } from '../src/client/WorkbenchPreview.tsx'
import type { EditorSeat } from '../src/client/WorkbenchPreview.tsx'
import { WorkspaceWorkbench, WorkspaceWorkbenchPreviewOverlay } from '../src/client/WorkspaceWorkbench.tsx'
import type { PreviewDocumentOwnerProps, WorkspaceWorkbenchProps } from '../src/client/contract/slots.ts'
import { createWorkspaceWorkbenchStore } from '../src/client/stores.ts'
import type { WorkbenchPreviewMode } from '../src/client/stores.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const t: WorkspaceWorkbenchProps['t'] = makeTranslate(zh, commonZh)

const codeTab = { id: 'file:main.ts', path: 'src/main.ts', title: 'main.ts', kind: 'code' as const, language: 'typescript', loading: false, content: 'export {}\n' }
const imageTab = { id: 'file:logo.png', path: 'logo.png', title: 'logo.png', kind: 'image' as const, loading: false, dataBase64: '', mediaType: 'image/png' }

function previewProps(overrides: Partial<Parameters<typeof WorkbenchPreview>[0]> = {}) {
  return {
    tabs: [codeTab],
    activeTabId: 'file:main.ts',
    open: true,
    placement: 'in-column' as const,
    t,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

/** An editor seat whose render marks occupancy with a probe element. */
function seat(overrides: Partial<EditorSeat> = {}): EditorSeat {
  return {
    workspaceId: 'ws-1',
    placement: 'in-column',
    render: owner => (
      <div data-editor-occupant={owner.path} data-workspace-editor role="textbox" tabIndex={-1}>
        editor
      </div>
    ),
    isDirty: () => false,
    onDirtyChange: vi.fn(),
    onSaved: vi.fn(),
    onRequestClose: vi.fn(),
    ...overrides,
  }
}

/** Owns the per-tab mode the way the workbench store does, so the toggle round-trips through real props. */
function ModeHost({ initial, onModeChange, ...rest }: Parameters<typeof WorkbenchPreview>[0] & { initial?: WorkbenchPreviewMode }) {
  const [mode, setMode] = useState<WorkbenchPreviewMode>(initial ?? 'preview')
  return (
    <WorkbenchPreview
      {...rest}
      mode={mode}
      onModeChange={(tabId, next) => { onModeChange?.(tabId, next); setMode(next) }}
    />
  )
}

const modeGroup = (scope: ReturnType<typeof render>) => scope.getByRole('group', { name: '预览与编辑模式' })

describe('preview-document occupancy', () => {
  it('renders the occupant in Edit mode and keeps the read-only renderer without a seat', () => {
    const withSeat = render(<WorkbenchPreview {...previewProps({ editor: seat(), mode: 'edit', onModeChange: vi.fn() })} />)
    expect(withSeat.container.querySelector('[data-editor-occupant="src/main.ts"]')).toBeTruthy()
    withSeat.unmount()

    const withoutSeat = render(<WorkbenchPreview {...previewProps()} />)
    expect(withoutSeat.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(withoutSeat.container.textContent).toContain('export {}')
    expect(withoutSeat.queryByRole('group', { name: '预览与编辑模式' })).toBeNull()
    withoutSeat.unmount()
  })

  it('keeps non-editable, truncated, and not-yet-read families on their read-only renderer without a toggle', () => {
    const imageSeat = render(<WorkbenchPreview {...previewProps({ tabs: [imageTab], activeTabId: 'file:logo.png', editor: seat(), mode: 'edit', onModeChange: vi.fn() })} />)
    expect(imageSeat.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(imageSeat.queryByRole('group', { name: '预览与编辑模式' })).toBeNull()
    imageSeat.unmount()

    const truncated = { ...codeTab, truncated: true }
    const truncatedSeat = render(<WorkbenchPreview {...previewProps({ tabs: [truncated], editor: seat(), mode: 'edit', onModeChange: vi.fn() })} />)
    expect(truncatedSeat.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(truncatedSeat.queryByRole('group', { name: '预览与编辑模式' })).toBeNull()
    expect(truncatedSeat.getByText('文件超过文本预览上限，当前内容已截断')).toBeTruthy()
    truncatedSeat.unmount()

    const { content: _content, ...reading } = { ...codeTab, loading: true }
    const loading = render(<WorkbenchPreview {...previewProps({ tabs: [reading], editor: seat(), mode: 'edit', onModeChange: vi.fn() })} />)
    expect(loading.queryByRole('group', { name: '预览与编辑模式' })).toBeNull()
    expect(loading.getByText('正在读取 main.ts…')).toBeTruthy()
  })

  it('offers no toggle and no occupant while the owner supplies no mode handler', () => {
    const view = render(<WorkbenchPreview {...previewProps({ editor: seat() })} />)
    expect(view.queryByRole('group', { name: '预览与编辑模式' })).toBeNull()
    expect(view.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(view.container.textContent).toContain('export {}')
  })

  it('lets the occupant keep Escape and forwards owner facts', () => {
    const onDismiss = vi.fn()
    const editor = seat()
    const view = render(<WorkbenchPreview {...previewProps({ onDismiss, editor, mode: 'edit', onModeChange: vi.fn() })} />)
    const occupant = view.container.querySelector('[data-editor-occupant]') as HTMLElement
    occupant.focus()
    // Escape targeting the occupant (focused editing surface) must pass the
    // preview's window-capture listener without closing the preview.
    fireEvent.keyDown(occupant, { key: 'Escape', bubbles: true })
    expect(onDismiss).not.toHaveBeenCalled()
    // Outside the occupant, Escape closes as before.
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('reports the occupant dirty facts, saves, and close requests with the document path and title', () => {
    const editor = seat({
      render: owner => (
        <div>
          <button type="button" onClick={() => { owner.onDirtyChange(true) }}>make dirty</button>
          <button type="button" onClick={() => { owner.onSaved?.() }}>saved</button>
          <button type="button" onClick={() => { owner.onRequestClose() }}>ask close</button>
        </div>
      ),
    })
    const view = render(<WorkbenchPreview {...previewProps({ editor, mode: 'edit', onModeChange: vi.fn() })} />)
    fireEvent.click(view.getByRole('button', { name: 'make dirty' }))
    expect(editor.onDirtyChange).toHaveBeenCalledWith('src/main.ts', true)
    expect(editor.onRequestClose).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'saved' }))
    expect(editor.onSaved).toHaveBeenCalledWith('src/main.ts')
    fireEvent.click(view.getByRole('button', { name: 'ask close' }))
    expect(editor.onRequestClose).toHaveBeenCalledWith('src/main.ts', 'main.ts')
  })

  it('falls back to the rendered preview when the hole renders nothing in Edit mode', () => {
    const view = render(<WorkbenchPreview {...previewProps({ editor: seat({ render: () => null }), mode: 'edit', onModeChange: vi.fn() })} />)
    expect(view.container.textContent).toContain('export {}')
  })
})

describe('Preview / Edit mode toggle', () => {
  const markdownTab = { id: 'file:notes.md', path: 'notes.md', title: 'notes.md', kind: 'markdown' as const, loading: false, content: '# Notes\n\nBody.\n' }
  const htmlTab = { id: 'file:page.html', path: 'page.html', title: 'page.html', kind: 'html' as const, loading: false, content: '<h1>frame body</h1>' }
  const csvTab = { id: 'file:data.csv', path: 'data.csv', title: 'data.csv', kind: 'csv' as const, loading: false, content: 'a,b\n1,2\n' }
  const tsvTab = { id: 'file:data.tsv', path: 'data.tsv', title: 'data.tsv', kind: 'tsv' as const, loading: false, content: 'a\tb\n1\t2\n' }
  const textTab = { id: 'file:plain.txt', path: 'plain.txt', title: 'plain.txt', kind: 'text' as const, loading: false, content: 'plain body\n' }
  const mount = (tab: Parameters<typeof WorkbenchPreview>[0]['tabs'][number], extra: Partial<Parameters<typeof ModeHost>[0]> = {}) =>
    render(<ModeHost {...previewProps({ tabs: [tab], activeTabId: tab.id, editor: seat() })} {...extra} />)

  it('shows the rendered preview of every editable family by default, with the toggle present', () => {
    const markdown = mount(markdownTab)
    expect(markdown.container.querySelector('article')?.textContent).toContain('Notes')
    expect(markdown.container.querySelector('article h1')?.textContent).toBe('Notes')
    expect(markdown.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(within(modeGroup(markdown)).getByRole('button', { name: '预览' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(modeGroup(markdown)).getByRole('button', { name: '编辑' }).getAttribute('aria-pressed')).toBe('false')
    markdown.unmount()

    const html = mount(htmlTab)
    expect(html.container.querySelector('iframe[title="page.html"]')?.getAttribute('sandbox')).toBe('allow-same-origin')
    html.unmount()

    const csv = mount(csvTab)
    expect(csv.container.querySelector('table th')?.textContent).toBe('a')
    csv.unmount()

    const tsv = mount(tsvTab)
    expect(tsv.container.querySelector('table td')?.textContent).toBe('1')
    tsv.unmount()

    const text = mount(textTab)
    expect(text.container.querySelector('pre')?.textContent).toBe('plain body\n')
    text.unmount()

    const code = mount(codeTab)
    expect(code.container.textContent).toContain('export {}')
    expect(code.container.querySelector('[data-editor-occupant]')).toBeNull()
  })

  it('switches to the editor seat and back through the toggle, reporting the active tab id', () => {
    const onModeChange = vi.fn()
    const view = mount(markdownTab, { onModeChange })
    fireEvent.click(within(modeGroup(view)).getByRole('button', { name: '编辑' }))
    expect(onModeChange).toHaveBeenLastCalledWith('file:notes.md', 'edit')
    expect(view.container.querySelector('[data-editor-occupant="notes.md"]')).toBeTruthy()
    expect(view.container.querySelector('article')).toBeNull()
    expect(within(modeGroup(view)).getByRole('button', { name: '编辑' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(within(modeGroup(view)).getByRole('button', { name: '预览' }))
    expect(onModeChange).toHaveBeenLastCalledWith('file:notes.md', 'preview')
    expect(view.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(view.container.querySelector('article h1')?.textContent).toBe('Notes')
  })

  it('keeps editing out of reach for an explicit encoding: Edit is disabled with the reason and Preview shows the content', () => {
    const explicit = { ...markdownTab, encoding: 'gb18030', encodingSource: 'explicit' as const }
    const view = mount(explicit, { initial: 'edit' })
    const edit = within(modeGroup(view)).getByRole('button', { name: '编辑' }) as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    expect(edit.title).toBe('此文件以指定编码打开，编辑需要自动检测通过往返校验的编码')
    expect(view.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(view.container.querySelector('article h1')?.textContent).toBe('Notes')
    expect(within(modeGroup(view)).getByRole('button', { name: '预览' }).getAttribute('aria-pressed')).toBe('true')
    view.unmount()

    const auto = mount({ ...markdownTab, encoding: 'utf-8', encodingSource: 'utf8' as const })
    const autoEdit = within(modeGroup(auto)).getByRole('button', { name: '编辑' }) as HTMLButtonElement
    expect(autoEdit.disabled).toBe(false)
    expect(autoEdit.title).toBe('')
  })

  it('shows the saved-version notice only while a dirty document is in Preview mode', () => {
    const dirty = seat({ isDirty: path => path === 'notes.md' })
    const view = render(<ModeHost {...previewProps({ tabs: [markdownTab], activeTabId: 'file:notes.md', editor: dirty })} />)
    expect(view.getByText('预览显示的是已保存的版本，有尚未保存的修改')).toBeTruthy()
    fireEvent.click(within(modeGroup(view)).getByRole('button', { name: '编辑' }))
    expect(view.queryByText('预览显示的是已保存的版本，有尚未保存的修改')).toBeNull()
    view.unmount()

    const clean = mount(markdownTab)
    expect(clean.queryByText('预览显示的是已保存的版本，有尚未保存的修改')).toBeNull()
  })
})

describe('workbench-level hole occupancy', () => {
  it('keeps the read-only markdown renderer and skips the hole render while unoccupied', async () => {
    const store = createWorkspaceWorkbenchStoreLike()
    const calls: string[] = []
    const view = render(
      <WorkspaceWorkbench
        {...workbenchStubs()}
        useStore={bindSnapshotSelectorLike(store)}
        actions={store.actions as never}
        drawer
        section="files"
        select={() => {}}
        request={undefined}
        renderSlot={((key: string) => {
          calls.push(key)
          return undefined
        }) as never}
        t={t}
        useCanOpenPath={useFalseSelector}
        usePreviewDocumentOccupied={useFalseOccupancy}
      />,
    )
    await waitFor(() => {
      expect(view.container.querySelectorAll('article').length).toBeGreaterThan(0)
    })
    expect(calls).not.toContain('workbench.preview.document')
    view.unmount()
  })
})

/** The owner handle a mounted occupant receives; `onSaved` is the optional post-save callback. */
type Owner = PreviewDocumentOwnerProps

type WorkbenchStore = ReturnType<ReturnType<typeof createWorkspaceWorkbenchStore>['create']>

const readResult = (path: string, content: string) => ({
  path, content, bytes: content.length, truncated: false, encoding: 'utf-8', encodingSource: 'utf8' as const, bom: false, eol: 'LF' as const,
})

/** Both preview placements over one reactive store account, so the shared mode and dirty facts are observable. */
function mountPlacements(options: {
  drawer: boolean
  store?: WorkbenchStore
  readFile?: (workspaceId: unknown, path: string, opts?: unknown, signal?: AbortSignal) => Promise<ReturnType<typeof readResult>>
  slot?: (owner: Owner) => React.ReactNode
}) {
  const store = options.store ?? createWorkspaceWorkbenchStoreLike()
  const owners: Owner[] = []
  const stubs = workbenchStubs()
  const defaultRead = async (_workspaceId: unknown, path: string) => readResult(path, '# Title\n\nBody.\n')
  const readFile = (options.readFile ?? defaultRead) as never
  const slot = ((key: string, owner: Owner) => {
    if (key !== 'workbench.preview.document' && key !== 'shell.overlay.preview.document') return null
    owners.push(owner)
    return options.slot?.(owner) ?? <div data-editor-occupant={owner.path} data-workspace-editor tabIndex={-1}>editor</div>
  }) as never
  const occupied = (<S,>(selector: (occupied: boolean) => S) => selector(true)) as never
  const element = (drawer: boolean) => (
    <>
      <WorkspaceWorkbench
        {...stubs}
        readFile={readFile}
        useStore={bindSnapshotSelector(store)}
        actions={store.actions}
        drawer={drawer}
        section="files"
        select={() => {}}
        request={undefined}
        renderSlot={slot}
        t={t}
        useCanOpenPath={useFalseSelector}
        usePreviewDocumentOccupied={occupied}
      />
      <WorkspaceWorkbenchPreviewOverlay
        useSessions={stubs.useSessions}
        useWorkspaces={stubs.useWorkspaces}
        useStore={bindSnapshotSelector(store)}
        actions={store.actions}
        rightMode="workbench"
        rightOpen
        rightDrawer={drawer}
        renderSlot={slot}
        t={t}
        useCanOpenPath={useFalseSelector}
        useOverlayDocumentOccupied={occupied}
        openPath={stubs.openPath}
        readFile={readFile}
      />
    </>
  )
  const view = render(element(options.drawer))
  return {
    view,
    store,
    owners,
    readFile,
    region: () => view.getByRole('region', { name: '工作区文件预览' }),
    setDrawer: (next: boolean) => { view.rerender(element(next)) },
    tab: (id: string) => store.getSnapshot().byWorkspace['ws-a']?.tabs.find(tab => tab.id === id),
  }
}

describe.each([
  { placement: 'in-column drawer', drawer: true },
  { placement: 'overlay', drawer: false },
])('Preview / Edit mode through the workbench ($placement)', ({ drawer }) => {
  it('opens on the rendered markdown and mounts the occupant only after Edit, then returns to the rendered text', async () => {
    const harness = mountPlacements({ drawer })
    const region = await waitFor(() => harness.region())
    expect(region.querySelector('article h1')?.textContent).toBe('Title')
    expect(harness.owners).toHaveLength(0)

    fireEvent.click(within(region).getByRole('button', { name: '编辑' }))
    expect(harness.store.getSnapshot().byWorkspace['ws-a']?.previewMode).toEqual({ 'file:README.md': 'edit' })
    expect(region.querySelector('[data-editor-occupant="README.md"]')).toBeTruthy()
    expect(region.querySelector('article')).toBeNull()

    fireEvent.click(within(region).getByRole('button', { name: '预览' }))
    expect(region.querySelector('[data-editor-occupant]')).toBeNull()
    expect(region.querySelector('article h1')?.textContent).toBe('Title')
  })

  it('keeps the mode per tab across tab switches and across a placement switch', async () => {
    const store = createWorkspaceWorkbenchStoreLike()
    store.actions.openTab('ws-a', {
      id: 'file:NOTES.md', path: 'NOTES.md', title: 'NOTES.md', kind: 'markdown', loading: false,
      content: '# Second\n', encoding: 'utf-8', encodingSource: 'utf8', bom: false, eol: 'LF',
    })
    const harness = mountPlacements({ drawer, store })
    const region = await waitFor(() => harness.region())
    expect(region.querySelector('article h1')?.textContent).toBe('Second')

    fireEvent.click(within(region).getByRole('button', { name: '编辑' }))
    expect(region.querySelector('[data-editor-occupant="NOTES.md"]')).toBeTruthy()

    fireEvent.click(within(region).getByRole('tab', { name: 'README.md' }))
    expect(region.querySelector('article h1')?.textContent).toBe('Title')
    expect(region.querySelector('[data-editor-occupant]')).toBeNull()

    fireEvent.click(within(region).getByRole('tab', { name: 'NOTES.md' }))
    expect(region.querySelector('[data-editor-occupant="NOTES.md"]')).toBeTruthy()

    harness.setDrawer(!drawer)
    const moved = harness.region()
    expect(moved.querySelector('[data-editor-occupant="NOTES.md"]')).toBeTruthy()
    fireEvent.click(within(moved).getByRole('tab', { name: 'README.md' }))
    expect(moved.querySelector('article h1')?.textContent).toBe('Title')
  })

  it('refreshes the previewed text silently after the occupant reports a save', async () => {
    let disk = '# Title\n\nBody.\n'
    const readFile = vi.fn(async (_workspaceId: unknown, path: string) => readResult(path, disk))
    const harness = mountPlacements({ drawer, readFile })
    const region = await waitFor(() => harness.region())
    fireEvent.click(within(region).getByRole('button', { name: '编辑' }))
    const states: boolean[] = []
    harness.store.subscribe(() => { states.push(harness.tab('file:README.md')?.loading === true) })

    disk = '# Saved heading\n'
    act(() => { harness.owners.at(-1)?.onSaved?.() })
    await waitFor(() => { expect(harness.tab('file:README.md')?.content).toBe('# Saved heading\n') })
    expect(readFile.mock.calls.at(-1)?.slice(0, 2)).toEqual([expect.anything(), 'README.md'])
    // No loading flash, and the editor stays mounted through the refresh.
    expect(states.length).toBeGreaterThan(0)
    expect(states.every(loading => !loading)).toBe(true)
    expect(region.querySelector('[data-editor-occupant="README.md"]')).toBeTruthy()

    fireEvent.click(within(region).getByRole('button', { name: '预览' }))
    expect(region.querySelector('article h1')?.textContent).toBe('Saved heading')
  })

  it('keeps a code document\'s language through the post-save refresh', async () => {
    const store = createWorkspaceWorkbenchStoreLike()
    store.actions.openTab('ws-a', {
      id: 'file:src/main.ts', path: 'src/main.ts', title: 'main.ts', kind: 'code', language: 'typescript', loading: false,
      content: 'export {}\n', encoding: 'utf-8', encodingSource: 'utf8', bom: false, eol: 'LF',
    })
    const readFile = vi.fn(async (_workspaceId: unknown, path: string) => readResult(path, 'export const saved = 1\n'))
    const harness = mountPlacements({ drawer, store, readFile })
    const region = await waitFor(() => harness.region())
    fireEvent.click(within(region).getByRole('button', { name: '编辑' }))
    act(() => { harness.owners.at(-1)?.onSaved?.() })
    await waitFor(() => { expect(harness.tab('file:src/main.ts')).toMatchObject({ content: 'export const saved = 1\n', language: 'typescript', kind: 'code' }) })
    fireEvent.click(within(region).getByRole('button', { name: '预览' }))
    expect(region.textContent).toContain('export const saved = 1')
  })

  it('keeps the previous preview text and warns when the post-save re-read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failing = false
    const readFile = vi.fn(async (_workspaceId: unknown, path: string) => {
      if (failing) throw new Error('disk gone')
      return readResult(path, '# Title\n\nBody.\n')
    })
    const harness = mountPlacements({ drawer, readFile })
    const region = await waitFor(() => harness.region())
    fireEvent.click(within(region).getByRole('button', { name: '编辑' }))
    failing = true
    act(() => { harness.owners.at(-1)?.onSaved?.() })
    await waitFor(() => { expect(warn).toHaveBeenCalledWith('refresh after save failed:', expect.anything()) })
    expect(harness.tab('file:README.md')?.content).toBe('# Title\n\nBody.\n')
    expect(harness.tab('file:README.md')?.error).toBeUndefined()
  })

  it('lets the user leave a Host-refused editor through Preview and read the file again', async () => {
    const harness = mountPlacements({
      drawer,
      slot: () => <div role="note" data-workspace-editor>此文件不可编辑：mixed line endings</div>,
    })
    const region = await waitFor(() => harness.region())
    fireEvent.click(within(region).getByRole('button', { name: '编辑' }))
    expect(within(region).getByText('此文件不可编辑：mixed line endings')).toBeTruthy()
    expect(region.querySelector('article')).toBeNull()

    fireEvent.click(within(region).getByRole('button', { name: '预览' }))
    expect(within(region).queryByText('此文件不可编辑：mixed line endings')).toBeNull()
    expect(region.querySelector('article h1')?.textContent).toBe('Title')
  })

  it('returns an Edit-mode document to Preview when it is reopened with an explicit encoding', async () => {
    const readFile = vi.fn(async (_workspaceId: unknown, path: string, opts?: unknown) => ({
      ...readResult(path, '# Decoded\n'),
      ...((opts as { encoding?: string } | undefined)?.encoding === undefined
        ? {}
        : { encoding: 'gb18030', encodingSource: 'explicit' as never }),
    }))
    const harness = mountPlacements({ drawer, readFile })
    const region = await waitFor(() => harness.region())
    fireEvent.click(within(region).getByRole('button', { name: '编辑' }))
    expect(region.querySelector('[data-editor-occupant]')).toBeTruthy()

    fireEvent.change(within(region).getByRole('combobox', { name: '以指定编码重新打开' }), { target: { value: 'gb18030' } })
    await waitFor(() => { expect(region.querySelector('article h1')?.textContent).toBe('Decoded') })
    expect(region.querySelector('[data-editor-occupant]')).toBeNull()
    const edit = within(region).getByRole('button', { name: '编辑' }) as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    expect(edit.title).toBe('此文件以指定编码打开，编辑需要自动检测通过往返校验的编码')
  })
})

function useFalseOccupancy<S>(selector: (occupied: boolean) => S, eq?: (a: S, b: S) => boolean): S {
  void eq
  return selector(false)
}

function useFalseSelector<S>(selector: (capable: boolean) => S, eq?: (a: S, b: S) => boolean): S {
  void eq
  return selector(false)
}

function createWorkspaceWorkbenchStoreLike() {
  const store = createWorkspaceWorkbenchStore().create()
  store.actions.openTab('ws-a', {
    id: 'file:README.md', path: 'README.md', title: 'README.md', kind: 'markdown', loading: false,
    content: '# Title\n\nBody.\n', encoding: 'utf-8', encodingSource: 'utf8', bom: false, eol: 'LF',
  })
  return store
}

function bindSnapshotSelectorLike(store: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }) {
  return (<S,>(selector: (state: never) => S) => selector(store.getSnapshot() as never)) as never
}

function workbenchStubs() {
  return {
    useSessions: ((<S,>(selector: (state: never) => S) => selector({
      current: 's-a',
      byId: { 's-a': { id: 's-a', cwd: '/projects/a' } },
      ids: ['s-a'],
    } as never))) as never,
    useWorkspaces: ((<S,>(selector: (state: never) => S) => selector({
      items: [{ workspaceId: 'ws-a', path: '/projects/a', sessionIds: ['s-a'] }],
      baselinesReady: true,
    } as never))) as never,
    openWorkbench: () => {},
    closeWorkbench: () => {},
    listFiles: () => Promise.resolve({ path: '', entries: [], truncated: false }),
    searchFiles: () => Promise.resolve({ entries: [], truncated: false }),
    readFile: () => Promise.resolve({ path: '', content: '', bytes: 0, truncated: false, encoding: 'utf-8', encodingSource: 'utf8' as const, bom: false, eol: 'LF' as const }),
    readBinaryFile: () => Promise.resolve({ path: '', dataBase64: '', mediaType: 'image/png', bytes: 0 }),
    gitStatus: () => Promise.resolve({ branch: null, entries: [], truncated: false }),
    gitCommits: () => Promise.resolve({ commits: [], truncated: false }),
    gitDiff: () => Promise.resolve({ diff: '', truncated: false }),
    openPath: () => Promise.resolve(),
  }
}
