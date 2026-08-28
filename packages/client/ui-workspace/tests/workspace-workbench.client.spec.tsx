// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type {
  SessionId, SessionListState, WorkspaceFileEntry, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  ChangesPanel, CsvTable, DiffPreview, DirectoryChildren, FilePreview, SearchPanel, TabStrip,
  WorkspaceWorkbench, parseCsvPreview, previewType,
} from '../src/client/WorkspaceWorkbench.tsx'
import { WorkspaceWorkbenchButton } from '../src/client/WorkspaceWorkbenchButton.tsx'
import type { WorkspaceWorkbenchProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'
import { createWorkspaceWorkbenchStore } from '../src/client/stores.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const t: WorkspaceWorkbenchProps['t'] = makeTranslate(zh, commonZh)
const sid = (value: string) => value as SessionId
const wid = (value: string) => value as WorkspaceId

function workspace(id: string, sessionId: string): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title: id.toUpperCase(), sessionIds: [sid(sessionId)],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

type Services = Pick<WorkspaceWorkbenchProps,
  | 'listFiles' | 'searchFiles' | 'readFile' | 'readBinaryFile'
  | 'gitStatus' | 'gitCommits' | 'gitDiff' | 'openWorkbench' | 'closeWorkbench'>

function mountWorkbench(
  overrides: Partial<Services> = {},
  options: { current?: SessionId | undefined; workspaces?: WorkspaceView[]; baselinesReady?: boolean } = {},
) {
  let current = 'current' in options ? options.current : sid('s-a')
  const workspaces = options.workspaces ?? [workspace('a', 's-a'), workspace('b', 's-b')]
  const instance = createWorkspaceWorkbenchStore().create()
  const services: Services = {
    listFiles: vi.fn(async (_workspaceId: WorkspaceId, path?: string, _signal?: AbortSignal) => ({ path: path ?? '', entries: [], truncated: false })),
    searchFiles: vi.fn(async (_workspaceId: WorkspaceId, _query: string, _signal?: AbortSignal) => ({ entries: [], truncated: false })),
    readFile: vi.fn(async (_workspaceId: WorkspaceId, path: string, _signal?: AbortSignal) => ({ path, content: '', bytes: 0, truncated: false })),
    readBinaryFile: vi.fn(async (_workspaceId: WorkspaceId, path: string, _signal?: AbortSignal) => ({ path, dataBase64: '', mediaType: 'image/png', bytes: 0 })),
    gitStatus: vi.fn(async (_workspaceId: WorkspaceId, _signal?: AbortSignal) => ({ branch: null, entries: [], truncated: false })),
    gitCommits: vi.fn(async (_workspaceId: WorkspaceId, _limit?: number, _signal?: AbortSignal) => ({ commits: [], truncated: false })),
    gitDiff: vi.fn(async (_workspaceId: WorkspaceId, _path?: string, _staged?: boolean, _signal?: AbortSignal) => ({ diff: '', truncated: false })),
    openWorkbench: vi.fn(),
    closeWorkbench: vi.fn(),
    ...overrides,
  }
  const workspaceState = (): WorkspaceListState => ({
    items: workspaces, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: options.baselinesReady ?? true, recentWorkspaceId: workspaces[0]?.workspaceId,
  })
  const sessionState = (): SessionListState => ({
    ids: [sid('s-a'), sid('s-b')],
    byId: {
      [sid('s-a')]: { id: sid('s-a'), displayTitle: 'A', cwd: '/projects/a', running: false, blank: false, updatedAt: 1 },
      [sid('s-b')]: { id: sid('s-b'), displayTitle: 'B', cwd: '/projects/b', running: false, blank: false, updatedAt: 1 },
    },
    current, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const element = () => (
    <WorkspaceWorkbench
      useSessions={selector => selector(sessionState())}
      useWorkspaces={selector => selector(workspaceState())}
      useStore={bindSnapshotSelector(instance)}
      actions={instance.actions}
      t={t}
      {...services}
    />
  )
  const view = render(element())
  return {
    ...view,
    instance,
    services,
    switchSession(next: string) { current = sid(next); view.rerender(element()) },
  }
}

describe('workbench presentation units', () => {
  it('opens the workbench from the localized Session-header utility', () => {
    const openWorkbench = vi.fn()
    const props = { openWorkbench, t } as unknown as Parameters<typeof WorkspaceWorkbenchButton>[0]
    render(<WorkspaceWorkbenchButton {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '打开工作区工作台' }))
    expect(openWorkbench).toHaveBeenCalledOnce()
  })

  it('renders directory loading, errors, nested empty folders, unsupported entries, and truncation', () => {
    const onToggle = vi.fn()
    const onOpen = vi.fn()
    const base = {
      path: '', depth: 0, activePath: 'NOTICE', t, onToggle, onOpen,
      expanded: { src: true },
    }
    const view = render(<DirectoryChildren {...base} directories={{ '': { entries: [], truncated: false, loading: true } }} />)
    expect(view.getByText('正在读取目录…')).toBeTruthy()
    view.rerender(<DirectoryChildren {...base} directories={{ '': { entries: [], truncated: false, loading: false, error: 'directory failed' } }} />)
    expect(view.getByText('directory failed')).toBeTruthy()
    view.rerender(<DirectoryChildren {...base} directories={{
      '': {
        entries: [
          { name: 'src', path: 'src', kind: 'directory' },
          { name: 'linked', path: 'linked', kind: 'symlink' },
          { name: 'NOTICE', path: 'NOTICE', kind: 'file' },
        ],
        truncated: true,
        loading: false,
      },
      src: { entries: [], truncated: false, loading: false },
    }} />)
    expect(view.getByText('此目录为空')).toBeTruthy()
    expect(view.getByText('目录内容已达到显示上限')).toBeTruthy()
    expect(view.getByTitle('符号链接和特殊文件不可预览')).toBeTruthy()
    const directory = view.getByRole('button', { name: /src/ })
    const activeFile = view.getByRole('button', { name: /NOTICE/ })
    expect(directory.getAttribute('aria-expanded')).toBe('true')
    expect(activeFile.getAttribute('aria-current')).toBe('page')
    fireEvent.click(directory)
    fireEvent.click(activeFile)
    expect(onToggle).toHaveBeenCalledWith('src')
    expect(onOpen).toHaveBeenCalledWith({ name: 'NOTICE', path: 'NOTICE', kind: 'file' })
  })

  it('renders and drives search result, empty, error, loading, and truncation states', () => {
    const onQuery = vi.fn()
    const onOpen = vi.fn()
    const view = render(<SearchPanel query="x" entries={[]} loading truncated={false} t={t} onQuery={onQuery} onOpen={onOpen} />)
    expect(view.getByText('正在搜索…')).toBeTruthy()
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'next' } })
    expect(onQuery).toHaveBeenCalledWith('next')
    view.rerender(<SearchPanel query="x" entries={[]} loading={false} truncated={false} t={t} onQuery={onQuery} onOpen={onOpen} />)
    expect(view.getByText('没有匹配文件')).toBeTruthy()
    const entry: WorkspaceFileEntry = { name: 'x.ts', path: 'src/x.ts', kind: 'file' }
    view.rerender(<SearchPanel query="x" entries={[entry]} loading={false} truncated error="search failed" t={t} onQuery={onQuery} onOpen={onOpen} />)
    expect(view.getByText('search failed')).toBeTruthy()
    expect(view.getByText(/仅显示前 200/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /src\/x\.ts/ }))
    expect(onOpen).toHaveBeenCalledWith(entry)
  })

  it('renders and drives worktree, staged, untracked, empty, error, and truncated Git states', () => {
    const onArea = vi.fn()
    const onRefresh = vi.fn()
    const onOpenDiff = vi.fn()
    const onOpenFile = vi.fn()
    const common = { commits: [], loading: false, truncated: false, t, onArea, onRefresh, onOpenDiff, onOpenFile }
    const modified = { path: 'tracked.ts', indexStatus: 'M', worktreeStatus: 'M' }
    const untracked = { path: 'new.ts', indexStatus: '?', worktreeStatus: '?' }
    const view = render(<ChangesPanel {...common} area="worktree" branch={null} statusEntries={[modified, untracked]} />)
    expect(view.getByText('Git 变更')).toBeTruthy()
    expect(view.getByRole('button', { name: '工作区' }).getAttribute('aria-pressed')).toBe('true')
    expect(view.getByRole('button', { name: '暂存区' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(view.getByRole('button', { name: '工作区' }))
    fireEvent.click(view.getByRole('button', { name: '暂存区' }))
    fireEvent.click(view.getByRole('button', { name: '刷新 Git 变更' }))
    fireEvent.click(view.getByRole('button', { name: /tracked\.ts/ }))
    fireEvent.click(view.getByRole('button', { name: /new\.ts/ }))
    expect(onArea.mock.calls).toEqual([['worktree'], ['staged']])
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onOpenDiff).toHaveBeenCalledWith(modified)
    expect(onOpenFile).toHaveBeenCalledWith({ name: 'new.ts', path: 'new.ts', kind: 'file' })

    view.rerender(<ChangesPanel {...common} area="staged" branch="dev" statusEntries={[modified]} error="git failed" truncated />)
    expect(view.getByText('分支 dev')).toBeTruthy()
    expect(view.getByText('git failed')).toBeTruthy()
    expect(view.getByText('Git 结果已达到显示上限')).toBeTruthy()
    view.rerender(<ChangesPanel {...common} area="worktree" branch={null} statusEntries={[]} />)
    expect(view.getByText('没有变更')).toBeTruthy()
  })

  it('renders bounded CSV and all unified-diff line roles', () => {
    const csv = render(<CsvTable content={'a,b\n1,2'} t={t} />)
    expect(csv.getByRole('table')).toBeTruthy()
    expect(csv.getByText('1')).toBeTruthy()
    csv.rerender(<CsvTable content="" t={t} />)
    expect(csv.getByText('CSV 文件为空')).toBeTruthy()
    csv.rerender(<CsvTable content={Array.from({ length: 101 }, (_, index) => String(index)).join('\n')} t={t} />)
    expect(csv.getByText(/前 100 行/)).toBeTruthy()
    csv.unmount()

    const diff = render(<DiffPreview content={'--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same'} />)
    expect(diff.container.querySelector('[data-kind="header"]')).toBeTruthy()
    expect(diff.container.querySelector('[data-kind="range"]')).toBeTruthy()
    expect(diff.container.querySelector('[data-kind="delete"]')).toBeTruthy()
    expect(diff.container.querySelector('[data-kind="add"]')).toBeTruthy()
  })

  it('drives tab selection and restores focus after closing while showing loading state', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const tabs = [
      { id: 'a', path: 'a', title: 'A', kind: 'text' as const, loading: true },
      { id: 'b', path: 'b', title: 'B', kind: 'text' as const, loading: false },
    ]
    const view = render(<TabStrip tabs={tabs} activeTabId="a" t={t} onSelect={onSelect} onClose={onClose} />)
    expect(screen.getByLabelText('读取中')).toBeTruthy()
    const firstTab = screen.getByRole('tab', { name: /A/ })
    const secondTab = screen.getByRole('tab', { name: 'B' })
    expect(firstTab.getAttribute('aria-controls')).toBe('workspace-workbench-panel')
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(secondTab)
    fireEvent.keyDown(secondTab, { key: 'ArrowLeft' })
    fireEvent.keyDown(firstTab, { key: 'End' })
    fireEvent.keyDown(secondTab, { key: 'Home' })
    fireEvent.keyDown(firstTab, { key: 'Escape' })
    fireEvent.click(secondTab)
    const close = screen.getByRole('button', { name: '关闭 A' })
    close.focus()
    fireEvent.click(close)
    view.rerender(<TabStrip tabs={[tabs[1]!]} activeTabId="b" t={t} onSelect={onSelect} onClose={onClose} />)
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'B' })) })
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(onClose).toHaveBeenCalledWith('a')

    const finalClose = screen.getByRole('button', { name: '关闭 B' })
    finalClose.focus()
    fireEvent.click(finalClose)
    view.rerender(<TabStrip tabs={[]} activeTabId={null} t={t} onSelect={onSelect} onClose={onClose} />)
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('tablist')) })
    expect(onClose).toHaveBeenCalledWith('b')
  })

  it('dispatches every preview renderer and its loading, error, unavailable, and notice chrome', async () => {
    let objectId = 0
    const createObjectURL = vi.fn(() => `blob:${String(++objectId)}`)
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const onBack = vi.fn()
    const view = render(<FilePreview tab={undefined} t={t} onBack={onBack} />)
    expect(view.getByText('打开文件开始预览')).toBeTruthy()

    const tab = (kind: NonNullable<Parameters<typeof FilePreview>[0]['tab']>['kind'], content?: string) => ({
      id: kind, path: `${kind}.file`, title: kind, kind, loading: false, ...(content === undefined ? {} : { content }),
    })
    view.rerender(<FilePreview tab={{ ...tab('text'), loading: true }} t={t} onBack={onBack} />)
    expect(view.getByText(/正在读取 text/)).toBeTruthy()
    view.rerender(<FilePreview tab={{ ...tab('text'), error: 'read failed' }} t={t} onBack={onBack} />)
    expect(view.getByText('read failed')).toBeTruthy()
    view.rerender(<FilePreview tab={tab('text')} t={t} onBack={onBack} />)
    expect(view.getByText('无法生成此文件的预览')).toBeTruthy()

    view.rerender(<FilePreview tab={tab('html', '<h1>HTML</h1>')} t={t} onBack={onBack} />)
    expect(view.getByTitle('html').getAttribute('sandbox')).toBe('')
    view.rerender(<FilePreview tab={{ ...tab('code', 'const x = 1'), language: 'typescript' }} t={t} onBack={onBack} />)
    expect(view.container.querySelector('pre')?.textContent).toBe('const x = 1')
    view.rerender(<FilePreview tab={{ ...tab('text', 'plain'), bytes: 5, truncated: true }} t={t} onBack={onBack} />)
    expect(view.getByText('plain')).toBeTruthy()
    expect(view.getByText('5 B')).toBeTruthy()
    expect(view.getByText(/文本预览上限/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '返回文件导航' }))
    expect(onBack).toHaveBeenCalledOnce()
    view.rerender(<FilePreview tab={tab('csv', 'a,b\n1,2')} t={t} onBack={onBack} />)
    expect(view.getByRole('table')).toBeTruthy()
    view.rerender(<FilePreview tab={tab('diff', '@@ -1 +1 @@\n-old\n+new')} t={t} onBack={onBack} />)
    expect(view.getByText('+new')).toBeTruthy()
    view.rerender(<FilePreview tab={tab('markdown', '# Markdown')} t={t} onBack={onBack} />)
    expect(view.getByRole('heading', { name: 'Markdown' })).toBeTruthy()

    view.rerender(<FilePreview tab={{ ...tab('image'), dataBase64: 'AA==', mediaType: 'image/png' }} t={t} onBack={onBack} />)
    await waitFor(() => { expect(view.getByRole('img').getAttribute('src')).toBe('blob:1') })
    view.rerender(<FilePreview tab={{ ...tab('pdf'), dataBase64: 'AA==', mediaType: 'application/pdf' }} t={t} onBack={onBack} />)
    await waitFor(() => { expect(view.getByTitle('pdf').getAttribute('src')).toBe('blob:2') })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:1')
  })
})

