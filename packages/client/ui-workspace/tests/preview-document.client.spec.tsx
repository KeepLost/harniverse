// @vitest-environment jsdom
/**
 * Preview-document occupancy specs: the preview renders an editor seat for
 * editable families (and keeps its read-only render for everything else),
 * defers window-capture Escape while focus is inside the occupant, and the
 * occupant's dirty fact gates closing through the owner's confirmation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { WorkbenchPreview } from '../src/client/WorkbenchPreview.tsx'
import type { EditorSeat } from '../src/client/WorkbenchPreview.tsx'
import { WorkspaceWorkbench } from '../src/client/WorkspaceWorkbench.tsx'
import type { WorkspaceWorkbenchProps } from '../src/client/contract/slots.ts'
import { createWorkspaceWorkbenchStore } from '../src/client/stores.ts'
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
    onDirtyChange: vi.fn(),
    onRequestClose: vi.fn(),
    ...overrides,
  }
}

describe('preview-document occupancy', () => {
  it('renders the occupant for an editable family and keeps the read-only renderer without a seat', () => {
    const withSeat = render(<WorkbenchPreview {...previewProps({ editor: seat() })} />)
    expect(withSeat.container.querySelector('[data-editor-occupant="src/main.ts"]')).toBeTruthy()
    withSeat.unmount()

    const withoutSeat = render(<WorkbenchPreview {...previewProps()} />)
    expect(withoutSeat.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(withoutSeat.container.textContent).toContain('export {}')
    withoutSeat.unmount()
  })

  it('keeps non-editable and truncated families on their read-only renderer', () => {
    const imageSeat = render(<WorkbenchPreview {...previewProps({ tabs: [imageTab], activeTabId: 'file:logo.png', editor: seat() })} />)
    expect(imageSeat.container.querySelector('[data-editor-occupant]')).toBeNull()
    imageSeat.unmount()

    const truncated = { ...codeTab, truncated: true }
    const truncatedSeat = render(<WorkbenchPreview {...previewProps({ tabs: [truncated], editor: seat() })} />)
    expect(truncatedSeat.container.querySelector('[data-editor-occupant]')).toBeNull()
    expect(truncatedSeat.getByText('文件超过文本预览上限，当前内容已截断')).toBeTruthy()
  })

  it('lets the occupant keep Escape and forwards owner facts', () => {
    const onDismiss = vi.fn()
    const editor = seat()
    const view = render(<WorkbenchPreview {...previewProps({ onDismiss, editor })} />)
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

  it('passes the explicit-encoding fallback to the occupant and hides it otherwise', () => {
    const explicit = { ...codeTab, encoding: 'gb18030', encodingSource: 'explicit' as const }
    const editor = seat()
    const view = render(<WorkbenchPreview {...previewProps({ tabs: [explicit], editor })} />)
    expect(view.container.querySelector('[data-editor-occupant="src/main.ts"]')).toBeTruthy()
    view.unmount()
    const auto = { ...codeTab, encoding: 'utf-8', encodingSource: 'utf8' as const }
    const autoView = render(<WorkbenchPreview {...previewProps({ tabs: [auto], editor: seat() })} />)
    expect(autoView.container.querySelector('[data-editor-occupant]')).toBeTruthy()
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
