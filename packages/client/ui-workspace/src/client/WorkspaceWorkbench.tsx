import {
  useCallback, useDeferredValue, useEffect, useRef, useState,
} from 'react'
import {
  CodeBlock, IconBranchOutline16, IconChevronDownOutline14, IconChevronLeftOutline14,
  IconChevronRightOutline14, IconCloseOutline16, IconFolderClose16, IconFolderOpen16,
  IconRefreshOutline16, IconSearchOutline16, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileEntry } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceWorkbenchProps } from './contract/slots.ts'
import type {
  WorkbenchDirectory, WorkbenchGitArea, WorkbenchPreviewKind, WorkbenchSection,
  WorkbenchTab,
} from './stores.ts'
import css from './WorkspaceWorkbench.module.css'

type WorkbenchTranslate = WorkspaceWorkbenchProps['t']

const BINARY_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'pdf', 'png', 'svg', 'webp'])
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  c: 'c', cc: 'cpp', cpp: 'cpp', css: 'css', go: 'go', h: 'c', hpp: 'cpp',
  java: 'java', js: 'javascript', json: 'json', jsonc: 'jsonc', jsx: 'jsx',
  kt: 'kotlin', mjs: 'javascript', php: 'php', py: 'python', rb: 'ruby', rs: 'rust',
  scss: 'scss', sh: 'bash', sql: 'sql', swift: 'swift', toml: 'toml', ts: 'typescript',
  tsx: 'tsx', vue: 'vue', xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'bash',
}

function basename(path: string): string {
  /* v8 ignore next -- split always returns at least one element, including for an empty string. */
  return path.split('/').pop() ?? path
}

function extension(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

/** Resolve a file path to its read-only preview renderer. */
export function previewType(path: string): { kind: WorkbenchPreviewKind; language?: string } {
  const ext = extension(path)
  if (ext === 'md' || ext === 'mdx') return { kind: 'markdown' }
  if (ext === 'htm' || ext === 'html') return { kind: 'html' }
  if (ext === 'csv') return { kind: 'csv' }
  if (ext === 'pdf') return { kind: 'pdf' }
  if (BINARY_EXTENSIONS.has(ext)) return { kind: 'image' }
  const language = LANGUAGE_BY_EXTENSION[ext]
  return language === undefined ? { kind: 'text' } : { kind: 'code', language }
}

export interface CsvPreview {
  rows: string[][]
  truncated: boolean
}

/** Parse enough RFC-4180-style CSV for a bounded preview table. */
export function parseCsvPreview(content: string, maxRows = 100, maxColumns = 50): CsvPreview {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false
  const pushRow = (): boolean => {
    row.push(field)
    field = ''
    if (row.length > maxColumns) {
      row = row.slice(0, maxColumns)
      truncated = true
    }
    rows.push(row)
    row = []
    return rows.length >= maxRows
  }
  for (let index = 0; index < content.length; index++) {
    const char = content.charAt(index)
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { field += '"'; index++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n') {
      if (pushRow()) return { rows, truncated: index < content.length - 1 || truncated }
    } else if (char !== '\r') field += char
  }
  if (field !== '' || row.length > 0) pushRow()
  return { rows, truncated }
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
        const inset = { paddingLeft: `${String(10 + props.depth * 14)}px` }
        if (entry.kind === 'directory') {
          const open = props.expanded[entry.path] === true
          return (
            <div key={entry.path}>
              <button type="button" className={css.treeRow} style={inset} aria-expanded={open} onClick={() => { props.onToggle(entry.path) }}>
                {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                {open ? <IconFolderOpen16 /> : <IconFolderClose16 />}
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
            data-active={props.activePath === entry.path || undefined}
            aria-current={props.activePath === entry.path ? 'page' : undefined}
            onClick={() => { props.onOpen(entry) }}
          >
            <span className={css.fileGlyph}>{extension(entry.path).slice(0, 3).toUpperCase() || 'TXT'}</span>
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
  entries: WorkspaceFileEntry[]
  loading: boolean
  truncated: boolean
  error?: string
  t: WorkbenchTranslate
  onQuery: (query: string) => void
  onOpen: (entry: WorkspaceFileEntry) => void
}) {
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
      {props.loading && <div className={css.navStatus}>{props.t('workbench.fileSearchLoading')}</div>}
      {props.error !== undefined && <div className={css.navError}>{props.error}</div>}
      {!props.loading && props.query.trim() !== '' && props.entries.length === 0 && props.error === undefined
        && <div className={css.navStatus}>{props.t('workbench.fileSearchEmpty')}</div>}
      <div className={css.searchResults}>
        {props.entries.map(entry => (
          <button type="button" key={entry.path} className={css.searchResult} onClick={() => { props.onOpen(entry) }}>
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
        <button type="button" aria-label={props.t('workbench.gitRefresh')} onClick={props.onRefresh}><IconRefreshOutline16 /></button>
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
              onClick={() => {
                if (untracked) props.onOpenFile({ name: basename(entry.path), path: entry.path, kind: 'file' })
                else props.onOpenDiff(entry)
              }}
            >
              <span data-status={status}>{status}</span>
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

function useObjectUrl(tab: WorkbenchTab | undefined): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (tab?.dataBase64 === undefined || tab.mediaType === undefined || typeof URL.createObjectURL !== 'function') {
      setUrl(undefined)
      return
    }
    const binary = atob(tab.dataBase64)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const next = URL.createObjectURL(new Blob([bytes], { type: tab.mediaType }))
    setUrl(next)
    return () => { URL.revokeObjectURL(next) }
  }, [tab?.dataBase64, tab?.mediaType])
  return url
}

/** Package-internal bounded CSV presentation, exported for direct component accounting. */
export function CsvTable({ content, t }: { content: string; t: WorkbenchTranslate }) {
  const parsed = parseCsvPreview(content)
  const [header, ...body] = parsed.rows
  if (header === undefined) return <div className={css.emptyPreview}>{t('workbench.csvEmpty')}</div>
  return (
    <div className={css.csvWrap}>
      <table className={css.csvTable}>
        <thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}>{cell}</td>)}</tr>
        ))}</tbody>
      </table>
      {parsed.truncated && <div className={css.previewNotice}>{t('workbench.csvTruncated')}</div>}
    </div>
  )
}

