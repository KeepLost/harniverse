/**
 * The "会话导入" settings section: the latest scan of the targeted machine's
 * official DeepSeek Harness sessions with their import status, a
 * multi-selection, the target workspace choice, an upload entry, and the
 * latest batch's outcomes with a way into each imported archive. The section
 * rescans whenever the targeted machine changes.
 */
import { useEffect, useId, useMemo } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { OfficialImportResult, OfficialSessionCandidate } from '@deepseek-ai/dsh-api-remotes/client'
import { DEFAULT_UPLOAD_LIMIT_BYTES, type SessionImportInjected } from './controller.ts'
import { formatBytes, formatTime } from './format.ts'
import type { NS } from './locales.ts'
import type { createSessionImportStore, TargetChoice } from './stores.ts'
import css from './SessionImportSection.module.css'

/** Full props composed by the `settings.section` slot. */
export type SessionImportSectionProps =
  PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createSessionImportStore>>
  & PropsLocale<typeof NS>
  & InjectFace<SessionImportInjected>

const SOURCE_CWD = 'source-cwd'

function targetValue(target: TargetChoice): string {
  return target.kind === 'source-cwd' ? SOURCE_CWD : target.workspaceId
}

function targetOf(value: string): TargetChoice {
  return value === SOURCE_CWD ? { kind: 'source-cwd' } : { kind: 'workspace', workspaceId: value }
}

function labelOf(item: OfficialSessionCandidate, t: TranslateNS<typeof NS>): string {
  return item.title ?? item.preview ?? t('row.untitled')
}

function outcomeText(result: OfficialImportResult, t: TranslateNS<typeof NS>): string {
  const { outcome } = result
  if (outcome.status === 'imported') {
    const head = outcome.attached ? t('result.imported') : t('result.importedDetached')
    return outcome.skippedEvents > 0 ? `${head} · ${t('result.skipped', { count: outcome.skippedEvents })}` : head
  }
  if (outcome.status === 'already-imported') return t('result.already')
  return t('result.failed', { message: `${t(`result.reason.${outcome.reason}`)} (${outcome.message})` })
}

/** The archive a settled result names, for its Open action. */
function archiveOf(result: OfficialImportResult): string | undefined {
  return result.outcome.status === 'failed' ? undefined : result.outcome.sessionId
}

/**
 * Render the session-import settings section.
 * @param props - the settings-section currency, the store seat, the operation face, and the translator.
 * @returns the section element.
 */
