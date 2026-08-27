import { useEffect, useState } from 'react'
import type { WorkspaceFileEntry } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceInspectorProps } from './contract/slots.ts'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createWorkspaceInspectorStore } from './stores.ts'
import css from './WorkspaceInspector.module.css'

function currentWorkspace(props: WorkspaceInspectorProps) {
  const state = props.useWorkspaces(s => s)
  const session = props.useSessions(s => s.byId[props.sessionId])
  return state.items.find(item => item.sessionIds.includes(props.sessionId) || item.path === session?.cwd)
    ?? state.items.find(item => item.workspaceId === state.recentWorkspaceId)
    ?? state.items[0]
}

function FileTree({ props, workspaceId, path = '' }: { props: WorkspaceInspectorProps; workspaceId: string; path?: string }) {
  const key = `${workspaceId}:${path}`
  const item = props.useStore(s => s.directories[key])
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!expanded || item !== undefined) return
    props.actions.setDirectory(key, { entries: [], truncated: false, loading: true })
    void props.listFiles(workspaceId as never, path || undefined).then((value) => {
      props.actions.setDirectory(key, { ...value, loading: false })
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      props.actions.setDirectory(key, { entries: [], truncated: false, loading: false, error: message })
    })
  }, [expanded, item, key, path, props, workspaceId])
  return (
    <div className={css.treeNode}>
      {path !== '' && <button type="button" className={css.treeButton} onClick={() => { setExpanded(value => !value) }}>{expanded ? '▾' : '▸'} {path.split('/').pop()}</button>}
      {path === '' && !item && <button type="button" className={css.treeButton} onClick={() => { setExpanded(true) }}>▸ workspace</button>}
      {expanded && item?.loading && <div className={css.muted}>加载中…</div>}
      {expanded && item?.error && <div className={css.error}>{item.error}</div>}
      {expanded && item?.entries.map(entry => <Entry key={entry.path} props={props} workspaceId={workspaceId} entry={entry} />)}
      {expanded && item?.truncated && <div className={css.muted}>目录内容已达到单次显示上限</div>}
    </div>
  )
}

function Entry({ props, workspaceId, entry }: { props: WorkspaceInspectorProps; workspaceId: string; entry: WorkspaceFileEntry }) {
  if (entry.kind === 'directory') return <FileTree props={props} workspaceId={workspaceId} path={entry.path} />
  if (entry.kind !== 'file') return <div className={css.muted}>{entry.name}</div>
  return <button type="button" className={css.fileButton} onClick={() => {
    props.actions.setOpenFile({ workspaceId, path: entry.path, loading: true })
    void props.readFile(workspaceId as never, entry.path).then((value) => {
      props.actions.setOpenFile({ workspaceId, path: entry.path, content: value.content, loading: false, truncated: value.truncated })
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      props.actions.setOpenFile({ workspaceId, path: entry.path, loading: false, error: message })
    })
  }}>{entry.name}</button>
}

export function WorkspaceInspector(props: WorkspaceInspectorProps) {
  const workspace = currentWorkspace(props)
  const state = props.useStore(s => s)
  const loadGit = (): void => {
    if (workspace === undefined) return
    props.actions.setGit({ branch: null, entries: [], commits: [], loading: true })
    void Promise.all([props.gitStatus(workspace.workspaceId), props.gitCommits(workspace.workspaceId)]).then(([status, history]) => {
      props.actions.setGit({ ...status, commits: history.commits, loading: false, truncated: status.truncated || history.truncated })
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      props.actions.setGit({ branch: null, entries: [], commits: [], loading: false, error: message })
    })
  }
  return (
    <aside className={css.root} aria-label="工作区检查器">
      <div className={css.toolbar}>
        <button type="button" className={css.tab} data-active={state.filePanel || undefined} onClick={() => { props.actions.setFilePanel(!state.filePanel) }}>文件</button>
        <button type="button" className={css.tab} data-active={state.gitPanel || undefined} onClick={() => {
          const open = !state.gitPanel
          props.actions.setGitPanel(open)
          if (open && state.git === null) loadGit()
        }}>Git</button>
      </div>
      {workspace === undefined && <div className={css.muted}>当前会话没有关联工作区</div>}
      {state.filePanel && workspace !== undefined && <section className={css.section}>
        <div className={css.heading}>{workspace.title}</div>
        <FileTree props={props} workspaceId={workspace.workspaceId} />
      </section>}
      {state.gitPanel && workspace !== undefined && <section className={css.section}>
        <div className={css.heading}>Git {state.git?.branch ? `· ${state.git.branch}` : ''}</div>
        {state.git?.loading && <div className={css.muted}>加载中…</div>}
        {state.git?.error && <div className={css.error}>{state.git.error}<button type="button" onClick={loadGit}>重试</button></div>}
        {state.git?.entries.map(entry => (
          <div key={entry.path} className={css.status}>{entry.indexStatus}{entry.worktreeStatus} {entry.path}</div>
        ))}
        {state.git?.commits.map(commit => (
          <div key={commit.hash} className={css.commit}><code>{commit.shortHash}</code> {commit.subject}</div>
        ))}
      </section>}
    </aside>
  )
}

/** Center workspace tab showing the selected file as read-only text. */
export function WorkspaceInspectorView(props: ConvViewProps & PropsStore<ReturnType<typeof createWorkspaceInspectorStore>> & InjectFace<import('./contract/slots.ts').WorkspaceInspectorInjected> & PropsLocale<'workspace'>) {
  const file = props.useStore(s => s.openFile)
  return (
    <main className={css.viewer}>
      <div className={css.viewerTitle}>{file?.path ?? '请选择一个文件'}</div>
      {file === null && <div className={css.muted}>从右侧工作区文件中选择一个文本文件</div>}
      {file?.loading && <div className={css.muted}>读取中…</div>}
      {file?.error && <div className={css.error}>{file.error}</div>}
      {file?.content !== undefined && <pre className={css.content}>{file.content}</pre>}
      {file?.truncated && <div className={css.muted}>文件内容超过预览上限</div>}
    </main>
  )
}