/** Package-internal unified-diff presentation, exported for direct component accounting. */
export function DiffPreview({ content }: { content: string }) {
  return (
    <pre className={css.diffPreview}>
      {content.split('\n').map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---')
          ? 'header'
          : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : line.startsWith('@@') ? 'range' : undefined
        return <span key={index} data-kind={kind}>{line}{'\n'}</span>
      })}
    </pre>
  )
}

/** Package-internal document-tab presentation, exported for direct component accounting. */
export function TabStrip(props: {
  tabs: WorkbenchTab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  t: WorkbenchTranslate
}) {
  return (
    <div className={css.tabStrip} role="tablist" tabIndex={-1} aria-label={props.t('workbench.tabsAria')}>
      {props.tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={css.documentTab}
          data-active={props.activeTabId === tab.id || undefined}
        >
          <button
            type="button"
            id={`workspace-workbench-tab-${encodeURIComponent(tab.id)}`}
            role="tab"
            aria-controls="workspace-workbench-panel"
            aria-selected={props.activeTabId === tab.id}
            tabIndex={props.activeTabId === tab.id ? 0 : -1}
            className={css.tabSelect}
            onClick={() => { props.onSelect(tab.id) }}
            onKeyDown={(event) => {
              let next = index
              if (event.key === 'ArrowLeft') next = (index + props.tabs.length - 1) % props.tabs.length
              else if (event.key === 'ArrowRight') next = (index + 1) % props.tabs.length
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = props.tabs.length - 1
              else return
              event.preventDefault()
              const nextTab = props.tabs[next]
              /* v8 ignore next -- navigation derives an in-range index from the rendered non-empty tab list. */
              if (nextTab === undefined) throw new Error('tab navigation produced an invalid index')
              props.onSelect(nextTab.id)
              event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
            }}
          >
            <span>{tab.title}</span>
            {tab.loading && <span className={css.loadingDot} aria-label={props.t('workbench.tabLoading')} />}
          </button>
          <button
            type="button"
            aria-label={props.t('workbench.tabClose', { name: tab.title })}
            className={css.tabClose}
            onClick={(event) => {
              const tablist = event.currentTarget.closest<HTMLElement>('[role="tablist"]') as HTMLElement
              const nextIndex = Math.min(index, props.tabs.length - 2)
              props.onClose(tab.id)
              queueMicrotask(() => {
                if (nextIndex >= 0) tablist.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus()
                else tablist.focus()
              })
            }}
          ><IconCloseOutline16 size={12} /></button>
        </div>
      ))}
    </div>
  )
}

