/**
 * The session-quota list: one row per quota-limited session, arranged like
 * the sidebar's session rows (status slot, title, meta line, trailing
 * value). Unlimited sessions stay off the list; the add-limit picker at the
 * bottom selects any known session and applies its first quota. Data rides
 * the same governor Remote verbs as the resources tab.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GovernorOverview, SessionResourceRow } from '@deepseek-ai/dsh-governor/client'
import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatBytes } from './bytes.ts'
import type { GovernorResourcesActions } from './GovernorResourcesTab.tsx'
import { NS } from './locales.ts'
import css from './GovernorQuotaTab.module.css'

/** Full props composed by the dashboard.center.tab slot. */
export type GovernorQuotaTabProps =
  PropsRuntime<'dashboard.center.tab'>
  & InjectFace<GovernorResourcesActions>
  & PropsLocale<typeof NS>

/** Coarse status dot mirroring the sidebar row's slot semantics. */
function dotState(summary: { running: boolean; pendingInteraction?: unknown; completed?: boolean } | undefined): 'warning' | 'ongoing' | 'done' | null {
  if (summary === undefined) return null
  if (summary.pendingInteraction !== undefined) return 'warning'
  if (summary.running) return 'ongoing'
  if (summary.completed) return 'done'
  return null
}

/** Parse one MiB draft into bytes; null while empty or invalid. */
function draftBytes(draft: string): number | null {
  const mib = Number(draft)
  return draft.trim().length === 0 || !Number.isFinite(mib) || mib <= 0 ? null : Math.round(mib * 1024 * 1024)
}

/**
 * The quota list tab: limited sessions as sidebar-style rows with inline
 * adjust/clear, plus the add-limit picker over the sessions feed.
 * @param props - tab slot currency, the governor Remote verbs, and the translator.
 * @returns the quota list surface.
 */
