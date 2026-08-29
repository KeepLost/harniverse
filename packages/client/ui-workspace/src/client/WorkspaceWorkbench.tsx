import { useCallback, useDeferredValue, useEffect, useRef } from 'react'
import clsx from 'clsx'
import {
  IconBranchOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconCloseOutline16, IconFolderClose16, IconFolderOpen16,
  IconRefreshOutline16, IconSearchOutline16,
  IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileEntry } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspacePreviewOverlayProps, WorkspaceWorkbenchProps } from './contract/slots.ts'
import type {
  WorkbenchDirectory, WorkbenchGitArea, WorkbenchSearch, WorkbenchSection, WorkbenchTab,
} from './stores.ts'
import { previewType } from './preview-kind.ts'
import { WorkbenchPreview } from './WorkbenchPreview.tsx'
import css from './WorkspaceWorkbench.module.css'

type WorkbenchTranslate = WorkspaceWorkbenchProps['t']

/** Section tabs in render order; the glyph is the affordance on a narrow region. */
const SECTIONS: ReadonlyArray<{ section: WorkbenchSection; labelKey: 'workbench.files' | 'workbench.search' | 'workbench.changes' }> = [
  { section: 'files', labelKey: 'workbench.files' },
  { section: 'changes', labelKey: 'workbench.changes' },
  { section: 'search', labelKey: 'workbench.search' },
]

function basename(path: string): string {
  /* v8 ignore next -- split always returns at least one element, including for an empty string. */
  return path.split('/').pop() ?? path
}

