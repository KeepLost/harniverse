import { describe, expect, it } from 'vitest'
import { createWorkspaceWorkbenchStore } from '../src/client/stores.ts'

describe('createWorkspaceWorkbenchStore', () => {
  it('isolates navigation, documents, search, and Git state by Workspace', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.ensureWorkspace('a')
    actions.setSection('a', 'search')
    actions.setDirectory('a', '', { entries: [], truncated: false, loading: false })
    actions.openTab('a', { id: 'file:a.ts', path: 'a.ts', title: 'a.ts', kind: 'code', loading: false, content: 'a' })
    actions.setSearch('a', {
      query: 'a', include: '*.ts', exclude: 'dist/', filtersOpen: true,
      entries: [], truncated: false, loading: false,
    })
    actions.setGit('a', { branch: 'main', entries: [], commits: [], truncated: false, loading: false })
    actions.ensureWorkspace('a')
    actions.ensureWorkspace('b')

    expect(store.getSnapshot().byWorkspace.a).toMatchObject({
      section: 'search', activeTabId: 'file:a.ts', previewOpen: true,
      search: { query: 'a', include: '*.ts', exclude: 'dist/', filtersOpen: true }, git: { branch: 'main' },
    })
    expect(store.getSnapshot().byWorkspace.b).toMatchObject({
      section: 'files', tabs: [], activeTabId: null, previewOpen: false, git: null,
    })
  })

  it('selects a neighboring tab on close and prunes only retired Workspaces', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.openTab('a', { id: 'one', path: 'one', title: 'one', kind: 'text', loading: false })
    actions.openTab('a', { id: 'two', path: 'two', title: 'two', kind: 'text', loading: false })
    actions.openTab('a', { id: 'three', path: 'three', title: 'three', kind: 'text', loading: false })
    actions.selectTab('a', 'two')
    actions.updateTab('a', { id: 'missing', path: 'missing', title: 'missing', kind: 'text', loading: false })
    actions.closeTab('a', 'missing')
    actions.closeTab('a', 'two')
    actions.setPreviewOpen('a', false)
    actions.selectTab('a', 'three')
    actions.ensureWorkspace('b')
    actions.retainWorkspaces(['a'])

    expect(store.getSnapshot().byWorkspace.a?.tabs.map(tab => tab.id)).toEqual(['one', 'three'])
    expect(store.getSnapshot().byWorkspace.a?.activeTabId).toBe('three')
    expect(store.getSnapshot().byWorkspace.a?.previewOpen).toBe(true)
    expect(store.getSnapshot().byWorkspace.b).toBeUndefined()
  })

  it('drops interrupted loading records when a Workspace becomes active again', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.setDirectory('a', '', { entries: [], truncated: false, loading: true })
    actions.setDirectory('a', 'src', { entries: [], truncated: false, loading: true })
    actions.setDirectoryExpanded('a', 'src', true)
    actions.openTab('a', { id: 'loading', path: 'loading', title: 'loading', kind: 'text', loading: true })
    actions.setSearch('a', {
      query: 'x', include: '*.py', exclude: '', filtersOpen: true,
      entries: [], truncated: false, loading: true,
    })
    actions.setGit('a', { branch: null, entries: [], commits: [], truncated: false, loading: true })

    actions.ensureWorkspace('a')

    expect(store.getSnapshot().byWorkspace.a).toMatchObject({
      directories: {}, tabs: [], activeTabId: null,
      expandedDirectories: {}, previewOpen: false,
      search: { query: 'x', include: '*.py', filtersOpen: true, loading: false }, git: null,
    })
  })

  it('dismisses without losing tabs and closes the surface with the final tab', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.openTab('a', { id: 'one', path: 'one', title: 'one', kind: 'text', loading: false })
    actions.setPreviewOpen('a', false)

    expect(store.getSnapshot().byWorkspace.a).toMatchObject({
      tabs: [{ id: 'one' }], activeTabId: 'one', previewOpen: false,
    })
    actions.selectTab('a', 'one')
    actions.closeTab('a', 'one')
    expect(store.getSnapshot().byWorkspace.a).toMatchObject({ tabs: [], activeTabId: null, previewOpen: false })
  })
})
