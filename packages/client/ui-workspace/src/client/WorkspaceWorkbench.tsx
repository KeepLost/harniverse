import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconBranchOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconChevronUpOutline14, IconCloseOutline16, IconFolderClose16, IconFolderOpen16,
  IconPlusOutline16, IconProjectAddOutline16, IconRefreshOutline16, IconRightUpOutline16,
  IconSearchOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  IWorkspaces, WorkspaceFileEntry, WorkspaceGitCommit, WorkspaceGitCommitFile, WorkspaceGitCommitRef,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ChangeFeed, resolveWorkspacePath } from '@deepseek-ai/dsh-client-runtime/client'
import type { PreviewDocumentOwnerProps, WorkspacePreviewOverlayProps, WorkspaceWorkbenchProps } from './contract/slots.ts'
import type {
  WorkbenchCommitFiles, WorkbenchDirectory, WorkbenchGitArea, WorkbenchSearch, WorkbenchSection,
  WorkbenchTab,
} from './stores.ts'
import { previewType } from './preview-kind.ts'
import {
  GRAPH_SWIMLANE_HEIGHT, commitGraphPlaceholderShapes, commitGraphRowShapes, layoutCommitGraph,
} from './git-graph.ts'
import type { CommitGraphRow } from './git-graph.ts'
import { WorkbenchPreview } from './WorkbenchPreview.tsx'
import type { EditorSeat } from './WorkbenchPreview.tsx'
import css from './WorkspaceWorkbench.module.css'

type WorkbenchTranslate = WorkspaceWorkbenchProps['t']
type TextRead = Awaited<ReturnType<IWorkspaces['readFile']>>

/** Section tabs in render order; the glyph is the affordance on a narrow region. */
const SECTIONS: ReadonlyArray<{ section: WorkbenchSection; labelKey: 'workbench.files' | 'workbench.search' | 'workbench.changes' }> = [
  { section: 'files', labelKey: 'workbench.files' },
  { section: 'changes', labelKey: 'workbench.changes' },
  { section: 'search', labelKey: 'workbench.search' },
]

/** Debounce for session-activity revalidation: one pass per event burst. */
const WORKBENCH_REVALIDATE_DEBOUNCE_MS = 500

/** History page size: how many commits one load-more request extends the window by. */
const GIT_HISTORY_PAGE = 50

/**
 * History window ceiling, mirroring the host-side request bound
 * (WORKSPACE_GIT_COMMIT_LIMIT in packages/host/apiproxy) so the load-more
 * control can stop offering pages the server would clip anyway.
 */
const GIT_HISTORY_MAX = 500

function basename(path: string): string {
  /* v8 ignore next -- split always returns at least one element, including for an empty string. */
  return path.split('/').pop() ?? path
}

/** Tab id the workbench gives one opened file. */
function fileTabId(path: string): string {
  return `file:${path}`
}

/** The tab a finished text read of one file yields, with the decode facts the read reported. */
function readTab(path: string, value: TextRead): WorkbenchTab {
  const descriptor = previewType(path)
  return {
    id: fileTabId(path), path, title: basename(path), kind: descriptor.kind, loading: false,
    ...(descriptor.language === undefined ? {} : { language: descriptor.language }),
    content: value.content, bytes: value.bytes, truncated: value.truncated,
    encoding: value.encoding, encodingSource: value.encodingSource, bom: value.bom, eol: value.eol,
  }
}

function extension(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

/** Directory-prefix of one tree path: `a/b/c.md` yields `a/b`, a root file yields `''`. */
function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** Inline tree-row input for exclusive file/folder creation, VS Code explorer style. */
function TreeCreateInput(props: {
  mode: 'file' | 'directory'
  busy: boolean
  error?: string
  inset: number
  t: WorkbenchTranslate
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  useEffect(() => { inputRef.current?.focus() }, [])
  const submit = (): void => {
    if (props.busy) return
    if (value.trim() === '') {
      cancelled.current = true
      props.onCancel()
      return
    }
    props.onSubmit(value)
  }
  return (
    <div className={css.treeCreate} style={{ paddingLeft: `${String(props.inset)}px` }}>
      <input
        ref={inputRef}
        type="text"
        className={css.treeCreateInput}
        value={value}
        placeholder={props.t(props.mode === 'file' ? 'workbench.createFileName' : 'workbench.createFolderName')}
        aria-label={props.t(props.mode === 'file' ? 'workbench.createFileAria' : 'workbench.createFolderAria')}
        disabled={props.busy}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => { setValue(event.currentTarget.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            // The inline input owns Escape while it exists: stopping the
            // native propagation keeps the drawer/preview dismissal layers
            // (document and window capture) from also reacting.
            event.stopPropagation()
            cancelled.current = true
            props.onCancel()
          }
        }}
        onBlur={() => { if (!cancelled.current) submit() }}
        data-workbench-create
      />
      {props.busy && <span className={css.treeCreateStatus}>{props.t('workbench.createBusy')}</span>}
      {props.error !== undefined && <div className={css.navError} role="alert">{props.error}</div>}
    </div>
  )
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
  /** Whether the connected Host can open paths with a native application. */
  canOpenPath: boolean
  /** Pending inline creation inside this tree, when its directory is the target. */
  createDraft?: { directoryPath: string; mode: 'file' | 'directory'; busy: boolean; error?: string }
  t: WorkbenchTranslate
  onToggle: (path: string) => void
  onOpen: (entry: WorkspaceFileEntry) => void
  /** Open one file with the Host's default application. */
  onOpenExternal: (entry: WorkspaceFileEntry) => void
  onCreateSubmit: (name: string) => void
  onCreateCancel: () => void
}) {
  const directory = props.directories[props.path]
  const draft = props.createDraft?.directoryPath === props.path ? props.createDraft : undefined
  const draftInput = draft === undefined ? null : (
    <TreeCreateInput
      mode={draft.mode}
      busy={draft.busy}
      {...(draft.error === undefined ? {} : { error: draft.error })}
      inset={8 + (props.depth + 1) * 22 - 14}
      t={props.t}
      onSubmit={props.onCreateSubmit}
      onCancel={props.onCreateCancel}
    />
  )
  if (directory === undefined || directory.loading) {
    return <>{draftInput}<div className={css.navStatus}>{props.t('workbench.directoryLoading')}</div></>
  }
  if (directory.error !== undefined) {
    return <>{draftInput}<div className={css.navError}>{directory.error}</div></>
  }
  return (
    <>
      {draftInput}
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
          <div key={entry.path} className={css.treeRowWrap}>
            <button
              type="button"
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
            {props.canOpenPath && (
              <button
                type="button"
                className={css.treeRowAction}
                aria-label={props.t('workbench.openExternal', { name: entry.name })}
                onClick={() => { props.onOpenExternal(entry) }}
              ><IconRightUpOutline16 size={14} /></button>
            )}
          </div>
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
  /** Slot contribution rendered at the result list's end, inside its scroll. */
  panel?: ReactNode
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
      <div className={css.searchHeader}>
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
      </div>
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
        {props.panel}
      </div>
      {props.truncated && <div className={css.navStatus}>{props.t('workbench.fileSearchTruncated')}</div>}
    </div>
  )
}

