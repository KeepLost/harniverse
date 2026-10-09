// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  MachineTarget, OfficialImportResult, OfficialSessionCandidate, OfficialSessionScan, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { ArchiveDock, type ArchiveDockProps } from '../src/client/ArchiveDock.tsx'
import type { ArchiveDockInjected, SessionImportInjected } from '../src/client/controller.ts'
import { formatTime } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'
import { SessionImportSection, type SessionImportSectionProps } from '../src/client/SessionImportSection.tsx'
import { createArchiveDockStore, createSessionImportStore } from '../src/client/stores.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function hookOf<T>(instance: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(selector: (state: T) => S): S {
    return selector(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

function candidate(sourceId: string, patch: Partial<OfficialSessionCandidate> = {}): OfficialSessionCandidate {
  return {
    sourceId, path: `/official/${sourceId}`, format: 'official-v4', sourceSessionId: sourceId, turns: 3,
    createdAt: 1, updatedAt: new Date(2026, 9, 9, 8, 30).getTime(), sizeBytes: 2048, status: 'new', ...patch,
  }
}

function scanOf(items: OfficialSessionCandidate[], patch: Partial<OfficialSessionScan> = {}): OfficialSessionScan {
  return { roots: ['/home/u/.dsh/sessions'], items, unreadable: [], maxArtifactBytes: 4096, ...patch }
}

const sectionT = makeTranslate(zh) as SessionImportSectionProps['t']

function mountSection(options: { scan?: OfficialSessionScan; workspaces?: Array<{ workspaceId: string; title: string }> } = {}) {
  const instance = createSessionImportStore().create()
  const machine = source<MachineTarget>({ kind: 'host' })
  const face: Omit<SessionImportInjected, 'hooks'> = {
    scan: vi.fn(async () => { if (options.scan !== undefined) instance.actions.scanLoaded(options.scan) }),
    importSelected: vi.fn(async () => {}),
    importFile: vi.fn(async () => {}),
    openSession: vi.fn(async () => true),
  }
  const close = vi.fn()
  const workspaces = { items: options.workspaces ?? [] }
  const props = {
    ...face,
    t: sectionT,
    useStore: hookOf(instance),
    actions: instance.actions,
    useMachine: hookOf(machine),
    useWorkspaces: (selector: (state: typeof workspaces) => unknown) => selector(workspaces),
    close,
  } as unknown as SessionImportSectionProps
  const view = render(<SessionImportSection {...props} />)
  return { instance, machine, face, close, view }
}

describe('SessionImportSection', () => {
  it('scans on mount and lists candidates with provenance and status', async () => {
    const m = mountSection({
      scan: scanOf([
        candidate('a', { title: '整理仓库', sourceCwd: '/home/u/repo' }),
        candidate('b', { preview: '帮我看看日志', status: 'imported', archiveSessionId: 'x' }),
        candidate('c', { status: 'updated' }),
      ]),
    })
    await waitFor(() => { expect(screen.getByText('整理仓库')).toBeTruthy() })
    expect(m.face.scan).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { level: 2, name: zh.title })).toBeTruthy()
    expect(screen.getByText('扫描目录：/home/u/.dsh/sessions')).toBeTruthy()
    const rows = within(screen.getByRole('list', { name: zh['list.label'] })).getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toEqual([
      `整理仓库/home/u/repo · 3 轮 · ${formatTime(candidate('a').updatedAt)} · 2 KiB未导入`,
      `帮我看看日志未记录工作目录 · 3 轮 · ${formatTime(candidate('a').updatedAt)} · 2 KiB已导入`,
      `未命名会话未记录工作目录 · 3 轮 · ${formatTime(candidate('a').updatedAt)} · 2 KiB有更新`,
    ])
  })

  it('selects, targets, and imports the selection with row labels', async () => {
    const m = mountSection({
      scan: scanOf([candidate('a', { title: 'A' }), candidate('b', { status: 'imported' }), candidate('c', { status: 'updated' })]),
      workspaces: [{ workspaceId: 'w-1', title: '项目一' }],
    })
    await waitFor(() => { expect(screen.getByText('A')).toBeTruthy() })
    const importButton = screen.getByRole('button', { name: '导入所选（0）' }) as HTMLButtonElement
    expect(importButton.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['select.all'] }))
    expect(m.instance.getSnapshot().selected).toEqual(['a', 'c'])
    fireEvent.click(screen.getByRole('checkbox', { name: /^A/u }))
    expect(m.instance.getSnapshot().selected).toEqual(['c'])
    fireEvent.change(screen.getByRole('combobox', { name: zh['target.label'] }), { target: { value: 'w-1' } })
    expect(m.instance.getSnapshot().target).toEqual({ kind: 'workspace', workspaceId: 'w-1' })
    fireEvent.click(screen.getByRole('button', { name: '导入所选（1）' }))
    expect(m.face.importSelected).toHaveBeenCalledWith(['c'], { kind: 'workspace', workspaceId: 'w-1' }, { a: 'A', b: zh['row.untitled'], c: zh['row.untitled'] })
    fireEvent.change(screen.getByRole('combobox', { name: zh['target.label'] }), { target: { value: 'source-cwd' } })
    expect(m.instance.getSnapshot().target).toEqual({ kind: 'source-cwd' })
    fireEvent.click(screen.getByRole('button', { name: zh['select.none'] }))
    expect(m.instance.getSnapshot().selected).toEqual([])
    act(() => { m.instance.actions.importStarted() })
    expect(screen.getByRole('button', { name: zh.importing })).toBeTruthy()
  })

  it('reports scan states: empty, failed, scanning, and unreadable logs', async () => {
    const m = mountSection({
      scan: scanOf([], { unreadable: [{ path: '/official/big', reason: 'too-large', message: 'm' }] }),
    })
    await waitFor(() => { expect(screen.getByRole('status')).toBeTruthy() })
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.getByText('1 个文件无法导入')).toBeTruthy()
    expect(screen.getByText('文件过大 · /official/big')).toBeTruthy()
    act(() => { m.instance.actions.scanFailed('offline') })
    expect(screen.getByRole('alert').textContent).toBe('扫描失败：offline')
    fireEvent.click(screen.getByRole('button', { name: zh.scan }))
    expect(m.face.scan).toHaveBeenCalledTimes(2)
    act(() => { m.instance.actions.reset() })
    act(() => { m.instance.actions.scanStarted() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.scanning }).disabled).toBe(true)
  })

  it('resets and rescans when the targeted machine changes', async () => {
    const m = mountSection({ scan: scanOf([candidate('a', { title: 'A' })]) })
    await waitFor(() => { expect(screen.getByText('A')).toBeTruthy() })
    act(() => { m.instance.actions.toggle('a') })
    act(() => { m.machine.set({ kind: 'remote', id: 'host-2' }) })
    await waitFor(() => { expect(m.face.scan).toHaveBeenCalledTimes(2) })
    expect(m.instance.getSnapshot().selected).toEqual([])
  })

  it('uploads a chosen file with the scan limit and clears the picker', async () => {
    const m = mountSection({ scan: scanOf([]) })
    await waitFor(() => { expect(screen.getByText(zh.empty)).toBeTruthy() })
    const input = screen.getByLabelText(zh['upload.label']) as HTMLInputElement
    const file = new File(['x'], 'session.v4.jsonl')
    fireEvent.change(input, { target: { files: [file] } })
    expect(m.face.importFile).toHaveBeenCalledWith(file, { kind: 'source-cwd' }, 4096)
    fireEvent.change(input, { target: { files: [] } })
    expect(m.face.importFile).toHaveBeenCalledOnce()
    act(() => { m.instance.actions.refuse('太大了') })
    expect(screen.getByRole('alert').textContent).toBe('太大了')
  })

  it('uses the default upload limit before any scan lands', () => {
    const m = mountSection()
    const input = screen.getByLabelText(zh['upload.label']) as HTMLInputElement
    const file = new File(['x'], 'a.jsonl')
    fireEvent.change(input, { target: { files: [file] } })
    expect(m.face.importFile).toHaveBeenCalledWith(file, { kind: 'source-cwd' }, 64 * 1024 * 1024)
  })

  it('shows each outcome and opens settled archives, closing settings on success', async () => {
    const m = mountSection({ scan: scanOf([]) })
    await waitFor(() => { expect(screen.getByText(zh.empty)).toBeTruthy() })
    const results: Array<OfficialImportResult & { label: string }> = [
      { source: 'a', label: 'A', outcome: { status: 'imported', sessionId: 'archive-a', workspaceId: 'w' as never, attached: true, mappedEvents: 3, skippedEvents: 2 } },
      { source: 'b', label: 'B', outcome: { status: 'imported', sessionId: 'archive-b', workspaceId: 'w' as never, attached: false, mappedEvents: 3, skippedEvents: 0 } },
      { source: 'c', label: 'C', outcome: { status: 'already-imported', sessionId: 'archive-c' } },
      { source: 'd', label: 'D', outcome: { status: 'failed', reason: 'workspace-unavailable', message: 'gone' } },
    ]
    act(() => { m.instance.actions.importSettled(results) })
    const list = within(screen.getByRole('heading', { name: zh['results.title'] }).parentElement as HTMLElement)
    expect(list.getByText('已导入 · 2 条记录因格式不支持被省略')).toBeTruthy()
    expect(list.getByText(zh['result.importedDetached'])).toBeTruthy()
    expect(list.getByText(zh['result.already'])).toBeTruthy()
    expect(list.getByText('导入失败：目标工作区不可用 (gone)')).toBeTruthy()
    const opens = list.getAllByRole('button', { name: zh['result.open'] })
    expect(opens).toHaveLength(3)
    fireEvent.click(opens[0] as HTMLElement)
    await waitFor(() => { expect(m.close).toHaveBeenCalledOnce() })
    expect(m.face.openSession).toHaveBeenCalledWith('archive-a')
    vi.mocked(m.face.openSession).mockResolvedValueOnce(false)
    fireEvent.click(opens[2] as HTMLElement)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh['result.openError']) })
    expect(m.close).toHaveBeenCalledOnce()
  })
})