function extension(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

/** Split a comma-separated glob field without breaking brace alternatives or character classes. */
export function globPatterns(field: string): string[] {
  const patterns: string[] = []
  let start = 0
  let braceDepth = 0
  let inClass = false
  for (let index = 0; index < field.length; index++) {
    const character = field.charAt(index)
    if (character === '[' && !inClass) inClass = true
    else if (character === ']' && inClass) inClass = false
    else if (!inClass && character === '{') braceDepth++
    else if (!inClass && character === '}' && braceDepth > 0) braceDepth--
    else if (!inClass && braceDepth === 0 && character === ',') {
      const pattern = field.slice(start, index).trim()
      if (pattern !== '') patterns.push(pattern)
      start = index + 1
    }
  }
  const pattern = field.slice(start).trim()
  if (pattern !== '') patterns.push(pattern)
  return patterns
}

type RequestRunner = <T>(
  request: (signal: AbortSignal) => Promise<T>,
  accept: (value: T) => void,
  reject: (error: string) => void,
  resource: string,
) => () => void

/** Abort superseded resource requests and reject every result from an older Workspace generation. */
function useRequestFence(workspaceId: string | undefined): RequestRunner {
  const generation = useRef(0)
  const active = useRef(new Set<AbortController>())
  const byResource = useRef(new Map<string, AbortController>())
  useEffect(() => {
    generation.current++
    return () => {
      generation.current++
      for (const controller of active.current) controller.abort()
      active.current.clear()
      byResource.current.clear()
    }
  }, [workspaceId])
  return useCallback(<T,>(
    request: (signal: AbortSignal) => Promise<T>,
    accept: (value: T) => void,
    reject: (error: string) => void,
    resource: string,
  ) => {
    byResource.current.get(resource)?.abort()
    const controller = new AbortController()
    const started = generation.current
    active.current.add(controller)
    byResource.current.set(resource, controller)
    void request(controller.signal).then((value) => {
      if (!controller.signal.aborted && generation.current === started) accept(value)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation.current !== started) return
      reject(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      active.current.delete(controller)
      if (byResource.current.get(resource) === controller) byResource.current.delete(resource)
    })
    return () => {
      controller.abort()
      active.current.delete(controller)
      if (byResource.current.get(resource) === controller) byResource.current.delete(resource)
    }
  }, [])
}

/** Package-internal recursive directory presentation, exported for direct component accounting. */
export function DirectoryChildren(props: {
  path: string
  depth: number
  directories: Record<string, WorkbenchDirectory>
  expanded: Record<string, boolean>
  activePath: string | undefined
  t: WorkbenchTranslate
  onToggle: (path: string) => void
  onOpen: (entry: WorkspaceFileEntry) => void
}) {
  const directory = props.directories[props.path]
  if (directory === undefined || directory.loading) return <div className={css.navStatus}>{props.t('workbench.directoryLoading')}</div>
  if (directory.error !== undefined) return <div className={css.navError}>{directory.error}</div>
  return (
    <>
      {directory.entries.map((entry) => {
        // 22px per level, matching the sidebar tree (16px slot + 6px gap).
        const inset = { paddingLeft: `${String(8 + props.depth * 22)}px` }
        if (entry.kind === 'directory') {
          const open = props.expanded[entry.path] === true
          return (
            <div key={entry.path}>
              <button type="button" className={css.treeRow} style={inset} aria-expanded={open} onClick={() => { props.onToggle(entry.path) }}>
                <span className={css.treeGlyph}>{open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}</span>
                <span className={css.treeGlyph}>{open ? <IconFolderOpen16 /> : <IconFolderClose16 />}</span>
                <span>{entry.name}</span>
              </button>
              {open && <DirectoryChildren {...props} path={entry.path} depth={props.depth + 1} />}
            </div>
          )
        }
        if (entry.kind !== 'file') {
          return <div key={entry.path} className={css.inertRow} style={inset} title={props.t('workbench.directoryUnsupported')}>{entry.name}</div>
        }
        return (
          <button
            type="button"
            key={entry.path}
            className={css.treeRow}
            style={inset}
            data-workbench-focus-path={entry.path}
            data-active={props.activePath === entry.path || undefined}
            aria-current={props.activePath === entry.path ? 'page' : undefined}
            onClick={() => { props.onOpen(entry) }}
          >
            <span className={clsx(css.treeGlyph, css.fileGlyph)}>{extension(entry.path).slice(0, 3).toUpperCase() || 'TXT'}</span>
            <span>{entry.name}</span>
          </button>
        )
      })}
      {directory.entries.length === 0 && <div className={css.navStatus}>{props.t('workbench.directoryEmpty')}</div>}
      {directory.truncated && <div className={css.navStatus}>{props.t('workbench.directoryTruncated')}</div>}
    </>
  )
}

/** Package-internal file-search presentation, exported for direct component accounting. */
export function SearchPanel(props: {
  query: string
  include: string
  exclude: string
  filtersOpen: boolean
  entries: WorkspaceFileEntry[]
  loading: boolean
  truncated: boolean
  error?: string
  t: WorkbenchTranslate
  onQuery: (query: string) => void
  onInclude: (patterns: string) => void
  onExclude: (patterns: string) => void
  onToggleFilters: () => void
  onOpen: (entry: WorkspaceFileEntry) => void
}) {
  const filtered = props.include.trim() !== '' || props.exclude.trim() !== ''
  return (
    <div className={css.searchPanel}>
      <label className={css.searchBox}>
        <IconSearchOutline16 />
        <input
          type="search"
          value={props.query}
          placeholder={props.t('workbench.fileSearchPlaceholder')}
          aria-label={props.t('workbench.fileSearchAria')}
          onChange={(event) => { props.onQuery(event.currentTarget.value) }}
        />
      </label>
      <button
        type="button"
        className={css.filterToggle}
        data-active={filtered || undefined}
        aria-expanded={props.filtersOpen || filtered}
        onClick={() => { if (!filtered) props.onToggleFilters() }}
      >
        <IconSettingsOutline16 size={12} />
        <span>{props.t(filtered ? 'workbench.filtersActive' : 'workbench.filters')}</span>
      </button>
      {(props.filtersOpen || filtered) && (
        <div className={css.filterFields}>
          <label className={css.filterField}>
            <span>{props.t('workbench.filterInclude')}</span>
            <input
              type="text"
              value={props.include}
              placeholder="*.py, src/**"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => { props.onInclude(event.currentTarget.value) }}
            />
          </label>
          <label className={css.filterField}>
            <span>{props.t('workbench.filterExclude')}</span>
            <input
              type="text"
              value={props.exclude}
              placeholder="dist/, *.min.js"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => { props.onExclude(event.currentTarget.value) }}
            />
          </label>
          <span className={css.filterHint}>{props.t('workbench.filterHint')}</span>
        </div>
      )}
      {props.loading && <div className={css.navStatus}>{props.t('workbench.fileSearchLoading')}</div>}
      {props.error !== undefined && <div className={css.navError}>{props.error}</div>}
      {!props.loading && props.query.trim() !== '' && props.entries.length === 0 && props.error === undefined
        && <div className={css.navStatus}>{props.t('workbench.fileSearchEmpty')}</div>}
      <div className={css.searchResults}>
        {props.entries.map(entry => (
          <button
            type="button"
            key={entry.path}
            className={css.searchResult}
            data-workbench-focus-path={entry.path}
            onClick={() => { props.onOpen(entry) }}
          >
            <strong>{entry.name}</strong>
            <span>{entry.path}</span>
          </button>
        ))}
      </div>
      {props.truncated && <div className={css.navStatus}>{props.t('workbench.fileSearchTruncated')}</div>}
    </div>
  )
}

