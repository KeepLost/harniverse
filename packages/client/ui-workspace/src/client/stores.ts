/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceFileEntry, WorkspaceGitCommit, WorkspaceGitStatusEntry } from '@deepseek-ai/dsh-client-runtime/client'

/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

/** Session-list grouping mode: workspace sections or one flat recency list. */
export type SessionGroupBy = 'workspace' | 'flat'
/** Session order: user-arranged only, or user-arranged plus activity promotion. */
export type SessionOrderBy = 'manual' | 'updated'

/** Workspace browser viewing state persisted across surface remounts and reloads. */
type WorkspaceViewState = {
  groupBy: SessionGroupBy
  orderBy: SessionOrderBy
  /** Explicit zero-or-five-session state keyed by Workspace group identity. */
  groupExpansion: Record<string, boolean>
  /** Shared editable order per Workspace group plus the browser-local flat-list account. */
  sessionOrderByAccount: Record<string, string[]>
  /** Last observed update timestamps per order account for one-time promotion events. */
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: SessionGroupBy) => void
  setOrderBy: (draft: WorkspaceViewState, mode: SessionOrderBy) => void
  setGroupExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void
  retainAccountKeys: (draft: WorkspaceViewState, workspaceKeys: readonly string[]) => void
  syncSessionOrderAccount: (
    draft: WorkspaceViewState,
    accountKey: string,
    order: string[],
    updatedAt: Record<string, number>,
  ) => void
  setSessionOrder: (draft: WorkspaceViewState, accountKey: string, order: string[]) => void
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  return defineStore({
    init: (): WorkspaceViewState => ({
      groupBy: 'workspace',
      orderBy: 'updated',
      groupExpansion: {},
      sessionOrderByAccount: {},
      sessionUpdatedAtByAccount: {},
    }),
    persist: 'dsh.workspace.view.v5',
    actions: {
      setGroupBy: (d, mode: SessionGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: SessionOrderBy) => { d.orderBy = mode },
      setGroupExpanded: (d, key: string, expanded: boolean) => { d.groupExpansion[key] = expanded },
      retainAccountKeys: (d, workspaceKeys: readonly string[]) => {
        const retained = new Set(workspaceKeys)
        d.groupExpansion = Object.fromEntries(
          Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)),
        )
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)),
        )
        d.sessionUpdatedAtByAccount = Object.fromEntries(
          Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => retained.has(key)),
        )
      },
      syncSessionOrderAccount: (d, accountKey: string, order: string[], updatedAt: Record<string, number>) => {
        d.sessionOrderByAccount[accountKey] = order
        d.sessionUpdatedAtByAccount[accountKey] = updatedAt
      },
      setSessionOrder: (d, accountKey: string, order: string[]) => {
        d.sessionOrderByAccount[accountKey] = order
      },
    },
  })
}

/** Primary navigation section in the Workspace workbench. */
export type WorkbenchSection = 'files' | 'search' | 'changes'
/** Renderer selected for one read-only document tab. */
export type WorkbenchPreviewKind = 'markdown' | 'html' | 'code' | 'text' | 'csv' | 'image' | 'pdf' | 'diff'
/** Git status side whose diff entries are visible. */
export type WorkbenchGitArea = 'worktree' | 'staged'

/** One open file or Git diff, including its ephemeral request result. */
export interface WorkbenchTab {
  id: string
  path: string
  title: string
  kind: WorkbenchPreviewKind
  loading: boolean
  language?: string
  content?: string
  dataBase64?: string
  mediaType?: string
  bytes?: number
  truncated?: boolean
  error?: string
}

/** One lazily loaded directory level. */
export interface WorkbenchDirectory {
  entries: WorkspaceFileEntry[]
  truncated: boolean
  loading: boolean
  error?: string
}

/** Current file-name query and its bounded result. */
export interface WorkbenchSearch {
  query: string
  entries: WorkspaceFileEntry[]
  truncated: boolean
  loading: boolean
  error?: string
}

/** Current read-only Git status and recent history. */
export interface WorkbenchGit {
  branch: string | null
  entries: WorkspaceGitStatusEntry[]
  commits: WorkspaceGitCommit[]
  loading: boolean
  truncated: boolean
  error?: string
}

/** Complete ephemeral viewing account for one Workspace id. */
export interface WorkspaceWorkbenchAccount {
  section: WorkbenchSection
  directories: Record<string, WorkbenchDirectory>
  expandedDirectories: Record<string, boolean>
  tabs: WorkbenchTab[]
  activeTabId: string | null
  search: WorkbenchSearch
  gitArea: WorkbenchGitArea
  git: WorkbenchGit | null
}

/** Ephemeral read-only workbench state, explicitly isolated by Workspace id. */
export interface WorkspaceWorkbenchState {
  byWorkspace: Record<string, WorkspaceWorkbenchAccount>
}