/** Static lane palette classes; indices come from {@link layoutCommitGraph}. */
const GRAPH_LANE_CLASSES = [
  'lane0', 'lane1', 'lane2', 'lane3', 'lane4', 'lane5', 'lane6',
] as const

/** Horizontal padding aligning the graph's lane x across rows and details. */
const GRAPH_GUTTER_PADDING = 8

/** Static ref-badge classes keyed by decoration kind. */
const REF_CLASSES: Record<WorkspaceGitCommitRef['kind'], string | undefined> = {
  head: 'refHead',
  local: 'refLocal',
  remote: 'refRemote',
  tag: 'refTag',
  other: 'refOther',
}

/** One commit row's graph cell, drawn from the row's pure geometry. */
function CommitGraphGutter(props: { shapes: ReturnType<typeof commitGraphRowShapes> }) {
  return (
    <svg
      className={css.commitGraph}
      width={props.shapes.width}
      height={props.shapes.height}
      viewBox={`0 0 ${String(props.shapes.width)} ${String(props.shapes.height)}`}
      aria-hidden="true"
      focusable="false"
    >
      {props.shapes.paths.map((path, index) => (
        <path
          key={index}
          className={css[GRAPH_LANE_CLASSES[path.color] as string]}
          d={path.d}
          strokeWidth={path.strokeWidth}
        />
      ))}
      {props.shapes.circles.map((circle, index) => (
        <circle
          key={index}
          className={css[GRAPH_LANE_CLASSES[circle.color] as string]}
          data-fill={circle.fill}
          cx={circle.cx}
          cy={circle.cy}
          r={circle.r}
          strokeWidth={circle.strokeWidth}
        />
      ))}
    </svg>
  )
}

