import { useCallback, useEffect, useState } from 'react'
import type { ScheduleRecord, ScheduleRun, SchedulerRule } from '@deepseek-ai/dsh-scheduler/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createScheduleViewStore } from './stores.ts'
import type { ScheduleEditorVerbs } from './ScheduleEditorDrawer.tsx'
import { ScheduleEditorDrawer } from './ScheduleEditorDrawer.tsx'
import { NS } from './locales.ts'
import css from './ScheduleCenterView.module.css'

/** Remote verbs bound to the management view, plus the frame exit. */
export interface ScheduleCenterActions extends ScheduleEditorVerbs {
  /** Read every stored schedule, earliest due first. */
  listAll: () => Promise<RemoteResult<readonly ScheduleRecord[]>>
  /** Read one schedule's newest-first run history. */
  runsOf: (id: string) => Promise<RemoteResult<readonly ScheduleRun[]>>
  /** Return to the conversation in the center column. */
  closeView: () => void
}

/** Full props composed by the center.view slot. */
export type ScheduleCenterViewProps =
  PropsRuntime<'center.view'>
  & PropsStore<ReturnType<typeof createScheduleViewStore>>
  & InjectFace<ScheduleCenterActions>
  & PropsLocale<typeof NS>

/** Drawer target: creation, or one record under edit. */
type Editor = { kind: 'create' } | { kind: 'edit'; record: ScheduleRecord } | undefined

/** Session display label: title plus a short id tail for unambiguous jumps. */
function sessionLabelOf(byId: SessionListState['byId']): (id: SessionId) => string {
  return (id: SessionId) => {
    const title = byId[id]?.displayTitle
    return title === undefined ? `#${id.slice(0, 8)}` : `${title} (#${id.slice(0, 8)})`
  }
}

/** Bound-destination summary of one record for the table cell. */
function targetSummary(record: ScheduleRecord, sessionLabel: (id: SessionId) => string, t: TranslateNS<typeof NS>): string {
  if (record.target.kind === 'session') return `${t('target.session')} · ${sessionLabel(record.target.sessionId)}`
  if (record.target.kind === 'job') return record.jobSessionId === undefined
    ? t('target.job')
    : `${t('target.job')} · ${sessionLabel(record.jobSessionId)}`
  return `${t('target.current')} · ${sessionLabel(record.createdBy.sessionId)}`
}

/** Human summary of one rule. */
function ruleSummary(rule: SchedulerRule, t: TranslateNS<typeof NS>): string {
  if (rule.kind === 'after') return t('rule.after', { minutes: String(Math.max(1, Math.round(rule.delayMs / 60_000))) })
  if (rule.kind === 'every') return t('rule.every', { minutes: String(Math.max(1, Math.round(rule.intervalMs / 60_000))) })
  return new Date(rule.at).toLocaleString()
}

/** Timestamp cell text; absent moments render an em dash. */
function moment(value: number | undefined): string {
  return value === undefined ? '—' : new Date(value).toLocaleString()
}

/**
 * The schedules management view occupying the center column: every stored
 * schedule in one table (id, prompt, bound session, rule, due moments,
 * status, latest delivery), a create/edit drawer, and the pause/resume and
 * delete verbs over the global Remote surface. Mounting claims the sidebar
 * trigger's pressed affordance through the shared store.
 * @param props - center.view currency, the shared view store, the Remote verbs, and the translator.
 * @returns the full-center management surface.
 */
