import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerAdminView, PeerSessionSummary, PeerSurface } from '@deepseek-ai/dsh-peer-host/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { resultError } from './issues.ts'
import css from './peers.module.css'

/** The observable tick shared through the hooks compartment: every forwarded pairing event bumps it. */
export interface PeerTickSource {
  getSnapshot(): number
  subscribe(listener: () => void): () => void
}

/** The governance verbs the host peer namespace exposes behind the administer capability. */
export interface PeersActions {
  list: () => Promise<RemoteResult<{ peers: PeerAdminView[] }>>
  remove: (input: { instanceId: string }) => Promise<RemoteResult<void>>
  setSurface: (input: { instanceId: string; surface: PeerSurface }) => Promise<RemoteResult<PeerAdminView>>
  approveSurface: (input: { instanceId: string }) => Promise<RemoteResult<PeerAdminView>>
  rejectSurface: (input: { instanceId: string }) => Promise<RemoteResult<PeerAdminView>>
  setBudget: (input: { instanceId: string; monthlyTurns?: number; monthlyBytes?: number }) => Promise<RemoteResult<PeerAdminView>>
  audit: (input: { instanceId: string }) => Promise<RemoteResult<{ sessions: PeerSessionSummary[] }>>
}

export type PeersViewProps =
  PropsRuntime<'dashboard.center.tab'>
  & InjectFace<PeersActions & { hooks: { peersTick: PeerTickSource } }>
  & PropsLocale<typeof NS>

/** One grant line's toggle state kept while the owner edits a surface. */
type SurfaceDraft = PeerSurface

const GRANTS: ReadonlyArray<keyof PeerSurface> = ['delegate', 'message', 'list', 'artifacts']

/** Upper bound of the MiB figure the byte-budget form accepts; 1 TiB in bytes. */
const BYTES_MAX_MIB = 1024 * 1024

/** Localize one grant's label.
 * @param t - the localized copy face.
 * @param grant - the grant to name.
 * @returns the localized label. */
function grantLabel(t: PeersViewProps['t'], grant: keyof PeerSurface): string {
  return t(grant === 'delegate' ? 'grantDelegate' : grant === 'message' ? 'grantMessage' : grant === 'list' ? 'grantList' : 'grantArtifacts')
}

/** Localize one session's live state.
 * @param t - the localized copy face.
 * @param state - the derived lifecycle state.
 * @returns the localized label. */
function stateLabel(t: PeersViewProps['t'], state: PeerSessionSummary['state']): string {
  return state === 'running' ? t('sessionRunning') : state === 'idle' ? t('sessionIdle') : t('sessionEnded')
}

/** Render one surface as the four grant badges.
 * @param t - the localized copy face.
 * @param surface - the surface to render.
 * @returns the badge row. */
function surfaceBadges(t: PeersViewProps['t'], surface: PeerSurface) {
  return (
    <span className={css.badges}>
      {GRANTS.map(grant => (
        <span key={grant} className={`${css.badge} ${surface[grant] ? css.badgeOn : css.badgeOff}`}>
          {grantLabel(t, grant)}
          {surface[grant] ? '' : ` (${t('grantOff')})`}
        </span>
      ))}
    </span>
  )
}