/** Lane gutter filling an expanded commit's detail: the lanes keep flowing. */
function CommitGraphContinuation(props: { shapes: ReturnType<typeof commitGraphPlaceholderShapes> }) {
  return (
    <div
      className={css.commitGraphGap}
      style={{ width: `${String(props.shapes.width + GRAPH_GUTTER_PADDING)}px` }}
    >
      <svg
        className={css.commitGraphGapSvg}
        width={props.shapes.width}
        height={GRAPH_SWIMLANE_HEIGHT}
        viewBox={`0 0 ${String(props.shapes.width)} ${String(GRAPH_SWIMLANE_HEIGHT)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {props.shapes.lines.map((line, index) => (
          <path
            key={index}
            className={css[GRAPH_LANE_CLASSES[line.color] as string]}
            data-emphasized={line.emphasized || undefined}
            d={`M ${String(line.x)} 0 V ${String(GRAPH_SWIMLANE_HEIGHT)}`}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  )
}

/** Package-internal Git navigation presentation, exported for direct component accounting. */
export function ChangesPanel(props: {
  area: WorkbenchGitArea
  branch: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  statusEntries: Array<{ path: string; indexStatus: string; worktreeStatus: string; originalPath?: string }>
  commits: WorkspaceGitCommit[]
  commitFiles: Record<string, WorkbenchCommitFiles>
  expandedCommits: Record<string, boolean>
  loading: boolean
  truncated: boolean
  /** Whether the history window ends before the branch root. */
  historyTruncated: boolean
  error?: string
  /** Slot contribution rendered at the history's end, inside its scroll. */
  panel?: ReactNode
  t: WorkbenchTranslate
  onArea: (area: WorkbenchGitArea) => void
  onRefresh: () => void
  /** Refetch history at the requested window depth, as computed by the panel. */
  onLoadMore: (depth: number) => void
  onOpenDiff: (entry: { path: string; indexStatus: string; worktreeStatus: string }) => void
  onOpenFile: (entry: WorkspaceFileEntry) => void
  onToggleCommit: (hash: string) => void
  onOpenCommitDiff: (commit: WorkspaceGitCommit, file: WorkspaceGitCommitFile) => void
}) {
  const changed = props.statusEntries.filter(entry => props.area === 'staged'
    ? entry.indexStatus !== ' ' && entry.indexStatus !== '?'
    : entry.worktreeStatus !== ' ')
  const graph = useMemo(() => layoutCommitGraph(props.commits), [props.commits])
  const ahead = props.ahead ?? 0
  const behind = props.behind ?? 0
  const diverged = props.upstream !== null && (ahead > 0 || behind > 0)
  return (
    <div className={css.changesPanel}>
      <div className={css.changesHeader}>
        <div className={css.gitHeader}>
          <span>{props.branch === null ? props.t('workbench.gitChanges') : props.t('workbench.gitBranch', { name: props.branch })}</span>
          {diverged && (
            <span className={css.gitDiverged}>
              {props.t('workbench.gitDiverged', { ahead: String(ahead), behind: String(behind) })}
            </span>
          )}
          <button type="button" className={css.iconButton} aria-label={props.t('workbench.gitRefresh')} title={props.t('workbench.gitRefresh')} onClick={props.onRefresh}><IconRefreshOutline16 /></button>
        </div>
        <div className={css.segmented}>
          <button type="button" data-active={props.area === 'worktree' || undefined} aria-pressed={props.area === 'worktree'} onClick={() => { props.onArea('worktree') }}>{props.t('workbench.gitWorktree')}</button>
          <button type="button" data-active={props.area === 'staged' || undefined} aria-pressed={props.area === 'staged'} onClick={() => { props.onArea('staged') }}>{props.t('workbench.gitStaged')}</button>
        </div>
      </div>
      {props.loading && <div className={css.navStatus}>{props.t('workbench.gitLoading')}</div>}
      {props.error !== undefined && <div className={css.navError}>{props.error}</div>}
      {!props.loading && props.error === undefined && changed.length === 0 && <div className={css.navStatus}>{props.t('workbench.gitEmpty')}</div>}
      <div className={css.changesScroll}>
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
          {props.commits.map((commit, index) => {
            const row = graph[index] as CommitGraphRow
            const files = props.commitFiles[commit.hash]
            const expanded = props.expandedCommits[commit.hash] === true
            return (
              <div key={commit.hash} className={css.commitEntry}>
                <button
                  type="button"
                  className={css.commitRow}
                  aria-expanded={expanded}
                  aria-label={props.t('workbench.gitCommitExpand', { hash: commit.shortHash })}
                  data-head={row.head || undefined}
                  title={`${commit.subject} — ${commit.authorName} ${commit.shortHash} ${commit.authoredAt.slice(0, 10)}`}
                  onClick={() => { props.onToggleCommit(commit.hash) }}
                >
                  <CommitGraphGutter shapes={commitGraphRowShapes(row)} />
                  <span className={css.commitMain}>
                    <span className={css.commitSubject}>{commit.subject}</span>
                    <span className={css.commitAuthor}>{commit.authorName}</span>
                    {commit.refs.map(ref => (
                      <span
                        key={`${ref.kind}:${ref.name}`}
                        className={clsx(css.refBadge, css[REF_CLASSES[ref.kind] as string], ref.current ? css.refCurrent : undefined)}
                        title={props.t(`workbench.ref${ref.kind.charAt(0).toUpperCase()}${ref.kind.slice(1)}` as never)}
                      >{ref.kind === 'head' ? 'HEAD' : ref.name}</span>
                    ))}
                  </span>
                </button>
                {expanded && (
                  <div className={css.commitDetail}>
                    <CommitGraphContinuation shapes={commitGraphPlaceholderShapes(row)} />
                    <div className={css.commitDetailBody}>
                      <div className={css.commitDetailMeta}>
                        <span>{commit.authorName} <span>{`<${commit.authorEmail}>`}</span></span>
                        <code>{commit.hash}</code>
                        <time dateTime={commit.authoredAt}>{commit.authoredAt}</time>
                      </div>
                      {(files === undefined || files.loading) && <div className={css.navStatus}>{props.t('workbench.gitCommitFilesLoading')}</div>}
                      {files?.error !== undefined && <div className={css.navError}>{files.error}</div>}
                      {files !== undefined && files.error === undefined && !files.loading && files.files.length === 0
                        && <div className={css.navStatus}>{props.t('workbench.gitCommitFilesEmpty')}</div>}
                      <div className={css.commitFileList}>
                        {(files?.files ?? []).map(file => (
                          <button
                            type="button"
                            key={`${file.status}:${file.path}`}
                            className={css.commitFileRow}
                            data-workbench-focus-path={file.path}
                            onClick={() => { props.onOpenCommitDiff(commit, file) }}
                          >
                            <span className={css.changeStatus} data-status={file.status}>{file.status}</span>
                            <span title={file.path}>{file.path}</span>
                            {file.previousPath !== undefined && <span className={css.commitFileOld}>{file.previousPath}</span>}
                          </button>
                        ))}
                      </div>
                      {files?.truncated === true && <div className={css.navStatus}>{props.t('workbench.gitCommitFilesTruncated')}</div>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {props.historyTruncated && (props.commits.length >= GIT_HISTORY_MAX
          ? <div className={css.navStatus}>{props.t('workbench.gitTruncated')}</div>
          : (
            <button
              type="button"
              className={css.loadMore}
              disabled={props.loading}
              onClick={() => { props.onLoadMore(Math.min(props.commits.length + GIT_HISTORY_PAGE, GIT_HISTORY_MAX)) }}
            >
              {props.t('workbench.gitLoadMore')}
            </button>
          ))}
        {props.panel}
      </div>
    </div>
  )
}

/** Editor-occupant seat plus the dirty-document guard shared by both preview placements. */
interface PreviewDocumentGuard {
  /** The seat threaded into the preview; undefined while no Workspace resolves or the hole is unoccupied. */
  seat: EditorSeat | undefined
  /** Whether closing one document may proceed; a dirty document confirms first. */
  confirmPath: (path: string | undefined, title: string) => boolean
  /** Dismiss the preview; a dirty active document confirms first. */
  guardedDismiss: (active: WorkbenchTab | undefined) => void
}

/**
 * Gate every close path behind one confirmation over the Workspace account's
 * unsaved-edit facts. The facts live in the shared store, so both placements
 * agree on them and they stand while the occupant is unmounted (Preview mode,
 * another tab, the other placement).
 */
function usePreviewDocumentGuard(options: {
  workspaceId: string | undefined
  placement: 'overlay' | 'in-column'
  occupied: boolean
  renderPreviewDocument: (owner: PreviewDocumentOwnerProps) => ReactNode
  /** Unsaved-edit facts of the Workspace account, keyed by tab id. */
  dirtyTabs: Record<string, true> | undefined
  actions: Pick<WorkspaceWorkbenchProps['actions'], 'setDocumentDirty'>
  /** Re-read one saved file so the rendered preview shows its saved text. */
  refreshSaved: (path: string) => void
  t: WorkbenchTranslate
  dismiss: () => void
}): PreviewDocumentGuard {
  const { t, dismiss, dirtyTabs, actions, workspaceId } = options
  const isDirty = useCallback((path: string) => dirtyTabs?.[fileTabId(path)] === true, [dirtyTabs])
  const confirmPath = useCallback((path: string | undefined, title: string) => {
    if (path === undefined || !isDirty(path)) return true
    return window.confirm(t('workbench.dirtyConfirm', { name: title }))
  }, [isDirty, t])
  const guardedDismiss = useCallback((active: WorkbenchTab | undefined) => {
    if (active !== undefined && !confirmPath(active.path, active.title)) return
    dismiss()
  }, [confirmPath, dismiss])
  const seat: EditorSeat | undefined = workspaceId === undefined || !options.occupied ? undefined : {
    workspaceId,
    placement: options.placement,
    render: owner => options.renderPreviewDocument(owner),
    isDirty,
    onDirtyChange: (path, dirty) => { actions.setDocumentDirty(workspaceId, fileTabId(path), dirty) },
    onSaved: options.refreshSaved,
    onRequestClose: (path, title) => {
      if (!confirmPath(path, title)) return
      dismiss()
    },
  }
  return { seat, confirmPath, guardedDismiss }
}

/** Top-level read-only Workspace workbench occupying the shell's workbench slot. */
export function WorkspaceWorkbench(props: WorkspaceWorkbenchProps) {
  const sessionId = props.useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current] !== undefined ? current : undefined
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
  const activeMode = activeTab === undefined ? undefined : account?.previewMode[activeTab.id]
  const runRequest = useRequestFence(workspaceId)
  const canOpenPath = props.useCanOpenPath(capable => capable)
  // Inline tree creation state: target directory follows the last tree row
  // the operator interacted with (an opened file's parent, an expanded
  // directory), defaulting to the workspace root.
  const [createDraft, setCreateDraft] = useState<{ mode: 'file' | 'directory'; directoryPath: string; busy: boolean; error?: string } | undefined>(undefined)
  const lastDirectoryRef = useRef('')
  useEffect(() => { setCreateDraft(undefined) }, [workspaceId])
  const openExternal = useCallback((relativePath: string) => {
    /* v8 ignore next -- file actions render only after a Workspace account resolves. */
    if (workspace === undefined) return
    // Open failures are non-fatal diagnostics; the tree and preview stay usable.
    void props.openPath(resolveWorkspacePath(workspace.path, relativePath)).catch((error: unknown) => {
      console.warn('open in default application failed:', error)
    })
  }, [props.openPath, workspace])

  useEffect(() => {
    if (retainedWorkspaces !== null) {
      props.actions.retainWorkspaces(retainedWorkspaces.map(item => item.workspaceId as string))
    }
  }, [props.actions, retainedWorkspaces])

  useEffect(() => {
    if (workspaceId !== undefined) props.actions.ensureWorkspace(workspaceId)
  }, [props.actions, workspaceId])

  const loadDirectory = useCallback((path: string, silent = false) => {
    /* v8 ignore next -- no navigation or root-load effect renders without a resolved Workspace. */
    if (workspaceId === undefined || workspace === undefined) return
    if (!silent) props.actions.setDirectory(workspaceId, path, { entries: [], truncated: false, loading: true })
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

  // Open file tabs cache their read. These silent re-reads keep the preview
  // in step with writes the workbench did not make itself (agent edits,
  // outside processes): no loading flash, the rendered content swaps in only
  // when the fresh read lands. Dirty documents keep their stale notice, an
  // in-flight or failed read is left to its own flow, and immutable diff
  // tabs are never re-read.
  const rereadTab = useCallback((tab: WorkbenchTab) => {
    /* v8 ignore next -- file tabs render only after a Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    if (tab.loading || tab.error !== undefined) return
    if (account?.documentDirty[tab.id] === true) return
    if (tab.kind === 'image' || tab.kind === 'pdf') {
      runRequest(
        signal => props.readBinaryFile(workspace.workspaceId, tab.path, signal),
        (value) => {
          props.actions.updateTab(workspaceId, { ...tab, dataBase64: value.dataBase64, mediaType: value.mediaType, bytes: value.bytes })
        },
        (error) => { console.warn('silent re-read failed:', error) },
        `tab:${tab.id}`,
      )
      return
    }
    // An explicitly chosen encoding survives the re-read; every other source
    // re-resolves (sticky encodings live Host-side).
    const encoding = tab.encodingSource === 'explicit' && tab.encoding !== undefined ? { encoding: tab.encoding } : undefined
    runRequest(
      signal => props.readFile(workspace.workspaceId, tab.path, encoding, signal),
      (value) => {
        props.actions.updateTab(workspaceId, {
          ...tab,
          content: value.content, bytes: value.bytes, truncated: value.truncated,
          encoding: value.encoding, encodingSource: value.encodingSource, bom: value.bom, eol: value.eol,
        })
      },
      (error) => { console.warn('silent re-read failed:', error) },
      `tab:${tab.id}`,
    )
  }, [account?.documentDirty, props.actions, props.readBinaryFile, props.readFile, runRequest, workspace, workspaceId])
  /**
   * Re-read open file tabs, scoped to one directory's immediate children.
   * @param directoryPath - Restrict to files directly inside this directory;
   * `undefined` re-reads every open file tab.
   */
  const rereadOpenFileTabs = useCallback((directoryPath?: string) => {
    const tabs = account?.tabs
    /* v8 ignore next -- the account is ensured on mount before any re-read trigger; only a mid-teardown click reaches here. */
    if (tabs === undefined) return
    for (const tab of tabs) {
      if (!tab.id.startsWith('file:')) continue
      if (directoryPath !== undefined) {
        const separator = tab.path.lastIndexOf('/')
        if ((separator === -1 ? '' : tab.path.slice(0, separator)) !== directoryPath) continue
      }
      rereadTab(tab)
    }
  }, [account?.tabs, rereadTab])

  // Live file-tree refresh: one watch subscription per expanded directory,
  // change bursts coalesced into silent relists. The feed lives per Workspace
  // generation; expansion changes reconcile its subscriptions. A Workspace
  // that exhausts the feed's stream retries lands in manual mode (store
  // field), leaving the manual refresh button as the only relist trigger.
  // The placeholder is replaced by the assignment below before any feed can
  // call it; it exists only so the ref's first read has a callable.
  /* v8 ignore next -- unreachable placeholder: overwritten before first call. */
  const relistDirectory = useRef((_path: string) => {})
  relistDirectory.current = (path: string) => {
    // The same change frame means open files directly in this directory may
    // hold new bytes; re-read them even when the directory was collapsed and
    // pruned, because their tabs outlive the listing.
    rereadOpenFileTabs(path)
    /* v8 ignore next -- a change frame can land after the directory collapsed
       and was pruned from the account; the late relist target is gone. */
    if (account?.directories[path] !== undefined) loadDirectory(path, true)
  }
  const watchFiles = props.watchFiles
  const feedRef = useRef<ChangeFeed | undefined>(undefined)
  useEffect(() => {
    const watchId = workspace?.workspaceId
    if (watchId === undefined || watchFiles === undefined) return
    const feed = new ChangeFeed({
      watch: watchFiles,
      // The id guards drop callbacks a previous generation's feed delivers
      // after the workspace switched underneath this effect.
      /* v8 ignore next -- generation race: only the prior generation's feed reports a foreign id. */
      onInvalidate: (id, path) => { if (id === watchId) relistDirectory.current(path) },
      /* v8 ignore next -- generation race, same source as onInvalidate. */
      onMode: (id, mode) => { if (id === watchId) props.actions.setFileWatch(watchId, mode) },
    })
    feedRef.current = feed
    return () => {
      /* v8 ignore next -- a newer generation already replaced the ref when an
         older effect's cleanup runs; only that generation owns the teardown. */
      if (feedRef.current === feed) feedRef.current = undefined
      feed.dispose()
    }
  }, [props.actions, watchFiles, workspaceId])
  const expandedDirectories = account?.expandedDirectories ?? { '': true }
  // Collapsed directories keep a `false` key in the map; only `true`
  // entries are expanded, and only those are watched.
  const expandedPaths = Object.keys(expandedDirectories).filter(path => expandedDirectories[path] === true)
  const expandedKey = expandedPaths.join('\u0000')
  useEffect(() => {
    const feed = feedRef.current
    const watchId = workspace?.workspaceId
    if (feed === undefined || watchId === undefined) return
    feed.sync(watchId, expandedPaths)
    // expandedPaths is read for the watch set; sync is idempotent for
    // unchanged directories.
  }, [expandedKey, workspaceId])

  const openFile = useCallback((entry: WorkspaceFileEntry) => {
    /* v8 ignore next -- file actions render only after a Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    const id = `file:${entry.path}`
    const existing = account?.tabs.find(tab => tab.id === id)
    if (existing !== undefined && existing.error === undefined) {
      props.actions.selectTab(workspaceId, id)
      // Re-clicking an open file is the tree's re-open gesture: re-read so
      // outside writes surface without leaving the tab.
      rereadTab(existing)
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
        signal => props.readFile(workspace.workspaceId, entry.path, undefined, signal),
        (value) => {
          props.actions.updateTab(workspaceId, {
            ...pending, content: value.content, bytes: value.bytes, truncated: value.truncated, loading: false,
            encoding: value.encoding, encodingSource: value.encodingSource, bom: value.bom, eol: value.eol,
          })
        },
        (error) => { props.actions.updateTab(workspaceId, { ...pending, loading: false, error }) },
        `tab:${id}`,
      )
    }
  }, [account?.tabs, props.actions, props.readBinaryFile, props.readFile, rereadTab, runRequest, workspace, workspaceId])

  // Inline creation flow: the input lands inside the target directory (VS
  // Code explorer semantics). Creates ride the workspaceFileWrite Remote
  // directly — writes never pass the read request fence — and the tree
  // reveals the created entry by expanding and relisting its directory chain.
  const startCreate = useCallback((mode: 'file' | 'directory') => {
    /* v8 ignore next -- creation renders only after a Workspace account resolves. */
    if (workspaceId === undefined) return
    const target = lastDirectoryRef.current
    props.actions.setDirectoryExpanded(workspaceId, target, true)
    // Silent relist: the input renders beside whatever the directory already
    // shows, and the listing refreshes without a loading flash.
    loadDirectory(target, true)
    setCreateDraft({ mode, directoryPath: target, busy: false })
  }, [loadDirectory, props.actions, workspaceId])
  const submitCreate = useCallback((name: string) => {
    /* v8 ignore next -- submission renders only with a pending draft. */
    if (workspaceId === undefined || workspace === undefined || createDraft === undefined || createDraft.busy) return
    const mode = createDraft.mode
    const base = createDraft.directoryPath
    const fullPath = base === '' ? name : `${base}/${name}`
    setCreateDraft({ mode, directoryPath: base, busy: true })
    // A late reply must not clobber a draft the operator started afterwards.
    const stillCurrent = (draft: { mode: 'file' | 'directory'; directoryPath: string; busy: boolean; error?: string } | undefined): boolean =>
      draft !== undefined && draft.mode === mode && draft.directoryPath === base && draft.busy
    const invoke = mode === 'file' ? props.createFile : props.createDirectory
    void invoke(workspace.workspaceId, fullPath).then((result) => {
      if (!result.ok) {
        setCreateDraft(draft => stillCurrent(draft)
          ? { mode, directoryPath: base, busy: false, error: result.error.code === 'exists' ? props.t('workbench.createExists') : result.error.message }
          : draft)
        return
      }
      setCreateDraft(draft => stillCurrent(draft) ? undefined : draft)
      const segments = fullPath.split('/')
      const directoryCount = mode === 'file' ? segments.length - 1 : segments.length
      let prefix = ''
      for (let index = 0; index < directoryCount; index++) {
        prefix = prefix === '' ? segments[index] as string : `${prefix}/${segments[index] as string}`
        props.actions.setDirectoryExpanded(workspaceId, prefix, true)
        loadDirectory(prefix, true)
      }
      loadDirectory(base, true)
      if (mode === 'file') openFile({ name: basename(fullPath), path: fullPath, kind: 'file' })
    })
  }, [createDraft, loadDirectory, openFile, props.actions, props.createDirectory, props.createFile, props.t, workspace, workspaceId])
  const cancelCreate = useCallback(() => { setCreateDraft(undefined) }, [])

  // "Reopen with encoding": re-reads one text tab with an explicit encoding
  // (or re-detects), keeping the tab identity so the surface does not move.
  const reopenWithEncoding = useCallback((entryPath: string, encoding: string | undefined) => {
    /* v8 ignore next -- the selector renders only after a Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    const id = `file:${entryPath}`
    const descriptor = previewType(entryPath)
    const pending: WorkbenchTab = {
      id, path: entryPath, title: basename(entryPath), kind: descriptor.kind, loading: true,
      ...(descriptor.language === undefined ? {} : { language: descriptor.language }),
      ...(encoding === undefined ? {} : { encoding, encodingSource: 'explicit' as const }),
    }
    props.actions.openTab(workspaceId, pending)
    runRequest(
      signal => props.readFile(workspace.workspaceId, entryPath, encoding === undefined ? undefined : { encoding }, signal),
      (value) => {
        props.actions.updateTab(workspaceId, {
          ...pending, content: value.content, bytes: value.bytes, truncated: value.truncated, loading: false,
          encoding: value.encoding, encodingSource: value.encodingSource, bom: value.bom, eol: value.eol,
        })
      },
      (error) => { props.actions.updateTab(workspaceId, { ...pending, loading: false, error }) },
      `tab:${id}`,
    )
  }, [props.actions, props.readFile, runRequest, workspace, workspaceId])

  // Re-read a file the editor just saved so the rendered preview shows the
  // saved text. Silent: the tab never enters the loading state, so the open
  // editor and the tab strip do not flash.
  const refreshSaved = useCallback((entryPath: string) => {
    /* v8 ignore next -- the editor occupant renders only after a Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    runRequest(
      signal => props.readFile(workspace.workspaceId, entryPath, undefined, signal),
      (value) => { props.actions.updateTab(workspaceId, readTab(entryPath, value)) },
      (error) => { console.warn('refresh after save failed:', error) },
      `tab:${fileTabId(entryPath)}`,
    )
  }, [props.actions, props.readFile, runRequest, workspace, workspaceId])

  // The history window re-fetches whole from HEAD at the requested depth:
  // topo-ordered lanes make an append cursor reorder-prone, while a replaced
  // wider window keeps the graph a pure function of the visible commits.
  const loadGit = useCallback((silent = false, depth?: number) => {
    /* v8 ignore next -- Git actions render only after an initialized Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    const loaded = account?.git?.commits.length ?? 0
    const limit = Math.min(depth ?? Math.max(loaded, GIT_HISTORY_PAGE), GIT_HISTORY_MAX)
    if (!silent) {
      // Keep the loaded rows visible under the loading state; a depth growth
      // or refresh replaces them only when the fresh window arrives.
      props.actions.setGit(workspaceId, {
        branch: null, upstream: null, ahead: null, behind: null, entries: [],
        commits: account?.git?.commits ?? [], loading: true, truncated: false, historyTruncated: false,
      })
    }
    runRequest(
      async (signal) => {
        const [status, history] = await Promise.allSettled([
          props.gitStatus(workspace.workspaceId, signal),
          props.gitCommits(workspace.workspaceId, limit, signal),
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
          truncated: status.truncated,
          historyTruncated: history.truncated,
        })
      },
      (error) => {
        props.actions.setGit(workspaceId, {
          branch: null, upstream: null, ahead: null, behind: null, entries: [], commits: [],
          loading: false, truncated: false, historyTruncated: false, error,
        })
      },
      'git',
    )
  }, [account?.git?.commits, props.actions, props.gitCommits, props.gitStatus, runRequest, workspace, workspaceId])

  // History commit expansion: first expansion loads the commit's changed-file
  // list through the read fence; later toggles only flip the row.
  const toggleCommit = useCallback((hash: string) => {
    /* v8 ignore next -- history renders only after an initialized Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    const next = !(account?.expandedCommits[hash] === true)
    props.actions.setCommitExpanded(workspaceId, hash, next)
    if (!next || account?.commitFiles[hash] !== undefined) return
    props.actions.setCommitFiles(workspaceId, hash, { files: [], truncated: false, loading: true })
    runRequest(
      signal => props.gitCommitFiles(workspace.workspaceId, hash, signal),
      (value) => { props.actions.setCommitFiles(workspaceId, hash, { files: value.files, truncated: value.truncated, loading: false }) },
      (error) => { props.actions.setCommitFiles(workspaceId, hash, { files: [], truncated: false, loading: false, error }) },
      `commitFiles:${hash}`,
    )
  }, [account?.commitFiles, account?.expandedCommits, props.actions, props.gitCommitFiles, runRequest, workspace, workspaceId])

  /** Read-only diff of one file inside one history commit. */
  const openCommitDiff = useCallback((commit: WorkspaceGitCommit, file: WorkspaceGitCommitFile) => {
    /* v8 ignore next -- file rows render only after an initialized Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    const id = `diff:commit:${commit.hash}:${file.path}`
    const existing = account?.tabs.find(tab => tab.id === id)
    if (existing !== undefined && existing.error === undefined) {
      props.actions.selectTab(workspaceId, id)
      return
    }
    const pending: WorkbenchTab = {
      id,
      path: file.path,
      title: props.t('workbench.diffCommit', { name: basename(file.path), hash: commit.shortHash }),
      kind: 'diff', language: 'diff', loading: true,
    }
    props.actions.openTab(workspaceId, pending)
    runRequest(
      signal => props.gitCommitDiff(workspace.workspaceId, commit.hash, file.path, signal),
      (value) => { props.actions.updateTab(workspaceId, { ...pending, content: value.diff, truncated: value.truncated, loading: false }) },
      (error) => { props.actions.updateTab(workspaceId, { ...pending, loading: false, error }) },
      `tab:${id}`,
    )
  }, [account?.tabs, props.actions, props.gitCommitDiff, props.t, runRequest, workspace, workspaceId])

  const gitMissing = props.section === 'changes' && account !== undefined && account.git === null
  useEffect(() => {
    if (gitMissing) loadGit()
  }, [gitMissing, loadGit])

  // Session-activity revalidation: every settled turn event (user prompt,
  // completed assistant message, tool round trip, turn boundary) bumps the
  // owning summary's updatedAt in the list store, so the latest updatedAt
  // across sessions whose cwd is this Workspace's path is a cheap O(sessions)
  // staleness watermark that moves at step granularity — never per streamed
  // chunk. When it advances past the watermark already reflected in the
  // loaded directories/Git data, both surfaces re-fetch after a short
  // debounce. Reloads are silent — the previous entries stay rendered until
  // the fresh snapshot swaps in.
  // ponytail: this reacts to session events only; edits made by outside
  // processes never move the watermark and need the manual refresh buttons.
  // Upgrade path: a Host-side workspace fs watcher pushing an invalidation
  // frame over the mux stream.
  const workspaceActivity = props.useSessions((state) => {
    if (workspace === undefined) return 0
    let latest = 0
    for (const summary of Object.values(state.byId)) {
      if (summary.cwd === workspace.path && summary.updatedAt > latest) latest = summary.updatedAt
    }
    return latest
  })
  const refreshLoaded = useCallback(() => {
    /* v8 ignore next -- revalidation runs only after an account with data resolves. */
    if (workspaceId === undefined || account === undefined) return
    for (const path of Object.keys(account.directories)) loadDirectory(path, true)
    // Session activity (agent tool writes land here) also re-reads the open
    // file tabs, not just the listings.
    rereadOpenFileTabs()
    if (account.git !== null) loadGit(true)
  }, [account, loadDirectory, loadGit, rereadOpenFileTabs, workspaceId])
  const revalidationReady = account !== undefined
    && (Object.keys(account.directories).length > 0 || account.git !== null)
  useEffect(() => {
    if (workspaceId === undefined || account === undefined || !revalidationReady) return
    if (account.syncedActivity === null) {
      // First data landing: record the watermark the loaders just reflected.
      props.actions.setSyncedActivity(workspaceId, workspaceActivity)
      return
    }
    if (workspaceActivity <= account.syncedActivity) return
    const timer = setTimeout(() => {
      refreshLoaded()
      props.actions.setSyncedActivity(workspaceId, workspaceActivity)
    }, WORKBENCH_REVALIDATE_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [account, props.actions, revalidationReady, refreshLoaded, workspaceActivity, workspaceId])

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
    if (workspaceId === undefined || workspace === undefined || account === undefined || props.section !== 'search' || requestKey !== deferredKey) return
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
    account?.search.filtersOpen, props.section, deferredKey, exclude, include, props.actions,
    props.searchFiles, query, requestKey, runRequest, workspace, workspaceId,
  ])

  const drawerDocumentOccupied = props.usePreviewDocumentOccupied(occupied => occupied)
  const section = props.section
  const directories = account?.directories ?? {}
  const expanded = expandedDirectories
  const previewOpenExternal = canOpenPath && activeTab !== undefined && activeTab.kind !== 'diff' && !activeTab.loading && activeTab.error === undefined
    ? () => { openExternal(activeTab.path) }
    : undefined
  const documentGuard = usePreviewDocumentGuard({
    workspaceId,
    placement: 'in-column',
    occupied: drawerDocumentOccupied,
    renderPreviewDocument: owner => props.renderSlot('workbench.preview.document', owner),
    dirtyTabs: account?.documentDirty,
    actions: props.actions,
    refreshSaved,
    t: props.t,
    dismiss: () => {
      /* v8 ignore next -- the dismiss callback renders only with a resolved Workspace. */
      if (workspaceId !== undefined) props.actions.setPreviewOpen(workspaceId, false)
    },
  })
  const searchAccount: WorkbenchSearch = search
    ?? { query: '', include: '', exclude: '', filtersOpen: false, entries: [], truncated: false, loading: false }
  const git = account?.git
  /* v8 ignore next -- the changes section exists only on an initialized default account. */
  const gitArea = account?.gitArea ?? 'worktree'
  const drawerPreviewOpen = props.drawer && account?.previewOpen === true
  const setSearchField = (patch: Partial<WorkbenchSearch>): void => {
    /* v8 ignore next -- the search panel renders only with a resolved Workspace. */
    if (workspaceId === undefined) return
    const next = { ...searchAccount, entries: [], truncated: false, loading: false, ...patch }
    delete next.error
    props.actions.setSearch(workspaceId, next)
  }
  // Workspace data sections need a resolved Workspace; contributed sections
  // (browser, terminal, …) are session-bound and render either way.
  const hasWorkspace = workspace !== undefined && workspaceId !== undefined
  const builtinSection = section === 'files' || section === 'search' || section === 'changes'
  return (
    <aside className={css.root} data-preview={drawerPreviewOpen || undefined} aria-label={props.t('workbench.aria')}>
      <header className={css.header}>
        <div className={css.headerText}>
          <span className={css.headerLabel}>{props.t('workbench.label')}</span>
          <strong className={css.headerTitle} title={workspace?.path}>{workspace?.title ?? props.t('workbench.label')}</strong>
        </div>
        <button type="button" className={css.iconButton} aria-label={props.t('workbench.close')} onClick={props.closeWorkbench}><IconCloseOutline16 /></button>
      </header>
      <nav className={css.sectionTabs} aria-label={props.t('workbench.tools')}>
        {/*
          Arrow/Home/End live on the tablist so navigation covers contributed
          section tabs beside the shipped ones: the handler walks the tablist's
          DOM tabs and activates the destination by click, which every tab
          (shipped or contributed) wires to its own selection.
        */}
        <div
          className={css.sectionTabList}
          role="tablist"
          onKeyDown={(event) => {
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
            const index = tabs.indexOf(event.target as HTMLElement)
            if (index === -1) return
            let next = index
            if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
            else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = tabs.length - 1
            else return
            event.preventDefault()
            const target = tabs[next]
            /* v8 ignore next -- navigation derives an in-range index from the non-empty DOM tab list. */
            if (target === undefined) throw new Error('section navigation produced an invalid index')
            target.focus()
            target.click()
          }}
        >
          {hasWorkspace && SECTIONS.map(entry => (
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
              onClick={() => { props.select(entry.section) }}
            >
              {entry.section === 'files' && <IconFolderOpen16 size={14} />}
              {entry.section === 'search' && <IconSearchOutline16 size={14} />}
              {entry.section === 'changes' && <IconBranchOutline16 size={14} />}
              <span>{props.t(entry.labelKey)}</span>
            </button>
          ))}
          {props.renderSlot('workbench.section.tab', { current: section, select: props.select, request: props.request })}
        </div>
      </nav>
      <section
        id="workspace-workbench-navigation"
        className={css.navigator}
        role="tabpanel"
        aria-labelledby={`workspace-workbench-section-${section}`}
      >
        <div className={css.navigatorBody}>
          {!hasWorkspace && builtinSection && (
            <div className={css.emptyState}>{props.t('workbench.noWorkspace')}</div>
          )}
          {hasWorkspace && section === 'files' && (
            <>
              {account?.fileWatch === 'manual' && (
                <div className={css.navStatus}>{props.t('workbench.watchManual')}</div>
              )}
              {/*
                Per-view actions live in the view's own header row, VS Code
                style: the section tab strip stays a fixed-width tablist, so
                contributed section tabs never slide under view actions on
                phone widths.
              */}
              <div className={css.filesToolbar}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={props.t('workbench.newFile')}
                  title={props.t('workbench.newFile')}
                  onClick={() => { startCreate('file') }}
                ><IconPlusOutline16 /></button>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={props.t('workbench.newFolder')}
                  title={props.t('workbench.newFolder')}
                  onClick={() => { startCreate('directory') }}
                ><IconProjectAddOutline16 /></button>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={props.t('workbench.refreshFiles')}
                  title={props.t('workbench.refreshFiles')}
                  onClick={() => { loadDirectory(''); rereadOpenFileTabs() }}
                ><IconRefreshOutline16 /></button>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={props.t('workbench.collapseAll')}
                  title={props.t('workbench.collapseAll')}
                  onClick={() => { props.actions.collapseAllDirectories(workspaceId) }}
                ><IconChevronUpOutline14 /></button>
              </div>
              <div className={css.navigatorScroll}>
                <DirectoryChildren
                  path=""
                  depth={0}
                  directories={directories}
                  expanded={expanded}
                  activePath={activeTab?.kind === 'diff' ? undefined : activeTab?.path}
                  canOpenPath={canOpenPath}
                  {...(createDraft === undefined ? {} : { createDraft })}
                  t={props.t}
                  onToggle={(path) => {
                    const open = expanded[path] !== true
                    lastDirectoryRef.current = path
                    props.actions.setDirectoryExpanded(workspaceId, path, open)
                    if (open && directories[path] === undefined) loadDirectory(path)
                  }}
                  onOpen={(entry) => {
                    lastDirectoryRef.current = parentDirectory(entry.path)
                    openFile(entry)
                  }}
                  onOpenExternal={(entry) => { openExternal(entry.path) }}
                  onCreateSubmit={submitCreate}
                  onCreateCancel={cancelCreate}
                />
                {props.renderSlot('workbench.section.panel', { current: section, select: props.select, request: props.request })}
              </div>
            </>
          )}
          {hasWorkspace && section === 'search' && (
            <SearchPanel
              {...searchAccount}
              panel={props.renderSlot('workbench.section.panel', { current: section, select: props.select, request: props.request })}
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
          {hasWorkspace && section === 'changes' && (
            <ChangesPanel
              area={gitArea}
              branch={git?.branch ?? null}
              upstream={git?.upstream ?? null}
              ahead={git?.ahead ?? null}
              behind={git?.behind ?? null}
              statusEntries={git?.entries ?? []}
              commits={git?.commits ?? []}
              commitFiles={account?.commitFiles ?? {}}
              expandedCommits={account?.expandedCommits ?? {}}
              loading={git?.loading ?? true}
              truncated={git?.truncated ?? false}
              historyTruncated={git?.historyTruncated ?? false}
              {...(git?.error === undefined ? {} : { error: git.error })}
              panel={props.renderSlot('workbench.section.panel', { current: section, select: props.select, request: props.request })}
              t={props.t}
              onArea={(area) => { props.actions.setGitArea(workspaceId, area) }}
              onRefresh={() => { loadGit() }}
              onLoadMore={(depth) => { loadGit(false, depth) }}
              onOpenDiff={openDiff}
              onOpenFile={openFile}
              onToggleCommit={toggleCommit}
              onOpenCommitDiff={openCommitDiff}
            />
          )}
          {(!builtinSection || !hasWorkspace) && (
            <div className={css.navigatorPanel}>
              {props.renderSlot('workbench.section.panel', { current: section, select: props.select, request: props.request })}
            </div>
          )}
        </div>
      </section>
      {/* Drawer mode: the region already covers the frame and the shell's
          overlay layer is inert, so preview renders here instead of there. */}
      {props.drawer && workspaceId !== undefined && (
        <WorkbenchPreview
          tabs={account?.tabs ?? []}
          activeTabId={account?.activeTabId ?? null}
          open={account?.previewOpen ?? false}
          focusScopeKey={workspaceId}
          {...(activeTab?.path === undefined ? {} : { focusReturnPath: activeTab.path })}
          {...(previewOpenExternal === undefined ? {} : { onOpenExternal: previewOpenExternal })}
          placement="in-column"
          t={props.t}
          onSelect={(id) => { props.actions.selectTab(workspaceId, id) }}
          onClose={(id) => {
            const closing = account?.tabs.find(tab => tab.id === id)
            /* v8 ignore next -- the close control renders only for a tab of this account, so the lookup always resolves. */
            const title = closing?.title ?? id
            if (!documentGuard.confirmPath(closing?.path, title)) return
            props.actions.closeTab(workspaceId, id)
          }}
          onDismiss={() => { documentGuard.guardedDismiss(activeTab) }}
          onReopenEncoding={reopenWithEncoding}
          mode={activeMode}
          onModeChange={(tabId, mode) => { props.actions.setPreviewMode(workspaceId, tabId, mode) }}
          {...(documentGuard.seat === undefined ? {} : { editor: documentGuard.seat })}
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
    return current !== undefined && state.byId[current] !== undefined ? current : undefined
  })
  const sessionCwd = props.useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const workspace = props.useWorkspaces(state => (
    sessionId === undefined
      ? undefined
      : state.items.find(item => item.sessionIds.includes(sessionId))
        ?? state.items.find(item => item.path === sessionCwd)
  ))
  const workspaceId = workspace?.workspaceId as string | undefined
  const account = props.useStore(state => workspaceId === undefined ? undefined : state.byWorkspace[workspaceId])
  const activeTab = account?.tabs.find(tab => tab.id === account.activeTabId)
  const activeMode = activeTab === undefined ? undefined : account?.previewMode[activeTab.id]
  const canOpenPath = props.useCanOpenPath(capable => capable)
  const openExternal = useCallback((relativePath: string) => {
    /* v8 ignore next -- the preview renders only after a Workspace account resolves. */
    if (workspace === undefined) return
    void props.openPath(resolveWorkspacePath(workspace.path, relativePath)).catch((error: unknown) => {
      console.warn('open in default application failed:', error)
    })
  }, [props.openPath, workspace])
  const previewOpenExternal = canOpenPath && activeTab !== undefined && activeTab.kind !== 'diff' && !activeTab.loading && activeTab.error === undefined
    ? () => { openExternal(activeTab.path) }
    : undefined
  // "Reopen with encoding" on the overlay copy: same tab identity, explicit
  // encoding re-read through the shared store account.
  const reopenWithEncoding = useCallback((entryPath: string, encoding: string | undefined) => {
    /* v8 ignore next -- the selector renders only after a Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    const id = `file:${entryPath}`
    const descriptor = previewType(entryPath)
    const pending: WorkbenchTab = {
      id, path: entryPath, title: basename(entryPath), kind: descriptor.kind, loading: true,
      ...(descriptor.language === undefined ? {} : { language: descriptor.language }),
      ...(encoding === undefined ? {} : { encoding, encodingSource: 'explicit' as const }),
    }
    props.actions.openTab(workspaceId, pending)
    void props.readFile(workspace.workspaceId, entryPath, encoding === undefined ? undefined : { encoding })
      .then((value) => {
        props.actions.updateTab(workspaceId, {
          ...pending, content: value.content, bytes: value.bytes, truncated: value.truncated, loading: false,
          encoding: value.encoding, encodingSource: value.encodingSource, bom: value.bom, eol: value.eol,
        })
      })
      .catch((error: unknown) => {
        props.actions.updateTab(workspaceId, { ...pending, loading: false, error: String(error) })
      })
  }, [props.actions, props.readFile, workspace, workspaceId])
  // Same silent post-save re-read as the drawer placement, through the shared store account.
  const refreshSaved = useCallback((entryPath: string) => {
    /* v8 ignore next -- the editor occupant renders only after a Workspace account resolves. */
    if (workspaceId === undefined || workspace === undefined) return
    void props.readFile(workspace.workspaceId, entryPath)
      .then((value) => { props.actions.updateTab(workspaceId, readTab(entryPath, value)) })
      .catch((error: unknown) => { console.warn('refresh after save failed:', error) })
  }, [props.actions, props.readFile, workspace, workspaceId])
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
  const overlayDocumentOccupied = props.useOverlayDocumentOccupied(occupied => occupied)
  const documentGuard = usePreviewDocumentGuard({
    workspaceId,
    placement: 'overlay',
    occupied: overlayDocumentOccupied,
    renderPreviewDocument: owner => props.renderSlot('shell.overlay.preview.document', owner),
    dirtyTabs: account?.documentDirty,
    actions: props.actions,
    refreshSaved,
    t: props.t,
    dismiss: () => {
      /* v8 ignore next -- the dismiss callback renders only with a resolved Workspace. */
      if (workspaceId !== undefined) props.actions.setPreviewOpen(workspaceId, false)
    },
  })
  if (workspaceId === undefined || props.rightDrawer || !props.rightOpen || props.rightMode !== 'workbench') return null
  return (
    <WorkbenchPreview
      {...(documentGuard.seat === undefined ? {} : { editor: documentGuard.seat })}
      tabs={account?.tabs ?? []}
      activeTabId={account?.activeTabId ?? null}
      open={account?.previewOpen === true}
      focusScopeKey={workspaceId}
      {...(activeTab?.path === undefined ? {} : { focusReturnPath: activeTab.path })}
      {...(previewOpenExternal === undefined ? {} : { onOpenExternal: previewOpenExternal })}
      placement="overlay"
      t={props.t}
      onSelect={(id) => { props.actions.selectTab(workspaceId, id) }}
      onClose={(id) => {
        const closing = account?.tabs.find(tab => tab.id === id)
        /* v8 ignore next -- the close control renders only for a tab of this account, so the lookup always resolves. */
        const title = closing?.title ?? id
        if (!documentGuard.confirmPath(closing?.path, title)) return
        props.actions.closeTab(workspaceId, id)
      }}
      onDismiss={() => { documentGuard.guardedDismiss(activeTab) }}
      onReopenEncoding={reopenWithEncoding}
      mode={activeMode}
      onModeChange={(tabId, mode) => { props.actions.setPreviewMode(workspaceId, tabId, mode) }}
    />
  )
}
