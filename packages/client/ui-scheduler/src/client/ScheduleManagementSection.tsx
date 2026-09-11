import { useEffect, useState, type FormEvent } from 'react'
import type { ScheduleCreateRemoteInput, ScheduleRecord, ScheduleRun } from '@deepseek-ai/dsh-scheduler/client'
import type { SessionId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './ScheduleManagementSection.module.css'

interface ScheduleRow {
  readonly record: ScheduleRecord
  readonly sessionId: SessionId
}

interface ScheduleManagementActions {
  list: (sessionId: SessionId) => Promise<RemoteResult<readonly ScheduleRecord[]>>
  create: (sessionId: SessionId, input: ScheduleCreateRemoteInput) => Promise<RemoteResult<ScheduleRecord>>
  update: (sessionId: SessionId, id: string, input: { prompt?: string; status?: ScheduleRecord['status'] }) => Promise<RemoteResult<ScheduleRecord | undefined>>
  runs: (sessionId: SessionId, id: string) => Promise<RemoteResult<readonly ScheduleRun[]>>
  remove: (sessionId: SessionId, id: string) => Promise<RemoteResult<boolean>>
}

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & ScheduleManagementActions

interface Draft {
  prompt: string
  kind: 'after' | 'at' | 'every'
  value: string
}

const initialDraft = (): Draft => ({ prompt: '', kind: 'after', value: '5' })

function formatDate(value: number | undefined): string {
  return value === undefined ? '—' : new Date(value).toLocaleString()
}

function kindLabel(record: ScheduleRecord, t: TranslateNS<typeof NS>): string {
  return t(`management.kind.${record.rule.kind}`)
}

function workspaceSessionIds(
  sessionId: SessionId | undefined,
  workspaces: readonly WorkspaceView[],
  recentWorkspaceId: WorkspaceView['workspaceId'] | undefined,
): SessionId[] {
  const workspace = workspaces.find(item => sessionId !== undefined && item.sessionIds.includes(sessionId))
    ?? workspaces.find(item => item.workspaceId === recentWorkspaceId)
  if (workspace !== undefined) return [...workspace.sessionIds]
  return sessionId === undefined ? [] : [sessionId]
}

/** Settings section for all schedules owned by sessions in the current workspace. */
export function ScheduleManagementSection({
  useSessions,
  useWorkspaces,
  list,
  create,
  update,
  runs,
  remove,
  t,
}: Props) {
  const session = useSessions(state => ({ current: state.current }))
  const workspaceState = useWorkspaces(state => ({ items: state.items, recentWorkspaceId: state.recentWorkspaceId }))
  const sessionIds = workspaceSessionIds(session.current, workspaceState.items, workspaceState.recentWorkspaceId)
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [draft, setDraft] = useState<Draft>(initialDraft)
  const [draftOpen, setDraftOpen] = useState(false)
  const [editing, setEditing] = useState<string | undefined>()
  const [editPrompt, setEditPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [runHistory, setRunHistory] = useState<Record<string, readonly ScheduleRun[]>>({})

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      const results = await Promise.all(sessionIds.map(async id => ({ id, result: await list(id) })))
      const merged = new Map<string, ScheduleRow>()
      for (const { id, result } of results) {
        if (!result.ok) throw new Error(result.error.message)
        for (const record of result.value) merged.set(record.id, { record, sessionId: id })
      }
      setRows([...merged.values()].sort((a, b) => (a.record.nextDue ?? Infinity) - (b.record.nextDue ?? Infinity)))
      const history = await Promise.all([...merged.values()].map(async ({ record, sessionId: owner }) => {
        const result = await runs(owner, record.id)
        return [record.id, result.ok ? result.value.slice(0, 5) : []] as const
      }))
      setRunHistory(Object.fromEntries(history))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [sessionIds.join('\0')])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!draftOpen || sessionIds[0] === undefined || draft.prompt.trim() === '') return
    const rule = draft.kind === 'after'
      ? { kind: 'after' as const, delayMs: Number(draft.value) * 60_000 }
      : draft.kind === 'at'
        ? { kind: 'at' as const, at: new Date(draft.value).toISOString() }
        : { kind: 'every' as const, intervalMs: Number(draft.value) * 60_000, anchor: new Date().toISOString() }
    setBusy(true)
    try {
      const result = await create(sessionIds[0], {
        prompt: draft.prompt,
        rule,
        target: { kind: 'current' },
        contextMode: 'continue',
      })
      if (!result.ok) throw new Error(result.error.message)
      setDraftOpen(false)
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const mutate = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try { await action(); await refresh() } catch { setError(true) } finally { setBusy(false) }
  }

  if (loading) return <div className={css.section}><p>{t('management.loading')}</p></div>
  if (error) return <div className={css.section}><p>{t('management.error')}</p><button type="button" onClick={() => { void refresh() }}>{t('management.retry')}</button></div>

  return (
    <div className={css.section}>
      <h2>{t('management.title')}</h2>
      <p className={css.intro}>{t('management.intro')}</p>
      <button type="button" disabled={busy || sessionIds.length === 0} onClick={() => { setDraft(initialDraft()); setDraftOpen(true) }}>
        {t('management.create')}
      </button>
      {draftOpen ? (
        <form className={css.form} onSubmit={(event) => { void submit(event) }}>
          <label>{t('management.prompt')}<textarea required value={draft.prompt} onChange={(event) => { setDraft({ ...draft, prompt: event.target.value }) }} /></label>
          <label>{t('management.rule')}<select value={draft.kind} onChange={(event) => { setDraft({ ...draft, kind: event.target.value as Draft['kind'] }) }}><option value="after">{t('management.kind.after')}</option><option value="at">{t('management.kind.at')}</option><option value="every">{t('management.kind.every')}</option></select></label>
          <label>{t(`management.${draft.kind}`)}<input required type={draft.kind === 'at' ? 'datetime-local' : 'number'} min={draft.kind === 'at' ? undefined : '5'} value={draft.value} onChange={(event) => { setDraft({ ...draft, value: event.target.value }) }} /></label>
          <span><button type="submit" disabled={busy}>{t('management.save')}</button><button type="button" onClick={() => { setDraftOpen(false) }}>{t('management.cancel')}</button></span>
        </form>
      ) : null}
      {rows.length === 0 ? <p>{t('management.empty')}</p> : (
        <ul className={css.list}>
          {rows.map(({ record, sessionId }) => {
            // refresh installs one history entry for every merged record before
            // leaving its loading state.
            const history = runHistory[record.id] as readonly ScheduleRun[]
            return <li key={record.id} className={css.row}>
              {editing === record.id
                ? <input value={editPrompt} onChange={(event) => { setEditPrompt(event.target.value) }} />
                : <strong title={record.prompt}>{record.prompt}</strong>}
              <span>{kindLabel(record, t)} · {t(`management.status.${record.status}`)}</span>
              <span>{t('management.next')}: {formatDate(record.nextDue)}</span>
              <span>{t('management.last')}: {formatDate(record.lastRunAt)}</span>
              <span>{t('management.runs')}: {history.length}</span>
              {history.length > 0 ? (
                <span className={css.history}>
                  {t('management.history')}: {history.map(run => (
                    <span key={run.id}>
                      {run.status === 'succeeded' ? t('management.succeeded') : t('management.failed')} {formatDate(run.attemptedAt)}
                    </span>
                  ))}
                </span>
              ) : null}
              {record.lastError !== undefined ? <span>{t('management.failure', { error: record.lastError })}</span> : null}
              <span>
                {editing === record.id
                  ? <button type="button" disabled={busy} onClick={() => { void mutate(async () => { await update(sessionId, record.id, { prompt: editPrompt }); setEditing(undefined) }) }}>{t('management.save')}</button>
                  : <button type="button" disabled={busy} onClick={() => { setEditing(record.id); setEditPrompt(record.prompt) }}>{t('management.prompt')}</button>}
                {record.status === 'done' ? null : <button type="button" disabled={busy} onClick={() => { void mutate(() => update(sessionId, record.id, { status: record.status === 'paused' ? 'active' : 'paused' })) }}>{record.status === 'paused' ? t('action.resume') : t('action.pause')}</button>}
                <button type="button" disabled={busy} onClick={() => { void mutate(() => remove(sessionId, record.id)) }}>{t('action.delete')}</button>
              </span>
            </li>
          })}
        </ul>
      )}
    </div>
  )
}