type WorkspaceWorkbenchActions = {
  ensureWorkspace: (draft: WorkspaceWorkbenchState, workspaceId: string) => void
  retainWorkspaces: (draft: WorkspaceWorkbenchState, workspaceIds: readonly string[]) => void
  setSection: (draft: WorkspaceWorkbenchState, workspaceId: string, section: WorkbenchSection) => void
  setDirectory: (draft: WorkspaceWorkbenchState, workspaceId: string, path: string, value: WorkbenchDirectory) => void
  setDirectoryExpanded: (draft: WorkspaceWorkbenchState, workspaceId: string, path: string, expanded: boolean) => void
  openTab: (draft: WorkspaceWorkbenchState, workspaceId: string, tab: WorkbenchTab) => void
  updateTab: (draft: WorkspaceWorkbenchState, workspaceId: string, tab: WorkbenchTab) => void
  selectTab: (draft: WorkspaceWorkbenchState, workspaceId: string, tabId: string) => void
  closeTab: (draft: WorkspaceWorkbenchState, workspaceId: string, tabId: string) => void
  setSearch: (draft: WorkspaceWorkbenchState, workspaceId: string, value: WorkbenchSearch) => void
  setGitArea: (draft: WorkspaceWorkbenchState, workspaceId: string, area: WorkbenchGitArea) => void
  setGit: (draft: WorkspaceWorkbenchState, workspaceId: string, value: WorkbenchGit) => void
}

function defaultWorkbenchAccount(): WorkspaceWorkbenchAccount {
  return {
    section: 'files',
    directories: {},
    expandedDirectories: { '': true },
    tabs: [],
    activeTabId: null,
    search: { query: '', entries: [], truncated: false, loading: false },
    gitArea: 'worktree',
    git: null,
  }
}

function workbenchAccount(draft: WorkspaceWorkbenchState, workspaceId: string): WorkspaceWorkbenchAccount {
  return draft.byWorkspace[workspaceId] ??= defaultWorkbenchAccount()
}

/**
 * Create the page-lifetime Workspace workbench store; file and Git data are never persisted.
 * @returns a root-scoped store handle partitioned by Workspace id.
 */
export function createWorkspaceWorkbenchStore(): EngineStoreHandle<WorkspaceWorkbenchState, WorkspaceWorkbenchActions> {
  return defineStore({
    init: (): WorkspaceWorkbenchState => ({ byWorkspace: {} }),
    actions: {
      ensureWorkspace: (d, workspaceId) => {
        const account = workbenchAccount(d, workspaceId)
        account.directories = Object.fromEntries(
          Object.entries(account.directories).filter(([, directory]) => !directory.loading),
        )
        account.tabs = account.tabs.filter(tab => !tab.loading)
        if (account.activeTabId !== null && !account.tabs.some(tab => tab.id === account.activeTabId)) {
          account.activeTabId = account.tabs.at(-1)?.id ?? null
        }
        if (account.search.loading) account.search = { query: account.search.query, entries: [], truncated: false, loading: false }
        if (account.git?.loading === true) account.git = null
      },
      retainWorkspaces: (d, workspaceIds) => {
        const retained = new Set(workspaceIds)
        if (Object.keys(d.byWorkspace).every(key => retained.has(key))) return
        d.byWorkspace = Object.fromEntries(Object.entries(d.byWorkspace).filter(([key]) => retained.has(key)))
      },
      setSection: (d, workspaceId, section) => { workbenchAccount(d, workspaceId).section = section },
      setDirectory: (d, workspaceId, path, value) => { workbenchAccount(d, workspaceId).directories[path] = value },
      setDirectoryExpanded: (d, workspaceId, path, expanded) => {
        workbenchAccount(d, workspaceId).expandedDirectories[path] = expanded
      },
      openTab: (d, workspaceId, tab) => {
        const account = workbenchAccount(d, workspaceId)
        const index = account.tabs.findIndex(entry => entry.id === tab.id)
        if (index === -1) account.tabs.push(tab)
        else account.tabs[index] = tab
        account.activeTabId = tab.id
      },
      updateTab: (d, workspaceId, tab) => {
        const account = workbenchAccount(d, workspaceId)
        const index = account.tabs.findIndex(entry => entry.id === tab.id)
        if (index !== -1) account.tabs[index] = tab
      },
      selectTab: (d, workspaceId, tabId) => { workbenchAccount(d, workspaceId).activeTabId = tabId },
      closeTab: (d, workspaceId, tabId) => {
        const account = workbenchAccount(d, workspaceId)
        const index = account.tabs.findIndex(entry => entry.id === tabId)
        if (index === -1) return
        account.tabs.splice(index, 1)
        if (account.activeTabId === tabId) {
          account.activeTabId = account.tabs[Math.min(index, account.tabs.length - 1)]?.id ?? null
        }
      },
      setSearch: (d, workspaceId, value) => { workbenchAccount(d, workspaceId).search = value },
      setGitArea: (d, workspaceId, area) => { workbenchAccount(d, workspaceId).gitArea = area },
      setGit: (d, workspaceId, value) => { workbenchAccount(d, workspaceId).git = value },
    },
  })
}
