import { useState, type FormEvent, type KeyboardEvent } from 'react'
import type {
  ScheduleContextMode, ScheduleCreateRemoteInput, ScheduleRecord, ScheduleRun, ScheduleStatus,
  ScheduleTargetKind, ScheduleUpdate, SchedulerRule,
} from '@deepseek-ai/dsh-scheduler/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './ScheduleCenterView.module.css'

/** Mutations the drawer can reach; the management view owns the verbs. */
export interface ScheduleEditorVerbs {
  /** Create one schedule attributed to the owner session's human. */
  create: (sessionId: SessionId, input: ScheduleCreateRemoteInput) => Promise<RemoteResult<ScheduleRecord>>
  /** Patch prompt, status, and/or rule through the global management surface. */
  update: (id: string, patch: ScheduleUpdate) => Promise<RemoteResult<ScheduleRecord | undefined>>
  /** Remove one schedule. */
  remove: (id: string) => Promise<RemoteResult<boolean>>
}

/** Editable form draft; one shape serves create and edit. */
interface Draft {
  readonly prompt: string
  readonly status: ScheduleStatus
  readonly kind: 'after' | 'at' | 'every'
  readonly value: string
  readonly targetKind: ScheduleTargetKind
  readonly targetSessionId: string
  readonly contextMode: ScheduleContextMode
}

/** Props of the create/edit drawer; plain data and callbacks only. */
export interface ScheduleEditorDrawerProps {
  /** The record being edited, or undefined for creation. */
  record: ScheduleRecord | undefined
  /** Session that owns a created schedule's provenance. */
  ownerSessionId: SessionId | undefined
  /** Candidate sessions for the named-session target picker. */
  sessionIds: readonly SessionId[]
  /** Session display label (title plus short id) for pickers and history. */
  sessionLabel: (id: SessionId) => string
  /** Newest-first run history of the edited record. */
  runs: readonly ScheduleRun[]
  /** Remote verbs bound by the management view. */
  verbs: ScheduleEditorVerbs
  /** Close the drawer without saving. */
  onClose: () => void
  /** Refresh the table after a committed mutation. */
  onSaved: () => Promise<void>
  t: TranslateNS<typeof NS>
}

function draftOf(record: ScheduleRecord | undefined, sessionIds: readonly SessionId[], current: SessionId | undefined): Draft {
  if (record === undefined) {
    return {
      prompt: '',
      status: 'active',
      kind: 'after',
      value: '5',
      targetKind: 'current',
      targetSessionId: current ?? sessionIds[0] ?? '',
      contextMode: 'continue',
    }
  }
  const kind = record.rule.kind
  return {
    prompt: record.prompt,
    status: record.status,
    kind,
    value: kind === 'after'
      ? String(Math.max(1, Math.round(record.rule.delayMs / 60_000)))
      : kind === 'every'
        ? String(Math.max(1, Math.round(record.rule.intervalMs / 60_000)))
        : new Date(record.rule.at).toISOString().slice(0, 16),
    targetKind: record.target.kind,
    targetSessionId: record.target.kind === 'session' ? record.target.sessionId : '',
    contextMode: record.contextMode,
  }
}

/** Build the durable rule from the draft; `every` re-anchors at save time. */
function toRule(draft: Draft): SchedulerRule {
  if (draft.kind === 'after') return { kind: 'after', delayMs: Number(draft.value) * 60_000 }
  if (draft.kind === 'every') return { kind: 'every', intervalMs: Number(draft.value) * 60_000, anchor: new Date().toISOString() }
  return { kind: 'at', at: new Date(draft.value).toISOString() }
}

/** Whether the draft edits the durable rule beyond its anchor's save-time refresh. */
function ruleChanged(record: ScheduleRecord, draft: Draft): boolean {
  if (record.rule.kind !== draft.kind) return true
  if (draft.kind === 'after') return record.rule.kind === 'after' && record.rule.delayMs !== Number(draft.value) * 60_000
  if (draft.kind === 'every') return record.rule.kind === 'every' && record.rule.intervalMs !== Number(draft.value) * 60_000
  return record.rule.kind === 'at' && record.rule.at !== new Date(draft.value).toISOString()
}