describe('workspace preview helpers', () => {
  it('classifies every shipped preview family', () => {
    expect(previewType('README.md')).toEqual({ kind: 'markdown' })
    expect(previewType('page.html')).toEqual({ kind: 'html' })
    expect(previewType('data.csv')).toEqual({ kind: 'csv' })
    expect(previewType('source.tsx')).toEqual({ kind: 'code', language: 'tsx' })
    expect(previewType('pixel.png')).toEqual({ kind: 'image' })
    expect(previewType('manual.pdf')).toEqual({ kind: 'pdf' })
    expect(previewType('NOTICE')).toEqual({ kind: 'text' })
  })

  it('parses quoted CSV cells and reports row or column clipping', () => {
    expect(parseCsvPreview('name,note\nalpha,"one, two"\nbeta,"a ""quote"""')).toEqual({
      rows: [['name', 'note'], ['alpha', 'one, two'], ['beta', 'a "quote"']],
      truncated: false,
    })
    expect(parseCsvPreview('a,b,c\n1,2,3\n4,5,6', 2, 2)).toEqual({
      rows: [['a', 'b'], ['1', '2']],
      truncated: true,
    })
    expect(parseCsvPreview('a\nb\n', 2)).toEqual({ rows: [['a'], ['b']], truncated: false })
    expect(parseCsvPreview('a,')).toEqual({ rows: [['a', '']], truncated: false })
    expect(parseCsvPreview('a\r\nb')).toEqual({ rows: [['a'], ['b']], truncated: false })
  })
})