/** Package-internal preview dispatcher, exported for direct component accounting. */
export function FilePreview({ tab, onBack, t }: { tab: WorkbenchTab | undefined; onBack: () => void; t: WorkbenchTranslate }) {
  const objectUrl = useObjectUrl(tab)
  if (tab === undefined) {
    return (
      <div className={css.emptyPreview}>
        <div className={css.emptyMark}>W</div>
        <strong>{t('workbench.previewEmptyTitle')}</strong>
        <span>{t('workbench.previewEmptyDescription')}</span>
      </div>
    )
  }
  let body
  if (tab.loading) body = <div className={css.emptyPreview}>{t('workbench.previewReading', { name: tab.title })}</div>
  else if (tab.error !== undefined) body = <div className={css.previewError}>{tab.error}</div>
  else if (tab.content === undefined && objectUrl === undefined) body = <div className={css.emptyPreview}>{t('workbench.previewUnavailable')}</div>
  else {
    const content = tab.content as string
    switch (tab.kind) {
      case 'markdown': body = <article className={css.markdownPreview}><MarkdownText text={content} /></article>; break
      case 'html': body = <iframe className={css.htmlPreview} title={tab.title} sandbox="" referrerPolicy="no-referrer" srcDoc={content} />; break
      case 'code': body = <div className={css.codePreview}><CodeBlock code={content} lang={tab.language} /></div>; break
      case 'text': body = <pre className={css.textPreview}>{tab.content}</pre>; break
      case 'csv': body = <CsvTable content={content} t={t} />; break
      case 'diff': body = <DiffPreview content={content} />; break
      case 'image': body = <div className={css.imagePreview}><img src={objectUrl} alt={tab.title} /></div>; break
      case 'pdf': body = <iframe className={css.pdfPreview} title={tab.title} sandbox="" src={objectUrl} />; break
    }
  }
  return (
    <div
      id="workspace-workbench-panel"
      className={css.previewPane}
      role="tabpanel"
      aria-labelledby={`workspace-workbench-tab-${encodeURIComponent(tab.id)}`}
    >
      <div className={css.previewHeader}>
        <button type="button" className={css.mobileBack} aria-label={t('workbench.previewBack')} onClick={onBack}><IconChevronLeftOutline14 /></button>
        <span title={tab.path}>{tab.path}</span>
        {tab.bytes !== undefined && <small>{tab.bytes.toLocaleString()} B</small>}
      </div>
      <div className={css.previewBody}>{body}</div>
      {tab.truncated && <div className={css.previewNotice}>{t('workbench.previewTruncated')}</div>}
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
  const [mobilePreview, setMobilePreview] = useState(false)

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
      setMobilePreview(true)
      return
    }
    const descriptor = previewType(entry.path)
    const pending: WorkbenchTab = {
      id, path: entry.path, title: entry.name, kind: descriptor.kind, loading: true,
      ...(descriptor.language === undefined ? {} : { language: descriptor.language }),
    }
    props.actions.openTab(workspaceId, pending)
    setMobilePreview(true)
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
      setMobilePreview(true)
      return
    }
    const pending: WorkbenchTab = {
      id,
      path: entry.path,
      title: props.t(staged ? 'workbench.diffStaged' : 'workbench.diffChanged', { name: basename(entry.path) }),
      kind: 'diff', language: 'diff', loading: true,
    }
    props.actions.openTab(workspaceId, pending)
    setMobilePreview(true)
    runRequest(
      signal => props.gitDiff(workspace.workspaceId, entry.path, staged, signal),
      (value) => { props.actions.updateTab(workspaceId, { ...pending, content: value.diff, truncated: value.truncated, loading: false }) },
      (error) => { props.actions.updateTab(workspaceId, { ...pending, loading: false, error }) },
      `tab:${id}`,
    )
  }, [account, props.actions, props.gitDiff, props.t, runRequest, workspace, workspaceId])

  const query = account?.search.query ?? ''
  const deferredQuery = useDeferredValue(query)
  useEffect(() => {
    if (workspaceId === undefined || workspace === undefined || account?.section !== 'search' || query !== deferredQuery) return
    const needle = deferredQuery.trim()
    if (needle === '') return
    props.actions.setSearch(workspaceId, { query, entries: [], truncated: false, loading: true })
    let cancel = (): void => {}
    const timer = window.setTimeout(() => {
      cancel = runRequest(
        signal => props.searchFiles(workspace.workspaceId, needle, signal),
        (value) => { props.actions.setSearch(workspaceId, { query, ...value, loading: false }) },
        (error) => { props.actions.setSearch(workspaceId, { query, entries: [], truncated: false, loading: false, error }) },
        'search',
      )
    }, 180)
    return () => { window.clearTimeout(timer); cancel() }
  }, [account?.section, deferredQuery, props.actions, props.searchFiles, query, runRequest, workspace, workspaceId])

  const selectSection = (section: WorkbenchSection): void => {
    /* v8 ignore next -- section controls render only after a Workspace resolves. */
    if (workspaceId === undefined) return
    props.actions.setSection(workspaceId, section)
    setMobilePreview(false)
  }

  if (workspace === undefined || workspaceId === undefined) {
    return (
      <aside className={css.root} aria-label={props.t('workbench.aria')}>
        <header className={css.header}><strong>{props.t('workbench.label')}</strong><button type="button" aria-label={props.t('workbench.close')} onClick={props.closeWorkbench}><IconCloseOutline16 /></button></header>
        <div className={css.emptyPreview}>{props.t('workbench.noWorkspace')}</div>
      </aside>
    )
  }

  const section = account?.section ?? 'files'
  const directories = account?.directories ?? {}
  const expanded = account?.expandedDirectories ?? { '': true }
  const search = account?.search ?? { query: '', entries: [], truncated: false, loading: false }
  const git = account?.git
  /* v8 ignore next -- the changes section exists only on an initialized default account. */
  const gitArea = account?.gitArea ?? 'worktree'
  return (
    <aside
      className={css.root}
      aria-label={props.t('workbench.aria')}
      data-mobile-preview={mobilePreview && activeTab !== undefined || undefined}
    >
      <header className={css.header}>
        <div><span>{props.t('workbench.label')}</span><strong title={workspace.path}>{workspace.title}</strong></div>
        <button type="button" aria-label={props.t('workbench.close')} onClick={props.closeWorkbench}><IconCloseOutline16 /></button>
      </header>
      <div className={css.workbenchBody}>
        <nav className={css.activityBar} aria-label={props.t('workbench.tools')}>
          <button type="button" data-active={section === 'files' || undefined} aria-pressed={section === 'files'} onClick={() => { selectSection('files') }}><IconFolderOpen16 /><span>{props.t('workbench.files')}</span></button>
          <button type="button" data-active={section === 'search' || undefined} aria-pressed={section === 'search'} onClick={() => { selectSection('search') }}><IconSearchOutline16 /><span>{props.t('workbench.search')}</span></button>
          <button type="button" data-active={section === 'changes' || undefined} aria-pressed={section === 'changes'} onClick={() => { selectSection('changes') }}><IconBranchOutline16 /><span>{props.t('workbench.changes')}</span></button>
        </nav>
        <section className={css.navigator} aria-label={props.t('workbench.navigation')}>
          <div className={css.navigatorTitle}>
            <strong>{section === 'files' ? props.t('workbench.files') : section === 'search' ? props.t('workbench.search') : props.t('workbench.sourceControl')}</strong>
            {section === 'files' && <button type="button" aria-label={props.t('workbench.refreshFiles')} onClick={() => { loadDirectory('') }}><IconRefreshOutline16 /></button>}
          </div>
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
                {...search}
                t={props.t}
                onQuery={(next) => {
                  props.actions.setSearch(workspaceId, { query: next, entries: [], truncated: false, loading: false })
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
        <main className={css.documentArea}>
          <TabStrip
            tabs={account?.tabs ?? []}
            activeTabId={account?.activeTabId ?? null}
            t={props.t}
            onSelect={(id) => { props.actions.selectTab(workspaceId, id); setMobilePreview(true) }}
            onClose={(id) => { props.actions.closeTab(workspaceId, id) }}
          />
          <FilePreview tab={activeTab} t={props.t} onBack={() => { setMobilePreview(false) }} />
        </main>
      </div>
    </aside>
  )
}