/** Package-internal Git navigation presentation, exported for direct component accounting. */
export function ChangesPanel(props: {
  area: WorkbenchGitArea
  branch: string | null
  statusEntries: Array<{ path: string; indexStatus: string; worktreeStatus: string; originalPath?: string }>
  commits: Array<{ hash: string; shortHash: string; authoredAt: string; subject: string }>
  loading: boolean
  truncated: boolean
  error?: string
  t: WorkbenchTranslate
  onArea: (area: WorkbenchGitArea) => void
  onRefresh: () => void
  onOpenDiff: (entry: { path: string; indexStatus: string; worktreeStatus: string }) => void
  onOpenFile: (entry: WorkspaceFileEntry) => void
}) {
  const changed = props.statusEntries.filter(entry => props.area === 'staged'
    ? entry.indexStatus !== ' ' && entry.indexStatus !== '?'
    : entry.worktreeStatus !== ' ')
  return (
    <div className={css.changesPanel}>
      <div className={css.gitHeader}>
        <span>{props.branch === null ? props.t('workbench.gitChanges') : props.t('workbench.gitBranch', { name: props.branch })}</span>
        <button type="button" className={css.iconButton} aria-label={props.t('workbench.gitRefresh')} onClick={props.onRefresh}><IconRefreshOutline16 /></button>
      </div>
      <div className={css.segmented}>
        <button type="button" data-active={props.area === 'worktree' || undefined} aria-pressed={props.area === 'worktree'} onClick={() => { props.onArea('worktree') }}>{props.t('workbench.gitWorktree')}</button>
        <button type="button" data-active={props.area === 'staged' || undefined} aria-pressed={props.area === 'staged'} onClick={() => { props.onArea('staged') }}>{props.t('workbench.gitStaged')}</button>
      </div>
      {props.loading && <div className={css.navStatus}>{props.t('workbench.gitLoading')}</div>}
      {props.error !== undefined && <div className={css.navError}>{props.error}</div>}
      {!props.loading && props.error === undefined && changed.length === 0 && <div className={css.navStatus}>{props.t('workbench.gitEmpty')}</div>}
      <div className={css.changeList}>
        {changed.map((entry) => {
          const status = props.area === 'staged' ? entry.indexStatus : entry.worktreeStatus
          const untracked = props.area === 'worktree' && status === '?'
          return (
            <button
              type="button"
              key={`${props.area}:${entry.path}`}
              className={css.changeRow}
              data-workbench-focus-path={entry.path}
              onClick={() => {
                if (untracked) props.onOpenFile({ name: basename(entry.path), path: entry.path, kind: 'file' })
                else props.onOpenDiff(entry)
              }}
            >
              <span className={css.changeStatus} data-status={status}>{status}</span>
              <span title={entry.path}>{entry.path}</span>
            </button>
          )
        })}
      </div>
      {props.truncated && <div className={css.navStatus}>{props.t('workbench.gitTruncated')}</div>}
      <div className={css.historyHeading}>{props.t('workbench.gitHistory')}</div>
      <div className={css.commitList}>
        {props.commits.map(commit => (
          <div key={commit.hash} className={css.commitRow}>
            <code>{commit.shortHash}</code>
            <span>{commit.subject}</span>
            <time dateTime={commit.authoredAt}>{commit.authoredAt.slice(0, 10)}</time>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Top-level read-only Workspace workbench occupying the shell's workbench slot. */
export function WorkspaceWorkbench(props: WorkspaceWorkbenchProps) {
  const sessionId = props.useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.blank === false ? current : undefined
  })
  const sessionCwd = props.useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const workspace = props.useWorkspaces(state => (
    sessionId === undefined
      ? undefined
      : state.items.find(item => item.sessionIds.includes(sessionId))
        ?? state.items.find(item => item.path === sessionCwd)
  ))
  const retainedWorkspaces = props.useWorkspaces(state => state.baselinesReady ? state.items : null)
  const workspaceId = workspace?.workspaceId as string | undefined
  const account = props.useStore(state => workspaceId === undefined ? undefined : state.byWorkspace[workspaceId])
  const activeTab = account?.tabs.find(tab => tab.id === account.activeTabId)
  const runRequest = useRequestFence(workspaceId)

  useEffect(() => {
    if (retainedWorkspaces !== null) {
      props.actions.retainWorkspaces(retainedWorkspaces.map(item => item.workspaceId as string))
    }
  }, [props.actions, retainedWorkspaces])

  useEffect(() => {
    if (workspaceId !== undefined) props.actions.ensureWorkspace(workspaceId)
  }, [props.actions, workspaceId])

  const loadDirectory = useCallback((path: string) => {
    /* v8 ignore next -- no navigation or root-load effect renders without a resolved Workspace. */
    if (workspaceId === undefined || workspace === undefined) return
    props.actions.setDirectory(workspaceId, path, { entries: [], truncated: false, loading: true })
    runRequest(
      signal => props.listFiles(workspace.workspaceId, path === '' ? undefined : path, signal),
      (value) => { props.actions.setDirectory(workspaceId, path, { ...value, loading: false }) },
      (error) => { props.actions.setDirectory(workspaceId, path, { entries: [], truncated: false, loading: false, error }) },
      `directory:${path}`,
    )
  }, [props.actions, props.listFiles, runRequest, workspace, workspaceId])

  const rootMissing = account !== undefined && account.directories[''] === undefined
  useEffect(() => {
    if (rootMissing) loadDirectory('')
  }, [loadDirectory, rootMissing])

  const openFile = useCallback((entry: WorkspaceFileEntry) => {
    /* v8 ignore next -- file actions render only after a Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    const id = `file:${entry.path}`
    const existing = account?.tabs.find(tab => tab.id === id)
    if (existing !== undefined && existing.error === undefined) {
      props.actions.selectTab(workspaceId, id)
      return
    }
    const descriptor = previewType(entry.path)
    const pending: WorkbenchTab = {
      id, path: entry.path, title: entry.name, kind: descriptor.kind, loading: true,
      ...(descriptor.language === undefined ? {} : { language: descriptor.language }),
    }
    props.actions.openTab(workspaceId, pending)
    if (descriptor.kind === 'image' || descriptor.kind === 'pdf') {
      runRequest(
        signal => props.readBinaryFile(workspace.workspaceId, entry.path, signal),
        (value) => { props.actions.updateTab(workspaceId, { ...pending, ...value, loading: false }) },
        (error) => { props.actions.updateTab(workspaceId, { ...pending, loading: false, error }) },
        `tab:${id}`,
      )
    } else {
      runRequest(
        signal => props.readFile(workspace.workspaceId, entry.path, signal),
        (value) => {
          props.actions.updateTab(workspaceId, {
            ...pending, content: value.content, bytes: value.bytes, truncated: value.truncated, loading: false,
          })
        },
        (error) => { props.actions.updateTab(workspaceId, { ...pending, loading: false, error }) },
        `tab:${id}`,
      )
    }
  }, [account?.tabs, props.actions, props.readBinaryFile, props.readFile, runRequest, workspace, workspaceId])

  const loadGit = useCallback(() => {
    /* v8 ignore next -- Git actions render only after a Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    props.actions.setGit(workspaceId, {
      branch: null, entries: [], commits: [], loading: true, truncated: false,
    })
    runRequest(
      async (signal) => {
        const [status, history] = await Promise.allSettled([
          props.gitStatus(workspace.workspaceId, signal),
          props.gitCommits(workspace.workspaceId, undefined, signal),
        ])
        if (status.status === 'rejected') throw status.reason
        if (history.status === 'rejected') throw history.reason
        return [status.value, history.value] as const
      },
      ([status, history]) => {
        props.actions.setGit(workspaceId, {
          ...status,
          commits: history.commits,
          loading: false,
          truncated: status.truncated || history.truncated,
        })
      },
      (error) => {
        props.actions.setGit(workspaceId, {
          branch: null, entries: [], commits: [], loading: false, truncated: false, error,
        })
      },
      'git',
    )
  }, [props.actions, props.gitCommits, props.gitStatus, runRequest, workspace, workspaceId])

  const gitMissing = account !== undefined && account.section === 'changes' && account.git === null
  useEffect(() => {
    if (gitMissing) loadGit()
  }, [gitMissing, loadGit])

  const openDiff = useCallback((entry: { path: string; indexStatus: string; worktreeStatus: string }) => {
    /* v8 ignore next -- diff actions render only from an initialized Workspace account. */
    if (workspaceId === undefined || workspace === undefined || account === undefined) return
    const staged = account.gitArea === 'staged'
    const id = `diff:${staged ? 'staged' : 'worktree'}:${entry.path}`
    const existing = account.tabs.find(tab => tab.id === id)
    if (existing !== undefined && existing.error === undefined) {
      props.actions.selectTab(workspaceId, id)
      return
    }
    const pending: WorkbenchTab = {
      id,
      path: entry.path,
      title: props.t(staged ? 'workbench.diffStaged' : 'workbench.diffChanged', { name: basename(entry.path) }),
      kind: 'diff', language: 'diff', loading: true,
    }
    props.actions.openTab(workspaceId, pending)
    runRequest(
      signal => props.gitDiff(workspace.workspaceId, entry.path, staged, signal),
      (value) => { props.actions.updateTab(workspaceId, { ...pending, content: value.diff, truncated: value.truncated, loading: false }) },
      (error) => { props.actions.updateTab(workspaceId, { ...pending, loading: false, error }) },
      `tab:${id}`,
    )
  }, [account, props.actions, props.gitDiff, props.t, runRequest, workspace, workspaceId])

  const search = account?.search
  const query = search?.query ?? ''
  const include = search?.include ?? ''
  const exclude = search?.exclude ?? ''
  // One deferred trigger over the whole request shape: a filter edit re-runs the
  // search exactly the way a query edit does.
  const requestKey = `${query}\u0000${include}\u0000${exclude}`
  const deferredKey = useDeferredValue(requestKey)
  useEffect(() => {
    if (workspaceId === undefined || workspace === undefined || account?.section !== 'search' || requestKey !== deferredKey) return
    const needle = query.trim()
    if (needle === '') return
    props.actions.setSearch(workspaceId, {
      query, include, exclude, filtersOpen: account.search.filtersOpen, entries: [], truncated: false, loading: true,
    })
    let cancel = (): void => {}
    const timer = window.setTimeout(() => {
      cancel = runRequest(
        signal => props.searchFiles(
          workspace.workspaceId,
          needle,
          { include: globPatterns(include), exclude: globPatterns(exclude) },
          signal,
        ),
        (value) => {
          props.actions.setSearch(workspaceId, {
            query, include, exclude, filtersOpen: account.search.filtersOpen, ...value, loading: false,
          })
        },
        (error) => {
          props.actions.setSearch(workspaceId, {
            query, include, exclude, filtersOpen: account.search.filtersOpen, entries: [], truncated: false, loading: false, error,
          })
        },
        'search',
      )
    }, 180)
    return () => { window.clearTimeout(timer); cancel() }
  }, [
    account?.search.filtersOpen, account?.section, deferredKey, exclude, include, props.actions,
    props.searchFiles, query, requestKey, runRequest, workspace, workspaceId,
  ])

  if (workspace === undefined || workspaceId === undefined) {
    return (
      <aside className={css.root} aria-label={props.t('workbench.aria')}>
        <header className={css.header}>
          <strong className={css.headerTitle}>{props.t('workbench.label')}</strong>
          <button type="button" className={css.iconButton} aria-label={props.t('workbench.close')} onClick={props.closeWorkbench}><IconCloseOutline16 /></button>
        </header>
        <div className={css.emptyState}>{props.t('workbench.noWorkspace')}</div>
      </aside>
    )
  }

  const section = account?.section ?? 'files'
  const directories = account?.directories ?? {}
  const expanded = account?.expandedDirectories ?? { '': true }
  const searchAccount: WorkbenchSearch = search
    ?? { query: '', include: '', exclude: '', filtersOpen: false, entries: [], truncated: false, loading: false }
  const git = account?.git
  /* v8 ignore next -- the changes section exists only on an initialized default account. */
  const gitArea = account?.gitArea ?? 'worktree'
  const drawerPreviewOpen = props.drawer && account?.previewOpen === true
  const setSearchField = (patch: Partial<WorkbenchSearch>): void => {
    const next = { ...searchAccount, entries: [], truncated: false, loading: false, ...patch }
    delete next.error
    props.actions.setSearch(workspaceId, next)
  }
  return (
    <aside className={css.root} data-preview={drawerPreviewOpen || undefined} aria-label={props.t('workbench.aria')}>
      <header className={css.header}>
        <div className={css.headerText}>
          <span className={css.headerLabel}>{props.t('workbench.label')}</span>
          <strong className={css.headerTitle} title={workspace.path}>{workspace.title}</strong>
        </div>
        <button type="button" className={css.iconButton} aria-label={props.t('workbench.close')} onClick={props.closeWorkbench}><IconCloseOutline16 /></button>
      </header>
      <nav className={css.sectionTabs} aria-label={props.t('workbench.tools')}>
        <div className={css.sectionTabList} role="tablist">
          {SECTIONS.map((entry, index) => (
            <button
              key={entry.section}
              type="button"
              id={`workspace-workbench-section-${entry.section}`}
              role="tab"
              className={css.sectionTab}
              data-active={section === entry.section || undefined}
              aria-controls="workspace-workbench-navigation"
              aria-selected={section === entry.section}
              tabIndex={section === entry.section ? 0 : -1}
              title={props.t(entry.labelKey)}
              onClick={() => { props.actions.setSection(workspaceId, entry.section) }}
              onKeyDown={(event) => {
                let next = index
                if (event.key === 'ArrowLeft') next = (index + SECTIONS.length - 1) % SECTIONS.length
                else if (event.key === 'ArrowRight') next = (index + 1) % SECTIONS.length
                else if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = SECTIONS.length - 1
                else return
                event.preventDefault()
                const nextSection = SECTIONS[next]
                /* v8 ignore next -- navigation derives an in-range index from the fixed non-empty section list. */
                if (nextSection === undefined) throw new Error('section navigation produced an invalid index')
                props.actions.setSection(workspaceId, nextSection.section)
                event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
              }}
            >
              {entry.section === 'files' && <IconFolderOpen16 size={14} />}
              {entry.section === 'search' && <IconSearchOutline16 size={14} />}
              {entry.section === 'changes' && <IconBranchOutline16 size={14} />}
              <span>{props.t(entry.labelKey)}</span>
            </button>
          ))}
        </div>
        {section === 'files' && (
          <button
            type="button"
            className={clsx(css.iconButton, css.sectionTabSpacer)}
            aria-label={props.t('workbench.refreshFiles')}
            onClick={() => { loadDirectory('') }}
          ><IconRefreshOutline16 /></button>
        )}
      </nav>
      <section
        id="workspace-workbench-navigation"
        className={css.navigator}
        role="tabpanel"
        aria-labelledby={`workspace-workbench-section-${section}`}
      >
        <div className={css.navigatorBody}>
          {section === 'files' && (
            <DirectoryChildren
              path=""
              depth={0}
              directories={directories}
              expanded={expanded}
              activePath={activeTab?.kind === 'diff' ? undefined : activeTab?.path}
              t={props.t}
              onToggle={(path) => {
                const open = expanded[path] !== true
                props.actions.setDirectoryExpanded(workspaceId, path, open)
                if (open && directories[path] === undefined) loadDirectory(path)
              }}
              onOpen={openFile}
            />
          )}
          {section === 'search' && (
            <SearchPanel
              {...searchAccount}
              t={props.t}
              onQuery={(next) => { setSearchField({ query: next }) }}
              onInclude={(next) => { setSearchField({ include: next }) }}
              onExclude={(next) => { setSearchField({ exclude: next }) }}
              onToggleFilters={() => {
                props.actions.setSearch(workspaceId, { ...searchAccount, filtersOpen: !searchAccount.filtersOpen })
              }}
              onOpen={openFile}
            />
          )}
          {section === 'changes' && (
            <ChangesPanel
              area={gitArea}
              branch={git?.branch ?? null}
              statusEntries={git?.entries ?? []}
              commits={git?.commits ?? []}
              loading={git?.loading ?? true}
              truncated={git?.truncated ?? false}
              {...(git?.error === undefined ? {} : { error: git.error })}
              t={props.t}
              onArea={(area) => { props.actions.setGitArea(workspaceId, area) }}
              onRefresh={loadGit}
              onOpenDiff={openDiff}
              onOpenFile={openFile}
            />
          )}
        </div>
      </section>
      {/* Drawer mode: the region already covers the frame and the shell's
          overlay layer is inert, so preview renders here instead of there. */}
      {props.drawer && (
        <WorkbenchPreview
          tabs={account?.tabs ?? []}
          activeTabId={account?.activeTabId ?? null}
          open={account?.previewOpen ?? false}
          focusScopeKey={workspaceId}
          {...(activeTab?.path === undefined ? {} : { focusReturnPath: activeTab.path })}
          placement="in-column"
          t={props.t}
          onSelect={(id) => { props.actions.selectTab(workspaceId, id) }}
          onClose={(id) => { props.actions.closeTab(workspaceId, id) }}
          onDismiss={() => { props.actions.setPreviewOpen(workspaceId, false) }}
        />
      )}
    </aside>
  )
}

/**
 * The preview companion for the docked case: same store, rendered into the
 * frame-wide overlay layer so the surface can slide over the conversation.
 *
 * Registered separately from the workbench because the two live in different
 * frame regions; they share one store handle, so tabs and open-state are the
 * same facts on both sides.
 */
export function WorkspaceWorkbenchPreviewOverlay(props: WorkspacePreviewOverlayProps) {
  const sessionId = props.useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.blank === false ? current : undefined
  })
  const sessionCwd = props.useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const workspaceId = props.useWorkspaces(state => (
    sessionId === undefined
      ? undefined
      : (state.items.find(item => item.sessionIds.includes(sessionId))
        ?? state.items.find(item => item.path === sessionCwd))?.workspaceId as string | undefined
  ))
  const account = props.useStore(state => workspaceId === undefined ? undefined : state.byWorkspace[workspaceId])
  const activeTab = account?.tabs.find(tab => tab.id === account.activeTabId)
  useEffect(() => {
    return () => {
      if (workspaceId !== undefined) props.actions.setPreviewOpen(workspaceId, false)
    }
  }, [props.actions, workspaceId])
  useEffect(() => {
    if (
      workspaceId !== undefined
      && account?.previewOpen === true
      && (!props.rightOpen || props.rightMode !== 'workbench')
    ) props.actions.setPreviewOpen(workspaceId, false)
  }, [account?.previewOpen, props.actions, props.rightMode, props.rightOpen, workspaceId])
  if (workspaceId === undefined || props.rightDrawer || !props.rightOpen || props.rightMode !== 'workbench') return null
  return (
    <WorkbenchPreview
      tabs={account?.tabs ?? []}
      activeTabId={account?.activeTabId ?? null}
      open={account?.previewOpen === true}
      focusScopeKey={workspaceId}
      {...(activeTab?.path === undefined ? {} : { focusReturnPath: activeTab.path })}
      placement="overlay"
      t={props.t}
      onSelect={(id) => { props.actions.selectTab(workspaceId, id) }}
      onClose={(id) => { props.actions.closeTab(workspaceId, id) }}
      onDismiss={() => { props.actions.setPreviewOpen(workspaceId, false) }}
    />
  )
}
