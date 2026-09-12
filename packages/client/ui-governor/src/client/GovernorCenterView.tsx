import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { GovernorOverview, SessionResourceRow } from '@deepseek-ai/dsh-governor/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createGovernorViewStore } from './stores.ts'
import { NS } from './locales.ts'
import css from './GovernorCenterView.module.css'

/** Injected business face of the board (the governor Remote verbs). */
export interface GovernorCenterActions {
  overview: () => Promise<RemoteResult<GovernorOverview>>
  adjustQuota: (sessionId: string, memoryBytes: number | null) => Promise<RemoteResult<unknown>>
  closeView: () => void
  pollMs: number
}

/** Full props composed by the center-view slot. */
export type GovernorCenterViewProps =
  PropsRuntime<'center.view'>
  & PropsStore<ReturnType<typeof createGovernorViewStore>>
  & InjectFace<GovernorCenterActions>
  & PropsLocale<typeof NS>

type LoadState = 'loading' | 'ready' | 'error'

/** Format a byte count into the dictionary's unit scale. */
function formatBytes(bytes: number, t: PropsLocale<typeof NS>['t']): string {
  if (bytes >= 1024 ** 3) return t('units.gib', { value: (bytes / 1024 ** 3).toFixed(1) })
  if (bytes >= 1024 ** 2) return t('units.mib', { value: (bytes / 1024 ** 2).toFixed(1) })
  if (bytes >= 1024) return t('units.kib', { value: (bytes / 1024).toFixed(1) })
  return t('units.bytes', { value: String(bytes) })
}

/**
 * The sessions-as-processes board: one row per session with live metering,
 * quota state, breach badges, and inline quota negotiation; a header with
 * the enforcement tier and global budget bar; host disk/network sentinels
 * in the footer.
 * @param props - center slot currency, the shared store, the Remote verbs, and the translator.
 * @returns the board surface.
 */