/** One drawer over the management table: create or edit one schedule. */
export function ScheduleEditorDrawer({
  record, ownerSessionId, sessionIds, sessionLabel, runs, verbs, onClose, onSaved, t,
}: ScheduleEditorDrawerProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(record, sessionIds, ownerSessionId))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const editing = record !== undefined
  // A finished one-shot cannot be rescheduled; the host rejects rule edits.
  const ruleLocked = record !== undefined && record.status === 'done'
  const valid = draft.prompt.trim() !== ''
    && (record !== undefined || ownerSessionId !== undefined)
    && (draft.kind === 'at' ? draft.value !== '' && !Number.isNaN(new Date(draft.value).getTime())
      : Number(draft.value) >= 1)
    && (draft.targetKind !== 'session' || draft.targetSessionId !== '')

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      if (record === undefined) {
        /* v8 ignore next -- `valid` requires an owner for creation. */
        if (ownerSessionId === undefined) return
        const target = draft.targetKind === 'session'
          ? { kind: 'session' as const, sessionId: draft.targetSessionId as SessionId }
          : { kind: draft.targetKind }
        const result = await verbs.create(ownerSessionId, {
          prompt: draft.prompt,
          rule: toRule(draft),
          target,
          contextMode: draft.contextMode,
        })
        if (!result.ok) throw new Error(result.error.message)
      } else {
        const patch: ScheduleUpdate = {
          ...(draft.prompt !== record.prompt ? { prompt: draft.prompt } : {}),
          ...(draft.status !== record.status ? { status: draft.status } : {}),
          ...(!ruleLocked && ruleChanged(record, draft) ? { rule: toRule(draft) } : {}),
        }
        if (Object.keys(patch).length > 0) {
          const result = await verbs.update(record.id, patch)
          if (!result.ok) throw new Error(result.error.message)
        }
      }
      onClose()
      await onSaved()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    /* v8 ignore next -- the delete control only renders for an edited record. */
    if (record === undefined || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await verbs.remove(record.id)
      if (!result.ok) throw new Error(result.error.message)
      onClose()
      await onSaved()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div className={css.drawer} role="dialog" aria-label={t(editing ? 'editor.editTitle' : 'editor.createTitle')} onKeyDown={onKeyDown}>
      <header className={css.drawerHeader}>
        <span className={css.drawerTitle}>{t(editing ? 'editor.editTitle' : 'editor.createTitle')}</span>
        {record === undefined ? null : record.id}
      </header>
      <form className={css.drawerBody} onSubmit={(event) => { void submit(event) }}>
        <label className={css.field}>
          {t('editor.prompt')}
          <textarea
            required
            value={draft.prompt}
            disabled={busy}
            onChange={(event) => { setDraft({ ...draft, prompt: event.target.value }) }}
          />
        </label>
        <label className={css.field}>
          {t('editor.target')}
          {record === undefined
            ? (
              <select
                value={draft.targetKind}
                disabled={busy}
                onChange={(event) => { setDraft({ ...draft, targetKind: event.target.value as ScheduleTargetKind }) }}
              >
                <option value="current">{t('target.current')}</option>
                <option value="job">{t('target.job')}</option>
                <option value="session">{t('target.session')}</option>
              </select>
            )
            : <span className={css.lockedValue}>{targetSummary(record, sessionLabel, t)}</span>}
        </label>
        {!editing && draft.targetKind === 'session' ? (
          <label className={css.field}>
            {t('editor.targetSession')}
            <select
              required
              value={draft.targetSessionId}
              disabled={busy || sessionIds.length === 0}
              onChange={(event) => { setDraft({ ...draft, targetSessionId: event.target.value }) }}
            >
              {sessionIds.length === 0 ? <option value="">{t('editor.noSession')}</option> : null}
              {sessionIds.map(id => <option key={id} value={id}>{sessionLabel(id)}</option>)}
            </select>
          </label>
        ) : null}
        <label className={css.field}>
          {t('editor.rule')}
          {ruleLocked
            ? <span className={css.lockedValue}>{t('editor.ruleLocked')}</span>
            : (
              <select
                value={draft.kind}
                disabled={busy}
                onChange={(event) => { setDraft({ ...draft, kind: event.target.value as Draft['kind'] }) }}
              >
                <option value="after">{t('kind.after')}</option>
                <option value="at">{t('kind.at')}</option>
                <option value="every">{t('kind.every')}</option>
              </select>
            )}
        </label>
        {!ruleLocked ? (
          <label className={css.field}>
            {draft.kind === 'after' ? t('editor.after') : draft.kind === 'every' ? t('editor.every') : t('editor.at')}
            <input
              required
              type={draft.kind === 'at' ? 'datetime-local' : 'number'}
              min={draft.kind === 'at' ? undefined : '1'}
              step="1"
              value={draft.value}
              disabled={busy}
              onChange={(event) => { setDraft({ ...draft, value: event.target.value }) }}
            />
          </label>
        ) : null}
        <label className={css.field}>
          {t('editor.context')}
          {record === undefined
            ? (
              <select
                value={draft.contextMode}
                disabled={busy}
                onChange={(event) => { setDraft({ ...draft, contextMode: event.target.value as ScheduleContextMode }) }}
              >
                <option value="continue">{t('editor.context.continue')}</option>
                <option value="fresh">{t('editor.context.fresh')}</option>
              </select>
            )
            : <span className={css.lockedValue}>{t(record.contextMode === 'fresh' ? 'editor.context.fresh' : 'editor.context.continue')}</span>}
        </label>
        {editing ? (
          <label className={css.field}>
            {t('editor.status')}
            <select
              value={draft.status}
              disabled={busy}
              onChange={(event) => { setDraft({ ...draft, status: event.target.value as ScheduleStatus }) }}
            >
              <option value="active">{t('status.active')}</option>
              <option value="paused">{t('status.paused')}</option>
              <option value="done">{t('status.done')}</option>
            </select>
          </label>
        ) : null}
        {editing ? (
          <div className={css.history}>
            <span className={css.historyTitle}>{t('editor.history')}</span>
            {runs.length === 0 ? <span className={css.historyEmpty}>{t('run.none')}</span> : (
              <ul className={css.historyList}>
                {runs.map(run => (
                  <li key={run.id} className={css.historyRow}>
                    <span className={run.status === 'succeeded' ? css.runOk : css.runFail}>
                      {t(run.status === 'succeeded' ? 'run.succeeded' : 'run.failed', { time: new Date(run.attemptedAt).toLocaleString() })}
                    </span>
                    <span className={css.historyTarget} title={run.targetSessionId}>{sessionLabel(run.targetSessionId)}</span>
                    {run.error === undefined ? null : <span className={css.runFail}>{run.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {failure === undefined ? null : <p className={css.formError} role="alert">{t('editor.failure', { error: failure })}</p>}
        <div className={css.drawerActions}>
          <button type="submit" disabled={busy || !valid}>{t('editor.save')}</button>
          <button type="button" disabled={busy} onClick={onClose}>{t('editor.cancel')}</button>
          {editing ? <button type="button" className={css.danger} disabled={busy} onClick={() => { void remove() }}>{t('action.delete')}</button> : null}
        </div>
        {!editing && ownerSessionId === undefined ? <p className={css.formError}>{t('editor.noSession')}</p> : null}
      </form>
    </div>
  )
}

/** Read-only target summary for the edit drawer. */
function targetSummary(record: ScheduleRecord, sessionLabel: (id: SessionId) => string, t: TranslateNS<typeof NS>): string {
  if (record.target.kind === 'session') return `${t('target.session')} · ${sessionLabel(record.target.sessionId)}`
  if (record.target.kind === 'job') return record.jobSessionId === undefined
    ? t('target.job')
    : `${t('target.job')} · ${sessionLabel(record.jobSessionId)}`
  return `${t('target.current')} · ${sessionLabel(record.createdBy.sessionId)}`
}