export function GovernorQuotaTab({ useSessions, overview: fetchOverview, adjustQuota, pollMs, t }: GovernorQuotaTabProps) {
  const sessionsById = useSessions(list => list.byId as Record<string, SessionSummary>)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [overview, setOverview] = useState<GovernorOverview | undefined>(undefined)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [pickId, setPickId] = useState('')
  const [pickDraft, setPickDraft] = useState('')

  const refresh = useCallback(async () => {
    const result = await fetchOverview()
    if (!result.ok) {
      setState('error')
      return
    }
    setOverview(result.value)
    setState('ready')
  }, [fetchOverview])

  useEffect(() => {
    void refresh()
    const poll = setInterval(() => { void refresh() }, pollMs)
    return () => { clearInterval(poll) }
  }, [refresh, pollMs])

  const mutate = useCallback(async (run: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await run()
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const limited = useMemo(
    () => (overview?.sessions ?? []).filter(row => !row.quota.shared),
    [overview],
  )
  const limitedIds = useMemo(() => new Set(limited.map(row => row.sessionId)), [limited])
  const pickable = useMemo(
    () => Object.values(sessionsById).filter(summary => !limitedIds.has(summary.id)),
    [sessionsById, limitedIds],
  )

  return (
    <div className={css.tabBody}>
      <div className={css.tabToolbar}>
        <span className={css.intro}>{t('quotaList.intro')}</span>
        <button type="button" className={css.button} onClick={() => { void refresh() }}>{t('view.refresh')}</button>
      </div>
      {state === 'loading' ? <p className={css.note}>{t('view.loading')}</p> : null}
      {state === 'error' ? (
        <p className={css.note}>
          {t('view.error')}
          <button type="button" className={css.button} onClick={() => { void refresh() }}>{t('view.retry')}</button>
        </p>
      ) : null}
      {state === 'ready' && limited.length === 0 ? <p className={css.note}>{t('quotaList.empty')}</p> : null}
      {state === 'ready' && limited.length > 0 ? (
        <ul className={css.list}>
          {limited.map(row => (
            <QuotaRow
              key={row.sessionId}
              row={row}
              busy={busy}
              draft={drafts[row.sessionId] ?? ''}
              dot={dotState(sessionsById[row.sessionId])}
              label={sessionsById[row.sessionId]?.displayTitle ?? row.sessionId}
              onDraft={(value) => { setDrafts(current => ({ ...current, [row.sessionId]: value })) }}
              onApply={() => { void mutate(() => adjustQuota(row.sessionId, draftBytes(drafts[row.sessionId] ?? ''))) }}
              onClear={() => { void mutate(() => adjustQuota(row.sessionId, null)) }}
              t={t}
            />
          ))}
        </ul>
      ) : null}
      <div className={css.picker}>
        <span className={css.pickerLabel}>{t('quotaList.add')}</span>
        <select
          className={css.select}
          value={pickId}
          disabled={busy || pickable.length === 0}
          aria-label={t('quotaList.add.pick')}
          onChange={(event) => { setPickId(event.target.value) }}
        >
          <option value="">{t('quotaList.add.pick')}</option>
          {pickable.map(summary => (
            <option key={summary.id} value={summary.id}>{summary.displayTitle}</option>
          ))}
        </select>
        <input
          className={css.pickerInput}
          type="number"
          min={1}
          placeholder={t('quota.set')}
          value={pickDraft}
          disabled={busy || pickId === ''}
          onChange={(event) => { setPickDraft(event.target.value) }}
        />
        <button
          type="button"
          className={css.button}
          disabled={busy || pickId === '' || draftBytes(pickDraft) === null}
          onClick={() => {
            // Disabled guarantees a valid draft; the assertion records that invariant.
            const bytes = draftBytes(pickDraft) as number
            void mutate(async () => {
              await adjustQuota(pickId, bytes)
              setPickId('')
              setPickDraft('')
            })
          }}
        >
          {t('quotaList.add.apply')}
        </button>
      </div>
    </div>
  )
}

/** Props of one quota row. */
interface QuotaRowProps {
  readonly row: SessionResourceRow
  readonly busy: boolean
  readonly draft: string
  readonly dot: 'warning' | 'ongoing' | 'done' | null
  readonly label: string
  readonly onDraft: (value: string) => void
  readonly onApply: () => void
  readonly onClear: () => void
  readonly t: PropsLocale<typeof NS>['t']
}

/** One limited session rendered as a sidebar-style row. */
function QuotaRow({ row, busy, draft, dot, label, onDraft, onApply, onClear, t }: QuotaRowProps) {
  /* v8 ignore next 1 -- the host sets quotaBytes exactly when an override
     exists, so shared === false implies a defined quota; 0 narrows the type. */
  const quotaBytes = row.quota.quotaBytes ?? 0
  const pct = quotaBytes > 0 ? Math.min(100, Math.round(row.rssBytes / quotaBytes * 100)) : 0
  return (
    <li className={css.row} title={row.sessionId}>
      <span className={css.slot}>{dot !== null ? <StateDot state={dot} /> : null}</span>
      <span className={css.main}>
        <span className={css.titleRow}>
          <span className={css.title}>{label}</span>
          <span className={css.quotaValue}>{formatBytes(quotaBytes, t)}</span>
        </span>
        <span className={css.meta}>
          <span>{t('quotaList.usage', { used: formatBytes(row.rssBytes, t), pct: String(pct) })}</span>
          <span className={css.bar} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span className={pct >= 90 ? css.barFillHot : css.barFill} style={{ width: `${pct}%` }} />
          </span>
        </span>
      </span>
      <span className={css.actions}>
        <input
          className={css.input}
          type="number"
          min={1}
          placeholder={t('quotaList.adjust')}
          value={draft}
          disabled={busy}
          onChange={(event) => { onDraft(event.target.value) }}
        />
        <button type="button" className={css.button} disabled={busy} onClick={onApply}>{t('quota.apply')}</button>
        <button type="button" className={css.button} disabled={busy} onClick={onClear}>{t('quotaList.clear')}</button>
      </span>
    </li>
  )
}