export function ScheduleCenterView({
  useSessions, actions, listAll, runsOf, create, update, remove, closeView, t,
}: ScheduleCenterViewProps) {
  const current = useSessions(state => state.current)
  const sessionIds = useSessions(state => state.ids)
  const byId = useSessions(state => state.byId)
  const sessionLabel = sessionLabelOf(byId)
  const [rows, setRows] = useState<readonly ScheduleRecord[]>([])
  const [runsById, setRunsById] = useState<Record<string, readonly ScheduleRun[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor>(undefined)

  // Occupancy is the frame's fact: claim it while mounted, release on unmount
  // (including the session-switch dismissal).
  useEffect(() => {
    actions.setOpen(true)
    return () => { actions.setOpen(false) }
  }, [actions])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      const result = await listAll()
      if (!result.ok) throw new Error(result.error.message)
      const records = [...result.value].sort((a, b) => (a.nextDue ?? Infinity) - (b.nextDue ?? Infinity))
      setRows(records)
      const histories = await Promise.all(records.map(async (record) => {
        const runs = await runsOf(record.id)
        return [record.id, runs.ok ? runs.value.slice(0, 5) : []] as const
      }))
      setRunsById(Object.fromEntries(histories))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [listAll, runsOf])

  useEffect(() => { void refresh() }, [refresh])

  const mutate = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await run()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  // A created schedule needs an owning session for provenance; prefer the
  // current one, else the first known session.
  const ownerSessionId: SessionId | undefined = current ?? sessionIds[0]

  return (
    <section className={css.view} aria-label={t('view.title')}>
      <header className={css.header}>
        <span className={css.title}>{t('view.title')}</span>
        <span className={css.summary}>{t('view.summary', { count: String(rows.length) })}</span>
        <span className={css.headerActions}>
          <button type="button" disabled={busy || loading} onClick={() => { void refresh() }}>{t('view.refresh')}</button>
          <button type="button" disabled={busy} onClick={() => { setEditor({ kind: 'create' }) }}>{t('view.create')}</button>
          <button type="button" className={css.close} aria-label={t('view.close')} onClick={closeView}>
            <IconCloseOutline16 />
          </button>
        </span>
      </header>
      <div className={css.body}>
        {loading ? <p className={css.note}>{t('view.loading')}</p> : null}
        {!loading && error ? (
          <div className={css.note}>
            <p role="alert">{t('view.error')}</p>
            <button type="button" onClick={() => { void refresh() }}>{t('view.retry')}</button>
          </div>
        ) : null}
        {!loading && !error && rows.length === 0 ? <p className={css.note}>{t('view.empty')}</p> : null}
        {!loading && !error && rows.length > 0 ? (
          <table className={css.table}>
            <thead>
              <tr>
                <th>{t('table.id')}</th>
                <th>{t('table.prompt')}</th>
                <th>{t('table.target')}</th>
                <th>{t('table.rule')}</th>
                <th>{t('table.next')}</th>
                <th>{t('table.lastRun')}</th>
                <th>{t('table.status')}</th>
                <th>{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => {
                const lastRun = runsById[record.id]?.[0]
                return (
                  <tr key={record.id} data-schedule-row={record.id}>
                    {/* data-label is the column header the card form prints
                        beside each value once the table stops being a grid
                        (phone rule in the sheet). */}
                    <td className={css.idCell} data-label={t('table.id')} title={record.id}>{record.id.slice(0, 8)}</td>
                    <td className={css.promptCell} data-label={t('table.prompt')} title={record.prompt}>{record.prompt}</td>
                    <td data-label={t('table.target')} title={targetSummary(record, sessionLabel, t)}>{targetSummary(record, sessionLabel, t)}</td>
                    <td data-label={t('table.rule')}>{ruleSummary(record.rule, t)}</td>
                    <td data-label={t('table.next')}>{moment(record.nextDue)}</td>
                    <td data-label={t('table.lastRun')}>
                      {lastRun === undefined ? t('run.none') : (
                        <span title={sessionLabel(lastRun.targetSessionId)}>
                          {t(lastRun.status === 'succeeded' ? 'run.succeeded' : 'run.failed', { time: new Date(lastRun.attemptedAt).toLocaleString() })}
                          {' · '}
                          {sessionLabel(lastRun.targetSessionId)}
                        </span>
                      )}
                    </td>
                    <td data-label={t('table.status')}><span className={record.status === 'active' ? css.statusActive : record.status === 'paused' ? css.statusPaused : css.statusDone}>{t(`status.${record.status}`)}</span></td>
                    <td className={css.actionsCell}>
                      <span className={css.rowActions}>
                        <button type="button" disabled={busy} onClick={() => { setEditor({ kind: 'edit', record }) }}>{t('table.edit')}</button>
                        {record.status === 'done' ? null : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => { void mutate(() => update(record.id, { status: record.status === 'paused' ? 'active' : 'paused' })) }}
                          >
                            {record.status === 'paused' ? t('action.resume') : t('action.pause')}
                          </button>
                        )}
                        <button type="button" disabled={busy} onClick={() => { void mutate(() => remove(record.id)) }}>{t('action.delete')}</button>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : null}
        {editor === undefined ? null : (
          <ScheduleEditorDrawer
            record={editor.kind === 'edit' ? editor.record : undefined}
            ownerSessionId={ownerSessionId}
            sessionIds={sessionIds}
            sessionLabel={sessionLabel}
            /* v8 ignore next -- refresh writes a history entry for every rendered row. */
            runs={editor.kind === 'edit' ? (runsById[editor.record.id] ?? []) : []}
            verbs={{ create, update, remove }}
            onClose={() => { setEditor(undefined) }}
            onSaved={refresh}
            t={t}
          />
        )}
      </div>
    </section>
  )
}