export function SessionImportSection(props: SessionImportSectionProps) {
  const { t, useStore, actions, useWorkspaces, useMachine, scan, importSelected, importFile, openSession, close } = props
  const state = useStore(snapshot => snapshot)
  const uploadHint = useId()
  const rowIds = useId()
  const workspaces = useWorkspaces(list => list.items)
  const machine = useMachine(target => target.kind === 'host' ? 'host' : `remote:${target.id}`)
  useEffect(() => {
    actions.reset()
    void scan()
  }, [machine, actions, scan])

  const items = useMemo(() => state.scan?.items ?? [], [state.scan])
  const labels = useMemo(() => Object.fromEntries(items.map(item => [item.sourceId, labelOf(item, t)])), [items, t])
  const importable = items.filter(item => item.status !== 'imported').map(item => item.sourceId)
  const limit = state.scan?.maxArtifactBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES
  const target = state.target
  const open = (sessionId: string) => {
    void openSession(sessionId).then((opened) => {
      if (opened) close()
      else actions.refuse(t('result.openError'))
    })
  }

  return (
    <section className={css.section} aria-label={t('title')}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.toolbar}>
        <Button size="sm" variant="outline" disabled={state.phase === 'scanning'} onClick={() => { void scan() }}>
          {state.phase === 'scanning' ? t('scanning') : t('scan')}
        </Button>
        {state.scan === null ? null : <span className={css.meta}>{t('roots', { paths: state.scan.roots.join(', ') })}</span>}
      </div>
      {state.scanError === null ? null : <p className={css.error} role="alert">{t('scanError', { message: state.scanError })}</p>}
      {state.phase === 'ready' && items.length === 0 ? <p className={css.meta} role="status">{t('empty')}</p> : null}
      {items.length === 0
        ? null
        : (
          <>
            <div className={css.toolbar}>
              <Button size="sm" variant="ghost" onClick={() => { actions.setSelected(importable) }}>{t('select.all')}</Button>
              <Button size="sm" variant="ghost" disabled={state.selected.length === 0} onClick={() => { actions.setSelected([]) }}>{t('select.none')}</Button>
            </div>
            <ul className={css.list} aria-label={t('list.label')}>
              {items.map((item, index) => (
                <li key={item.sourceId} className={css.row}>
                  <label className={css.rowLabel}>
                    <input
                      type="checkbox"
                      aria-labelledby={`${rowIds}-title-${String(index)}`}
                      aria-describedby={`${rowIds}-meta-${String(index)}`}
                      checked={state.selected.includes(item.sourceId)}
                      onChange={() => { actions.toggle(item.sourceId) }}
                    />
                    <span className={css.rowMain}>
                      <span id={`${rowIds}-title-${String(index)}`} className={css.rowTitle}>{labelOf(item, t)}</span>
                      <span id={`${rowIds}-meta-${String(index)}`} className={css.meta}>
                        {[item.sourceCwd ?? t('row.noCwd'), t('row.turns', { count: item.turns }), formatTime(item.updatedAt), formatBytes(item.sizeBytes)].join(' · ')}
                      </span>
                    </span>
                    <span className={css.status} data-status={item.status}>{t(`status.${item.status}`)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      {state.scan === null || state.scan.unreadable.length === 0
        ? null
        : (
          <details className={css.unreadable}>
            <summary>{t('unreadable.title', { count: state.scan.unreadable.length })}</summary>
            <ul>
              {state.scan.unreadable.map(entry => (
                <li key={entry.path} className={css.meta}>{`${t(`unreadable.${entry.reason}`)} · ${entry.path}`}</li>
              ))}
            </ul>
          </details>
        )}
      <div className={css.actions}>
        <label className={css.field}>
          <span className={css.label}>{t('target.label')}</span>
          <select
            className={css.select}
            value={targetValue(target)}
            onChange={(event) => { actions.setTarget(targetOf(event.currentTarget.value)) }}
          >
            <option value={SOURCE_CWD}>{t('target.sourceCwd')}</option>
            {workspaces.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
          </select>
        </label>
        <Button
          variant="primary"
          disabled={state.importing || state.selected.length === 0}
          onClick={() => { void importSelected(state.selected, target, labels) }}
        >
          {state.importing ? t('importing') : t('import.selected', { count: state.selected.length })}
        </Button>
      </div>
      <div className={css.field}>
        <label className={css.field}>
          <span className={css.label}>{t('upload.label')}</span>
          <input
            className={css.file}
            type="file"
            accept=".jsonl,.zstd"
            aria-describedby={uploadHint}
            disabled={state.importing}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) void importFile(file, target, limit)
            }}
          />
        </label>
        <span id={uploadHint} className={css.meta}>{t('upload.hint')}</span>
      </div>
      {state.uploadError === null ? null : <p className={css.error} role="alert">{state.uploadError}</p>}
      {state.results.length === 0
        ? null
        : (
          <div className={css.results} role="status">
            <h3 className={css.subtitle}>{t('results.title')}</h3>
            <ul className={css.list}>
              {state.results.map((result, index) => (
                <li key={`${result.source}-${String(index)}`} className={css.result} data-status={result.outcome.status}>
                  <span className={css.rowMain}>
                    <span className={css.rowTitle}>{result.label}</span>
                    <span className={css.meta}>{outcomeText(result, t)}</span>
                  </span>
                  {archiveOf(result) === undefined
                    ? null
                    : <Button size="sm" variant="outline" onClick={() => { open(archiveOf(result) as string) }}>{t('result.open')}</Button>}
                </li>
              ))}
            </ul>
          </div>
        )}
    </section>
  )
}