describe('WorkspaceWorkbench', () => {
  it('renders the no-Workspace state, closes from it, and does not inspect an unrelated recent Workspace', async () => {
    const empty = mountWorkbench({}, { workspaces: [] })
    expect(empty.getByText('当前会话没有关联工作区')).toBeTruthy()
    fireEvent.click(empty.getByRole('button', { name: '关闭工作区工作台' }))
    expect(empty.services.closeWorkbench).toHaveBeenCalledOnce()
    empty.unmount()

    const listFiles = vi.fn(async () => ({ path: '', entries: [], truncated: false }))
    mountWorkbench({ listFiles }, { current: undefined, workspaces: [workspace('recent', 'none')], baselinesReady: false })
    await act(async () => { await Promise.resolve() })
    expect(listFiles).not.toHaveBeenCalled()
    expect(screen.getByText('当前会话没有关联工作区')).toBeTruthy()
  })

  it('prefers explicit Session membership over an earlier cwd match', async () => {
    const cwdMatch = { ...workspace('cwd-match', 'none'), path: '/projects/a' }
    const member = workspace('member', 's-a')
    const listFiles = vi.fn(async () => ({ path: '', entries: [], truncated: false }))

    mountWorkbench({ listFiles }, { workspaces: [cwdMatch, member] })

    await waitFor(() => { expect(listFiles).toHaveBeenCalledWith(wid('member'), undefined, expect.any(AbortSignal)) })
    expect(screen.getByText('MEMBER')).toBeTruthy()
  })

  it('uses cwd matching while explicit Session accounting is absent', async () => {
    const cwdMatch = { ...workspace('cwd-match', 'none'), path: '/projects/a' }
    const listFiles = vi.fn(async () => ({ path: '', entries: [], truncated: false }))

    mountWorkbench({ listFiles }, { workspaces: [cwdMatch] })

    await waitFor(() => { expect(listFiles).toHaveBeenCalledWith(wid('cwd-match'), undefined, expect.any(AbortSignal)) })
    expect(screen.getByText('CWD-MATCH')).toBeTruthy()
  })

  it('surfaces directory, text, binary, search, Git, and diff request failures and retries failed tabs', async () => {
    const text: WorkspaceFileEntry = { name: 'bad.txt', path: 'bad.txt', kind: 'file' }
    const image: WorkspaceFileEntry = { name: 'bad.png', path: 'bad.png', kind: 'file' }
    const listFiles = vi.fn()
      .mockRejectedValueOnce('root failed')
      .mockResolvedValue({ path: '', entries: [text, image], truncated: false })
    const readFile = vi.fn().mockRejectedValueOnce(new Error('text failed')).mockResolvedValue({
      path: 'bad.txt', content: 'recovered', bytes: 9, truncated: false,
    })
    const readBinaryFile = vi.fn().mockRejectedValue(new Error('binary failed'))
    const searchFiles = vi.fn().mockRejectedValue('search failed')
    const gitStatus = vi.fn().mockRejectedValue(new Error('git failed'))
    const gitCommits = vi.fn(async () => ({ commits: [], truncated: false }))
    const gitDiff = vi.fn().mockRejectedValue(new Error('diff failed'))
    const view = mountWorkbench({ listFiles, readFile, readBinaryFile, searchFiles, gitStatus, gitCommits, gitDiff })

    expect(await view.findByText('root failed')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '刷新文件树' }))
    fireEvent.click(await view.findByRole('button', { name: /^TXTbad\.txt$/ }))
    expect(await view.findByText('text failed')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /^TXTbad\.txt$/ }))
    expect(await view.findByText('recovered')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /^PNGbad\.png$/ }))
    expect(await view.findByText('binary failed')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: '搜索' }))
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'bad' } })
    expect(await view.findByText('search failed')).toBeTruthy()
    searchFiles.mockImplementationOnce((
      _workspaceId: WorkspaceId, _query: string, signal?: AbortSignal,
    ) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('cancelled search')) }, { once: true })
    }))
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'cancel' } })
    await waitFor(() => { expect(searchFiles).toHaveBeenCalledTimes(2) })
    fireEvent.change(view.getByRole('searchbox'), { target: { value: '   ' } })
    await act(async () => { await Promise.resolve() })
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'brief' } })
    fireEvent.change(view.getByRole('searchbox'), { target: { value: '' } })

    fireEvent.click(view.getByRole('button', { name: '变更' }))
    expect(await view.findByText('git failed')).toBeTruthy()
    gitCommits.mockRejectedValueOnce(new Error('history failed'))
    gitStatus.mockResolvedValueOnce({
      branch: 'dev', entries: [{ path: 'bad.txt', indexStatus: ' ', worktreeStatus: 'M' }], truncated: false,
    })
    fireEvent.click(view.getByRole('button', { name: '刷新 Git 变更' }))
    expect(await view.findByText('history failed')).toBeTruthy()
    gitStatus.mockResolvedValueOnce({
      branch: 'dev', entries: [{ path: 'bad.txt', indexStatus: ' ', worktreeStatus: 'M' }], truncated: false,
    })
    fireEvent.click(view.getByRole('button', { name: '刷新 Git 变更' }))
    fireEvent.click(await view.findByRole('button', { name: /M.*bad\.txt/ }))
    expect(await view.findByText('diff failed')).toBeTruthy()
  })

  it('loads the root automatically and drives files, search, and Git diff previews', async () => {
    const readme: WorkspaceFileEntry = { name: 'README.md', path: 'README.md', kind: 'file' }
    const nested: WorkspaceFileEntry = { name: 'main.ts', path: 'src/main.ts', kind: 'file' }
    const listFiles = vi.fn(async (_workspaceId: WorkspaceId, path?: string) => ({
      path: path ?? '',
      entries: path === 'src'
        ? [nested]
        : [{ name: 'src', path: 'src', kind: 'directory' as const }, readme],
      truncated: path === undefined,
    }))
    const searchFiles = vi.fn(async () => ({ entries: [nested], truncated: true }))
    const readFile = vi.fn(async (_workspaceId: WorkspaceId, path: string) => ({
      path,
      content: path.endsWith('.md') ? '# Workbench title' : 'export const ready = true',
      bytes: 42,
      truncated: path.endsWith('.md'),
    }))
    const gitStatus = vi.fn(async () => ({
      branch: 'dev',
      entries: [
        { path: 'src/main.ts', indexStatus: 'M', worktreeStatus: 'M' },
        { path: 'new.ts', indexStatus: '?', worktreeStatus: '?' },
      ],
      truncated: true,
    }))
    const gitCommits = vi.fn(async () => ({
      commits: [{ hash: 'abcdef', shortHash: 'abcdef', authorName: 'A', authorEmail: 'a@example.invalid', authoredAt: '2026-08-28T00:00:00Z', subject: 'initial' }],
      truncated: false,
    }))
    const gitDiff = vi.fn(async (
      _workspaceId: WorkspaceId, _path?: string, _staged?: boolean, _signal?: AbortSignal,
    ) => ({ diff: '@@ -1 +1 @@\n-old\n+new\n', truncated: false }))
    const mounted = mountWorkbench({ listFiles, searchFiles, readFile, gitStatus, gitCommits, gitDiff })

    await waitFor(() => { expect(listFiles).toHaveBeenCalledWith(wid('a'), undefined, expect.any(AbortSignal)) })
    expect(screen.getByRole('button', { name: '文件' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /^MDREADME\.md$/ }))
    expect(await screen.findByRole('heading', { name: 'Workbench title' })).toBeTruthy()
    expect(readFile).toHaveBeenCalledWith(wid('a'), 'README.md', expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: /^MDREADME\.md$/ }))
    expect(readFile.mock.calls.filter(call => call[1] === 'README.md')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '刷新文件树' }))

    fireEvent.click(await screen.findByRole('button', { name: /src/ }))
    await waitFor(() => { expect(listFiles).toHaveBeenCalledWith(wid('a'), 'src', expect.any(AbortSignal)) })
    expect(screen.getByRole('button', { name: /main\.ts/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /src/ }))

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByRole('button', { name: '搜索' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索工作区文件' }), { target: { value: 'main' } })
    await waitFor(() => { expect(searchFiles).toHaveBeenCalledWith(wid('a'), 'main', expect.any(AbortSignal)) })
    fireEvent.click(await screen.findByRole('button', { name: /src\/main\.ts/ }))
    await waitFor(() => { expect(readFile).toHaveBeenCalledWith(wid('a'), 'src/main.ts', expect.any(AbortSignal)) })
    expect(mounted.container.querySelector('pre')?.textContent).toBe('export const ready = true')
    fireEvent.click(screen.getByRole('tab', { name: 'README.md' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭 main.ts' }))
    fireEvent.click(screen.getByRole('button', { name: '返回文件导航' }))

    fireEvent.click(screen.getByRole('button', { name: '变更' }))
    await waitFor(() => { expect(gitStatus).toHaveBeenCalledWith(wid('a'), expect.any(AbortSignal)) })
    fireEvent.click(await screen.findByRole('button', { name: /M.*src\/main\.ts/ }))
    await waitFor(() => { expect(gitDiff).toHaveBeenCalledWith(wid('a'), 'src/main.ts', false, expect.any(AbortSignal)) })
    expect(await screen.findByText('+new')).toBeTruthy()
    expect(screen.getByText('initial')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新 Git 变更' }))
    fireEvent.click(await screen.findByRole('button', { name: /\?.*new\.ts/ }))
    await waitFor(() => { expect(readFile).toHaveBeenCalledWith(wid('a'), 'new.ts', expect.any(AbortSignal)) })
    fireEvent.click(screen.getByRole('button', { name: '暂存区' }))
    fireEvent.click(await screen.findByRole('button', { name: /M.*src\/main\.ts/ }))
    await waitFor(() => { expect(gitDiff).toHaveBeenCalledWith(wid('a'), 'src/main.ts', true, expect.any(AbortSignal)) })
    fireEvent.click(screen.getByRole('button', { name: /M.*src\/main\.ts/ }))
    expect(gitDiff.mock.calls.filter(call => call[2] === true)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
  })

  it('creates and revokes object URLs for bounded binary previews', async () => {
    const createObjectURL = vi.fn(() => 'blob:pixel')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const pixel: WorkspaceFileEntry = { name: 'pixel.png', path: 'pixel.png', kind: 'file' }
    mountWorkbench({
      listFiles: vi.fn(async () => ({ path: '', entries: [pixel], truncated: false })),
      readBinaryFile: vi.fn(async (_workspaceId: WorkspaceId, path: string) => ({
        path, dataBase64: 'AAEC', mediaType: 'image/png', bytes: 3,
      })),
    })

    fireEvent.click(await screen.findByRole('button', { name: /pixel\.png/ }))
    const image = await screen.findByRole('img', { name: 'pixel.png' })
    expect(image.getAttribute('src')).toBe('blob:pixel')
    expect(createObjectURL).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: '关闭 pixel.png' }))
    await waitFor(() => { expect(revokeObjectURL).toHaveBeenCalledWith('blob:pixel') })
  })

  it('retains failed Git sibling requests under the Workspace cancellation fence', async () => {
    let historySignal: AbortSignal | undefined
    const gitStatus = vi.fn().mockRejectedValue(new Error('status failed'))
    const gitCommits = vi.fn((
      _workspaceId: WorkspaceId, _limit?: number, signal?: AbortSignal,
    ) => new Promise<{ commits: []; truncated: false }>((_resolve, reject) => {
      historySignal = signal
      signal?.addEventListener('abort', () => { reject(new Error('history cancelled')) }, { once: true })
    }))
    const view = mountWorkbench({ gitStatus, gitCommits })

    fireEvent.click(view.getByRole('button', { name: '变更' }))
    await waitFor(() => { expect(historySignal).toBeDefined() })
    expect(view.queryByText('status failed')).toBeNull()

    act(() => { view.switchSession('s-b') })
    expect(historySignal?.aborted).toBe(true)
    await act(async () => { await Promise.resolve() })
    expect(view.queryByText('status failed')).toBeNull()
  })

  it('aborts the prior Workspace generation and reloads interrupted directories on return', async () => {
    let firstSignal: AbortSignal | undefined
    let resolveFirst: ((value: { path: string; entries: WorkspaceFileEntry[]; truncated: boolean }) => void) | undefined
    let aCalls = 0
    const listFiles = vi.fn((workspaceId: WorkspaceId, _path?: string, signal?: AbortSignal) => {
      if (workspaceId === wid('a') && aCalls++ === 0) {
        firstSignal = signal
        return new Promise<{ path: string; entries: WorkspaceFileEntry[]; truncated: boolean }>((resolve) => { resolveFirst = resolve })
      }
      return Promise.resolve({ path: '', entries: [], truncated: false })
    })
    const view = mountWorkbench({ listFiles })
    await waitFor(() => { expect(firstSignal).toBeDefined() })

    act(() => { view.switchSession('s-b') })
    expect(firstSignal?.aborted).toBe(true)
    act(() => { resolveFirst?.({ path: '', entries: [{ name: 'late.txt', path: 'late.txt', kind: 'file' }], truncated: false }) })
    await act(async () => { await Promise.resolve() })
    expect(view.instance.getSnapshot().byWorkspace.a?.directories['']?.entries).toEqual([])

    act(() => { view.switchSession('s-a') })
    await waitFor(() => {
      expect(listFiles.mock.calls.filter(call => call[0] === wid('a'))).toHaveLength(2)
    })
    expect(view.instance.getSnapshot().byWorkspace.a?.directories['']?.loading).toBe(false)
  })

  it('aborts a superseded directory refresh and ignores its stale result', async () => {
    let firstSignal: AbortSignal | undefined
    let resolveFirst: ((value: { path: string; entries: WorkspaceFileEntry[]; truncated: boolean }) => void) | undefined
    const listFiles = vi.fn((_workspaceId: WorkspaceId, _path?: string, signal?: AbortSignal) => {
      if (firstSignal === undefined) {
        firstSignal = signal
        return new Promise<{ path: string; entries: WorkspaceFileEntry[]; truncated: boolean }>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({
        path: '', entries: [{ name: 'fresh.txt', path: 'fresh.txt', kind: 'file' as const }], truncated: false,
      })
    })
    const view = mountWorkbench({ listFiles })
    await waitFor(() => { expect(firstSignal).toBeDefined() })

    fireEvent.click(view.getByRole('button', { name: '刷新文件树' }))

    expect(firstSignal?.aborted).toBe(true)
    expect(await view.findByRole('button', { name: /^TXTfresh\.txt$/ })).toBeTruthy()
    act(() => {
      resolveFirst?.({
        path: '', entries: [{ name: 'stale.txt', path: 'stale.txt', kind: 'file' }], truncated: false,
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(view.queryByRole('button', { name: /^TXTstale\.txt$/ })).toBeNull()
  })
})
