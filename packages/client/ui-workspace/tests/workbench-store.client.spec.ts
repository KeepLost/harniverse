import { describe, expect, it } from 'vitest'
import { createWorkspaceWorkbenchStore } from '../src/client/stores.ts'

describe('createWorkspaceWorkbenchStore', () => {
  it('isolates navigation, documents, search, and Git state by Workspace', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.ensureWorkspace('a')
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
      activeTabId: 'file:a.ts', previewOpen: true,
      search: { query: 'a', include: '*.ts', exclude: 'dist/', filtersOpen: true }, git: { branch: 'main' },
    })
    expect(store.getSnapshot().byWorkspace.b).toMatchObject({
      tabs: [], activeTabId: null, previewOpen: false, git: null,
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

  it('prunes expanded directories at and under a non-root interrupted directory', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.setDirectory('a', 'src', { entries: [], truncated: false, loading: true })
    actions.setDirectoryExpanded('a', '', true)
    actions.setDirectoryExpanded('a', 'src', true)
    actions.setDirectoryExpanded('a', 'src/deep', true)
    actions.setDirectoryExpanded('a', 'other', true)

    actions.ensureWorkspace('a')

    expect(store.getSnapshot().byWorkspace.a?.directories).toEqual({})
    expect(store.getSnapshot().byWorkspace.a?.expandedDirectories).toEqual({ '': true, other: true })
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

  it('keeps retained accounts and reconciles tab edits, selection and activity', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.ensureWorkspace('a')
    actions.retainWorkspaces(['a'])
    actions.openTab('a', { id: 'one', path: 'one', title: 'one', kind: 'text', loading: false })
    actions.openTab('a', { id: 'one', path: 'one', title: 'reopened', kind: 'text', loading: false })
    actions.updateTab('a', { id: 'one', path: 'one', title: 'updated', kind: 'text', loading: false })
    actions.closeTab('a', 'one')
    actions.setGitArea('a', 'staged')
    actions.setSyncedActivity('a', 12)
    expect(store.getSnapshot().byWorkspace.a).toMatchObject({
      tabs: [], activeTabId: null, previewOpen: false, gitArea: 'staged', syncedActivity: 12,
    })
  })

  it('defaults accounts to automatic file watching and records the manual drop', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.ensureWorkspace('a')
    expect(store.getSnapshot().byWorkspace.a?.fileWatch).toBe('auto')
    actions.setFileWatch('a', 'manual')
    expect(store.getSnapshot().byWorkspace.a?.fileWatch).toBe('manual')
  })

  it('reselects the previous tab after closing the active last tab', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.openTab('a', { id: 'one', path: 'one', title: 'one', kind: 'text', loading: false })
    actions.openTab('a', { id: 'two', path: 'two', title: 'two', kind: 'text', loading: false })
    actions.closeTab('a', 'one')
    expect(store.getSnapshot().byWorkspace.a).toMatchObject({ activeTabId: 'two', previewOpen: true })
    actions.openTab('a', { id: 'one', path: 'one', title: 'one', kind: 'text', loading: false })
    actions.selectTab('a', 'two')
    actions.closeTab('a', 'two')
    expect(store.getSnapshot().byWorkspace.a).toMatchObject({ activeTabId: 'one', previewOpen: true })
  })
})

describe('document preview mode and unsaved-edit facts', () => {
  const tab = (id: string) => ({ id, path: id.slice(5), title: id.slice(5), kind: 'markdown' as const, loading: false, content: '#' })

  it('records a per-tab mode that defaults to absent and survives tab selection', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.openTab('a', tab('file:one.md'))
    expect(store.getSnapshot().byWorkspace.a?.previewMode).toEqual({})
    actions.setPreviewMode('a', 'file:one.md', 'edit')
    actions.openTab('a', tab('file:two.md'))
    actions.selectTab('a', 'file:one.md')
    expect(store.getSnapshot().byWorkspace.a?.previewMode).toEqual({ 'file:one.md': 'edit' })
    actions.setPreviewMode('a', 'file:one.md', 'preview')
    expect(store.getSnapshot().byWorkspace.a?.previewMode).toEqual({ 'file:one.md': 'preview' })
  })

  it('tracks unsaved-edit facts per tab and only writes when the fact changes', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.openTab('a', tab('file:one.md'))
    const before = store.getSnapshot()
    actions.setDocumentDirty('a', 'file:one.md', false)
    expect(store.getSnapshot()).toBe(before)
    actions.setDocumentDirty('a', 'file:one.md', true)
    expect(store.getSnapshot().byWorkspace.a?.documentDirty).toEqual({ 'file:one.md': true })
    actions.setDocumentDirty('a', 'file:one.md', false)
    expect(store.getSnapshot().byWorkspace.a?.documentDirty).toEqual({})
  })

  it('drops the mode and the dirty fact with the closed tab only', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.openTab('a', tab('file:one.md'))
    actions.openTab('a', tab('file:two.md'))
    actions.setPreviewMode('a', 'file:one.md', 'edit')
    actions.setPreviewMode('a', 'file:two.md', 'edit')
    actions.setDocumentDirty('a', 'file:one.md', true)
    actions.setDocumentDirty('a', 'file:two.md', true)
    actions.closeTab('a', 'file:one.md')
    expect(store.getSnapshot().byWorkspace.a?.previewMode).toEqual({ 'file:two.md': 'edit' })
    expect(store.getSnapshot().byWorkspace.a?.documentDirty).toEqual({ 'file:two.md': true })
  })

  it('prunes mode and dirty facts of tabs that no longer exist when a Workspace becomes active again', () => {
    const { store, actions } = createWorkspaceWorkbenchStore().create()
    actions.openTab('a', tab('file:kept.md'))
    actions.openTab('a', { ...tab('file:gone.md'), loading: true })
    actions.setPreviewMode('a', 'file:kept.md', 'edit')
    actions.setPreviewMode('a', 'file:gone.md', 'edit')
    actions.setDocumentDirty('a', 'file:kept.md', true)
    actions.setDocumentDirty('a', 'file:gone.md', true)
    actions.ensureWorkspace('a')
    expect(store.getSnapshot().byWorkspace.a?.previewMode).toEqual({ 'file:kept.md': 'edit' })
    expect(store.getSnapshot().byWorkspace.a?.documentDirty).toEqual({ 'file:kept.md': true })
  })
})