const dockT = makeTranslate(zh) as ArchiveDockProps['t']

function mountDock(archive: unknown, sessionId = 'archive' as SessionId) {
  const instance = createArchiveDockStore().create()
  const projection = source<unknown>(archive)
  const face: ArchiveDockInjected = {
    loadPresets: vi.fn(async () => { instance.actions.presetsLoaded([{ id: 'coder', name: 'Coder' }, { id: 'plain' }]) }),
    continueArchive: vi.fn(async () => {}),
  }
  const useProjection = (_key: string, selector: (value: unknown) => unknown) =>
    selector(useSyncExternalStore(projection.subscribe, projection.getSnapshot))
  const props = {
    ...face,
    t: dockT,
    sessionId,
    useProjection,
    useStore: hookOf(instance),
    actions: instance.actions,
  } as unknown as ArchiveDockProps
  const view = render(<ArchiveDock {...props} />)
  return { instance, projection, face, view }
}

describe('ArchiveDock', () => {
  it('renders nothing on an ordinary session and loads no roster', () => {
    const m = mountDock(null)
    expect(m.view.container.innerHTML).toBe('')
    expect(m.face.loadPresets).not.toHaveBeenCalled()
    act(() => { m.projection.set(undefined) })
    expect(m.view.container.innerHTML).toBe('')
  })

  it('explains the archive, loads presets once, and continues under the chosen preset', async () => {
    const m = mountDock({ format: 'official-v4', sourceCwd: '/home/u/repo' })
    expect(screen.getByRole('region', { name: zh['archive.title'] })).toBeTruthy()
    expect(screen.getByText(zh['archive.body'])).toBeTruthy()
    expect(screen.getByText('原工作目录：/home/u/repo')).toBeTruthy()
    await waitFor(() => { expect(screen.getByRole('option', { name: 'Coder' })).toBeTruthy() })
    expect(screen.getByRole('option', { name: 'plain' })).toBeTruthy()
    expect(m.face.loadPresets).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh['archive.continue'] }))
    expect(m.face.continueArchive).toHaveBeenLastCalledWith('')
    fireEvent.change(screen.getByRole('combobox', { name: zh['archive.preset'] }), { target: { value: 'coder' } })
    fireEvent.click(screen.getByRole('button', { name: zh['archive.continue'] }))
    expect(m.face.continueArchive).toHaveBeenLastCalledWith('coder')
  })

  it('locks while continuing and reports this archive’s failure', () => {
    const m = mountDock({ format: 'official-v3' })
    expect(screen.queryByText(/原工作目录/u)).toBeNull()
    act(() => { m.instance.actions.continueStarted('archive' as SessionId) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['archive.continuing'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: zh['archive.preset'] }).disabled).toBe(true)
    act(() => { m.instance.actions.continueFailed('archive' as SessionId, 'boom') })
    expect(screen.getByRole('alert').textContent).toBe('没能继续对话：boom')
    act(() => { m.instance.actions.continueFailed('other' as SessionId, 'elsewhere') })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})