export function PeersView({
  list, remove, setSurface, approveSurface, rejectSurface, setBudget, audit, usePeersTick, t,
}: PeersViewProps) {
  const [peers, setPeers] = useState<PeerAdminView[]>([])
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [confirming, setConfirming] = useState<string | undefined>()
  const [editingSurface, setEditingSurface] = useState<string | undefined>()
  const [draft, setDraft] = useState<SurfaceDraft>({ delegate: true, message: true, list: true, artifacts: true })
  const [budgetDraft, setBudgetDraft] = useState<string>('')
  const [bytesDraft, setBytesDraft] = useState<string>('')
  const [budgetError, setBudgetError] = useState<string | undefined>()
  const [auditOf, setAuditOf] = useState<string | undefined>()
  const [sessions, setSessions] = useState<PeerSessionSummary[]>([])
  const tick = usePeersTick(value => value)
  const refreshGeneration = useRef(0)

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    try {
      const result = await list()
      if (generation !== refreshGeneration.current) return
      if (result.ok) {
        setPeers(result.value.peers)
        setError(undefined)
      } else {
        setError(resultError(t, result)?.message)
      }
    } catch (cause) {
      if (generation === refreshGeneration.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }, [list, t])

  useEffect(() => {
    void refresh()
    return () => { refreshGeneration.current++ }
  }, [refresh, tick])

  /** Run one governance verb with busy marking and roster refresh.
   * @param id - the peer the verb addresses.
   * @param verb - the action to run. */
  const run = async (id: string, verb: () => Promise<void>): Promise<void> => {
    setBusy(id)
    try {
      await verb()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  /** Apply one Remote result, surfacing its failure as the view error.
   * @param result - the verb's Remote result.
   * @returns whether the result succeeded. */
  const accept = (result: RemoteResult<unknown>): boolean => {
    const failure = resultError(t, result)
    if (failure === undefined) return true
    setError(failure.message)
    return false
  }

  /** Toggle one grant in the editing draft.
   * @param grant - the grant to flip. */
  const flip = (grant: keyof PeerSurface): void => {
    setDraft(current => ({ ...current, [grant]: !current[grant] }))
  }

  /** Load one peer's audit rows, or collapse an open audit.
   * @param peer - the peer to audit. */
  const toggleAudit = (peer: PeerAdminView): void => {
    if (auditOf === peer.instanceId) {
      setAuditOf(undefined)
      return
    }
    setAuditOf(peer.instanceId)
    setSessions([])
    void run(peer.instanceId, async () => {
      const result = await audit({ instanceId: peer.instanceId })
      if (result.ok) setSessions(result.value.sessions)
      else setError(resultError(t, result)?.message)
    })
  }

  // A per-card const binding keeps the pending-surface narrowing alive inside JSX closures.
  const cards = peers.map(peer => ({ peer, parked: peer.pendingSurface }))
  return (
    <div className={css.view}>
      <header className={css.header}>
        <span className={css.title}>{t('title')}</span>
        <button type="button" className={css.button} onClick={() => { void refresh() }}>{t('refresh')}</button>
      </header>
      <div className={css.body}>
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
        {peers.length === 0 && error === undefined && <p className={css.empty}>{t('empty')}</p>}
        {cards.map(({ peer, parked }) => (
          <section key={peer.instanceId} className={css.card}>
            <div className={css.cardHead}>
              <div className={css.identity}>
                <span className={css.name}>{peer.displayName}</span>
                <span className={css.meta}>{peer.platform}/{peer.arch} · {peer.version}</span>
                <span className={css.meta}>{peer.instanceId}</span>
              </div>
              <div className={css.cardActions}>
                {peer.sessionCount > 0
                  ? (
                    <button type="button" className={css.button} onClick={() => { toggleAudit(peer) }} disabled={busy === peer.instanceId}>
                      {auditOf === peer.instanceId ? t('collapse') : t('expand')}
                    </button>
                  )
                  : <span className={css.meta}>{t('sessionCount', { count: String(peer.sessionCount) })}</span>}
                {confirming === peer.instanceId
                  ? (
                    <span className={css.confirm}>
                      <button type="button" className={css.danger} onClick={() => {
                        void run(peer.instanceId, async () => { accept(await remove({ instanceId: peer.instanceId })) })
                        setConfirming(undefined)
                      }} disabled={busy === peer.instanceId}>{t('confirmRemove')}</button>
                      <button type="button" className={css.button} onClick={() => { setConfirming(undefined) }}>{t('reject')}</button>
                    </span>
                  )
                  : (
                    <button type="button" className={css.button} onClick={() => { setConfirming(peer.instanceId) }} disabled={busy === peer.instanceId}>
                      {t('remove')}
                    </button>
                  )}
              </div>
            </div>
            <p className={css.meta}>{t('lastSeen', { at: peer.lastSeenAt })} · {t('statusActive')}</p>
            <div className={css.row}>
              <span className={css.label}>{t('surfaceSection')}</span>
              {editingSurface === peer.instanceId
                ? (
                  <span className={css.editor}>
                    {GRANTS.map(grant => (
                      <label key={grant} className={css.toggle}>
                        <input
                          type="checkbox"
                          checked={draft[grant]}
                          onChange={() => { flip(grant) }}
                        />
                        {grantLabel(t, grant)}
                      </label>
                    ))}
                    <button type="button" className={css.button} onClick={() => {
                      void run(peer.instanceId, async () => { accept(await setSurface({ instanceId: peer.instanceId, surface: draft })) })
                      setEditingSurface(undefined)
                    }} disabled={busy === peer.instanceId}>{t('saveSurface')}</button>
                    <button type="button" className={css.button} onClick={() => { setEditingSurface(undefined) }}>{t('collapse')}</button>
                  </span>
                )
                : (
                  <span className={css.editor}>
                    {surfaceBadges(t, peer.surface)}
                    <button type="button" className={css.button} onClick={() => {
                      setDraft(peer.surface)
                      setEditingSurface(peer.instanceId)
                    }}>{t('editSurface')}</button>
                  </span>
                )}
            </div>
            {parked !== undefined && (
              <div className={css.pending}>
                <span>{t('pendingBanner', { surface: GRANTS.filter(grant => parked[grant]).map(grant => grantLabel(t, grant)).join(' + ') })}</span>
                <span className={css.confirm}>
                  <button type="button" className={css.button} onClick={() => {
                    void run(peer.instanceId, async () => { accept(await approveSurface({ instanceId: peer.instanceId })) })
                  }} disabled={busy === peer.instanceId}>{t('approve')}</button>
                  <button type="button" className={css.button} onClick={() => {
                    void run(peer.instanceId, async () => { accept(await rejectSurface({ instanceId: peer.instanceId })) })
                  }} disabled={busy === peer.instanceId}>{t('reject')}</button>
                </span>
              </div>
            )}
            <div className={css.row}>
              <span className={css.label}>{t('budgetSection')}</span>
              <span className={css.editor}>
                {peer.monthlyTurns === undefined
                  ? <span className={css.meta}>{t('budgetUnlimited')}</span>
                  : <span className={css.meta}>{t('budgetUsage', { used: String(peer.monthlyTurnsUsed), limit: String(peer.monthlyTurns), period: peer.monthlyTurnPeriod })}</span>}
                {peer.monthlyBytes === undefined
                  ? <span className={css.meta}>{t('bytesUnlimited')}</span>
                  : <span className={css.meta}>{t('bytesUsage', { used: String(Math.ceil(peer.monthlyBytesUsed / (1024 * 1024))), limit: String(Math.round(peer.monthlyBytes / (1024 * 1024))) })}</span>}
                <input
                  className={css.input}
                  type="text"
                  placeholder={t('budgetPlaceholder')}
                  value={budgetDraft}
                  onChange={(event) => { setBudgetDraft(event.currentTarget.value); setBudgetError(undefined) }}
                />
                <input
                  className={css.input}
                  type="text"
                  placeholder={t('bytesPlaceholder')}
                  value={bytesDraft}
                  onChange={(event) => { setBytesDraft(event.currentTarget.value); setBudgetError(undefined) }}
                />
                <button type="button" className={css.button} onClick={() => {
                  const trimmed = budgetDraft.trim()
                  const bytesTrimmed = bytesDraft.trim()
                  const parsed = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN
                  const parsedBytes = /^[0-9]+$/.test(bytesTrimmed) ? Number(bytesTrimmed) : Number.NaN
                  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000
                    || !Number.isInteger(parsedBytes) || parsedBytes < 1 || parsedBytes > BYTES_MAX_MIB) {
                    setBudgetError(t('budgetInvalid'))
                    return
                  }
                  setBudgetError(undefined)
                  void run(peer.instanceId, async () => {
                    accept(await setBudget({ instanceId: peer.instanceId, monthlyTurns: parsed, monthlyBytes: parsedBytes * 1024 * 1024 }))
                  })
                }} disabled={busy === peer.instanceId}>{t('saveBudget')}</button>
                {(peer.monthlyTurns !== undefined || peer.monthlyBytes !== undefined) && (
                  <button type="button" className={css.button} onClick={() => {
                    void run(peer.instanceId, async () => { accept(await setBudget({ instanceId: peer.instanceId })) })
                  }} disabled={busy === peer.instanceId}>{t('clearBudget')}</button>
                )}
              </span>
            </div>
            {budgetError !== undefined && <p className={css.error} role="alert">{budgetError}</p>}
            {auditOf === peer.instanceId && (
              <div className={css.audit}>
                <span className={css.label}>{t('sessionsSection')}</span>
                {sessions.length === 0
                  ? <span className={css.meta}>{t('sessionCount', { count: '0' })}</span>
                  : (
                    <ul className={css.sessions}>
                      {sessions.map(entry => (
                        <li key={entry.sessionId}>
                          <span className={css.meta}>{stateLabel(t, entry.state)}</span>
                          <span className={css.meta}>{entry.lastActivityAt}</span>
                          <span className={css.meta}>{entry.label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