export function GovernorCenterView({ actions, overview: fetchOverview, adjustQuota, closeView, pollMs, t }: GovernorCenterViewProps) {
  const [state, setState] = useState<LoadState>('loading')
  const [overview, setOverview] = useState<GovernorOverview | undefined>(undefined)
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => { actions.setOpen(true); return () => { actions.setOpen(false) } }, [actions])

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

  const rows = overview?.sessions ?? []
  const globalPct = overview !== undefined && overview.globalLimitBytes > 0
    ? Math.min(100, Math.round(overview.liveRssBytes / overview.globalLimitBytes * 100))
    : 0

  return (
    <section className={css.view} aria-label={t('view.title')}>
      <header className={css.header}>
        <div className={css.headerMain}>
          <h2 className={css.title}>{t('view.title')}</h2>
          {overview !== undefined ? <span className={css.tier}>{t(`tier.${overview.tier}` as const)}</span> : null}
        </div>
        <div className={css.headerActions}>
          <button type="button" className={css.button} onClick={() => { void refresh() }}>{t('view.refresh')}</button>
          <button type="button" className={css.button} onClick={closeView}>{t('view.close')}</button>
        </div>
      </header>
      {overview !== undefined ? (
        <div className={css.global}>
          <span>{t('global.usage', { used: formatBytes(overview.liveRssBytes, t), limit: formatBytes(overview.globalLimitBytes, t) })}</span>
          <span className={css.bar} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={globalPct}>
            <span className={css.barFill} style={{ width: `${globalPct}%` }} />
          </span>
          {overview.hostFreeBytes !== undefined ? <span>{t('host.free', { free: formatBytes(overview.hostFreeBytes, t) })}</span> : null}
          {overview.hostNetRxBytes !== undefined && overview.hostNetTxBytes !== undefined
            ? <span>{t('host.net', { rx: formatBytes(overview.hostNetRxBytes, t), tx: formatBytes(overview.hostNetTxBytes, t) })}</span>
            : null}
        </div>
      ) : null}
      {state === 'loading' ? <p className={css.note}>{t('view.loading')}</p> : null}
      {state === 'error' ? (
        <p className={css.note}>
          {t('view.error')}
          <button type="button" className={css.button} onClick={() => { void refresh() }}>{t('view.retry')}</button>
        </p>
      ) : null}
      {state === 'ready' && rows.length === 0 ? <p className={css.note}>{t('view.empty')}</p> : null}
      {state === 'ready' && rows.length > 0 ? (
        <table className={css.table}>
          <thead>
            <tr>
              <th scope="col">{t('table.session')}</th>
              <th scope="col">{t('table.commands')}</th>
              <th scope="col">{t('table.cpu')}</th>
              <th scope="col">{t('table.memory')}</th>
              <th scope="col">{t('table.quota')}</th>
              <th scope="col">{t('table.breaches')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <SessionRow
                key={row.sessionId}
                row={row}
                busy={busy}
                draft={quotaDrafts[row.sessionId] ?? ''}
                onDraft={(value) => { setQuotaDrafts(current => ({ ...current, [row.sessionId]: value })) }}
                onApply={() => {
                  const draft = quotaDrafts[row.sessionId] ?? ''
                  const mib = Number(draft)
                  const bytes = draft.trim().length === 0 || !Number.isFinite(mib) || mib <= 0 ? null : Math.round(mib * 1024 * 1024)
                  void mutate(() => adjustQuota(row.sessionId, bytes))
                }}
                onClear={() => { void mutate(() => adjustQuota(row.sessionId, null)) }}
                t={t}
              />
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}

/** Props of one board row. */
interface SessionRowProps {
  readonly row: SessionResourceRow
  readonly busy: boolean
  readonly draft: string
  readonly onDraft: (value: string) => void
  readonly onApply: () => void
  readonly onClear: () => void
  readonly t: PropsLocale<typeof NS>['t']
}

/** One session rendered as a process row. */
function SessionRow({ row, busy, draft, onDraft, onApply, onClear, t }: SessionRowProps) {
  const pct = useMemo(() => {
    const limit = row.quota.effectiveLimitBytes
    const ratio = limit > 0 ? row.rssBytes / limit : 0
    return Math.min(100, Math.round(ratio * 100))
  }, [row.rssBytes, row.quota.effectiveLimitBytes])
  return (
    <tr>
      <td className={css.session} title={row.sessionId}>{row.sessionId}</td>
      <td>{row.commands}</td>
      <td>{row.cpuTicks}</td>
      <td>
        <div className={css.memoryCell}>
          <span>{formatBytes(row.rssBytes, t)} / {formatBytes(row.quota.effectiveLimitBytes, t)}</span>
          <span className={css.bar} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span className={pct >= 90 ? css.barFillHot : css.barFill} style={{ width: `${pct}%` }} />
          </span>
        </div>
      </td>
      <td>
        <div className={css.quotaCell}>
          <span>{row.quota.shared ? t('quota.shared') : /* v8 ignore next 1 -- non-shared rows always carry a quota (the builder sets
             quotaBytes exactly when the override exists); the fallback only narrows the type. */
            formatBytes(row.quota.quotaBytes ?? 0, t)}</span>
          <input
            className={css.quotaInput}
            type="number"
            min={1}
            placeholder={t('quota.set')}
            value={draft}
            disabled={busy}
            onChange={(event) => { onDraft(event.target.value) }}
          />
          <button type="button" className={css.button} disabled={busy} onClick={onApply}>{t('quota.apply')}</button>
          {!row.quota.shared
            ? <button type="button" className={css.button} disabled={busy} onClick={onClear}>{t('quota.clear')}</button>
            : null}
        </div>
      </td>
      <td>
        {row.breaches.length === 0 ? '—' : row.breaches.map((breach, index) => (
          <span key={index} className={css.breach} title={String(breach.at)}>{t(`breach.${breach.kind}` as const)}</span>
        ))}
      </td>
    </tr>
  )
}
