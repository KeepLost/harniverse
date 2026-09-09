import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ScheduleRecord } from '@deepseek-ai/dsh-scheduler/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { IconChevronDownOutline14, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import css from './ScheduleListAction.module.css'

/** Status patch this face can apply through the scheduler Remote. */
export interface ScheduleStatusPatch {
  readonly status?: 'active' | 'paused'
}

/**
 * Injected business face of the schedule header entry: the scheduler Remote
 * verbs bound to this session. Callbacks from inject, live state from the
 * refresh chain — the Remote stays the single source of truth.
 */
export interface ScheduleListActions {
  /** Refresh this session's owned schedules, earliest first. */
  onRefresh: () => Promise<RemoteResult<readonly ScheduleRecord[]>>
  /** Patch one schedule's prompt and/or status. */
  onUpdate: (id: string, patch: ScheduleStatusPatch) => Promise<RemoteResult<ScheduleRecord | undefined>>
  /** Cancel one schedule. */
  onRemove: (id: string) => Promise<RemoteResult<boolean>>
}

/** Full props for the session-header schedule action. */
export type ScheduleListActionProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & ScheduleListActions

/** Status marker semantics for one schedule row. */
function dotState(status: ScheduleRecord['status']): StateDotState {
  switch (status) {
    case 'active': return 'ongoing'
    case 'paused': return 'warning'
    default: return 'done'
  }
}

/** Next-due caption; exhausted projections carry no due moment. */
function dueLabel(record: ScheduleRecord, t: TranslateNS<typeof NS>): string {
  if (record.nextDue === undefined) return t('due.none')
  return new Date(record.nextDue).toLocaleString()
}

/**
 * Session-header entry point for this session's durable schedules. It renders
 * nothing until the scheduler Remote reports at least one owned record, so an
 * ordinary conversation never grows a control for a capability it is not
 * using. The list refreshes on open and after every mutation; live dispatch
 * updates arrive the next time the popover opens.
 * @param props - runtime slot currency, the namespace translator, and the session-bound Remote verbs.
 * @returns the trigger and its popover list, or null when there is nothing to show.
 */
export function ScheduleListAction({ onRefresh, onUpdate, onRemove, t }: ScheduleListActionProps) {
  const [rows, setRows] = useState<readonly ScheduleRecord[]>([])
  const [ready, setReady] = useState(false)
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(async () => {
    const result = await onRefresh()
    if (result.ok) {
      setRows(result.value)
      setReady(true)
    }
  }, [onRefresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  // The last schedule disappearing removes this control; close first so focus
  // does not vanish from an unmounting node.
  useEffect(() => {
    if (ready && rows.length === 0 && open) setOpen(false)
  }, [ready, rows.length, open])

  if (!ready || rows.length === 0) return null

  const activeCount = rows.filter(row => row.status === 'active').length
  const pausedCount = rows.length - activeCount
  const countLabel = activeCount > 0
    ? t(activeCount === 1 ? 'count.active.one' : 'count.active.other', { count: activeCount })
    : t(pausedCount === 1 ? 'count.paused.one' : 'count.paused.other', { count: pausedCount })

  const mutate = async (id: string, run: () => Promise<unknown>): Promise<void> => {
    setBusyId(id)
    try {
      await run()
      await refresh()
    } finally {
      setBusyId(undefined)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          void refresh()
          setOpen(current => !current)
        }}
      >
        {activeCount > 0 ? <StateDot state="ongoing" className={css.triggerDot} /> : null}
        <span className={css.count}>{countLabel}</span>
        <IconChevronDownOutline14 className={open ? css.triggerOpen : undefined} />
      </button>
      {open
        ? (
          <ul className={css.menu} aria-label={t('list.aria')}>
            {rows.map((row) => {
              const paused = row.status === 'paused'
              const settled = row.status !== 'active' && row.status !== 'paused'
              const busy = busyId === row.id
              return (
                <li
                  key={row.id}
                  className={settled ? `${css.row} ${css.rowSettled}` : css.row}
                  aria-label={t('row.aria', { prompt: row.prompt })}
                >
                  <StateDot state={dotState(row.status)} className={css.rowDot} />
                  <span className={css.label} title={row.prompt}>{row.prompt}</span>
                  <span className={css.due} title={dueLabel(row, t)}>{dueLabel(row, t)}</span>
                  {settled
                    ? null
                    : (
                      <span className={css.actions}>
                        <button
                          type="button"
                          className={css.action}
                          disabled={busy}
                          onClick={() => {
                            void mutate(row.id, () => onUpdate(row.id, {
                              status: paused ? 'active' : 'paused',
                            }))
                          }}
                        >
                          {paused ? t('action.resume') : t('action.pause')}
                        </button>
                        <button
                          type="button"
                          className={css.action}
                          disabled={busy}
                          onClick={() => {
                            void mutate(row.id, () => onRemove(row.id))
                          }}
                        >
                          {t('action.delete')}
                        </button>
                      </span>
                    )}
                </li>
              )
            })}
          </ul>
        )
        : null}
    </div>
  )
}
