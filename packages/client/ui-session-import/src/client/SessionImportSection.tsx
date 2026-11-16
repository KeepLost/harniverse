/**
 * The "会话导入" settings section: the latest scan of the targeted machine's
 * official DeepSeek Harness sessions with their import status, a
 * multi-selection, the target workspace choice, an upload entry, and the
 * latest batch's outcomes with a way into each imported archive. The section
 * rescans whenever the targeted machine changes.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, Select } from '@deepseek-ai/dsh-client-ui-primitives'
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
  const picker = useRef<HTMLInputElement>(null)
  const chatHint = useId()
  const chatPicker = useRef<HTMLInputElement>(null)
  const [chatProgress, setChatProgress] = useState<{ done: number; total: number } | null>(null)
  const [chatOutcome, setChatOutcome] = useState<string | null>(null)

  /** Stream one DeepSeek export ZIP through the NDJSON upload route, then rescan. */
  const importChatExport = async (file: File): Promise<void> => {
    setChatOutcome(null)
    if (target.kind !== 'workspace') {
      setChatOutcome(t('chat.needWorkspace'))
      return
    }
    setChatProgress({ done: 0, total: 0 })
    try {
      const base = new URL(document.baseURI)
      const response = await fetch(new URL(`api/deepseek-chat-import/archive?workspaceId=${encodeURIComponent(target.workspaceId)}`, base), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      const summary = { text: null as string | null }
      const handleLine = (text: string): void => {
        if (text.length === 0) return
        const line = JSON.parse(text) as {
          type: string
          done?: number
          total?: number
          outcome?: { ok: boolean; value?: { sessionIds: string[]; skipped: unknown[] }; error?: { message: string } }
        }
        if (line.type === 'progress') setChatProgress({ done: line.done ?? 0, total: line.total ?? 0 })
        if (line.type === 'outcome') {
          const outcome = line.outcome
          summary.text = outcome !== undefined && outcome.ok
            ? t('chat.done', { count: outcome.value?.sessionIds.length ?? 0, skipped: outcome.value?.skipped.length ?? 0 })
            : t('chat.failed', { message: outcome?.error?.message ?? `HTTP ${String(response.status)}` })
        }
      }
      if (reader !== undefined) {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          pending += decoder.decode(chunk.value, { stream: true })
          let end: number
          while ((end = pending.indexOf('\n')) !== -1) {
            handleLine(pending.slice(0, end))
            pending = pending.slice(end + 1)
          }
        }
      }
      handleLine(pending)
      setChatOutcome(summary.text ?? t('chat.failed', { message: 'the response ended without an outcome' }))
    } catch (error) {
      setChatOutcome(t('chat.failed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setChatProgress(null)
      void scan()
    }
  }
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
          <Select
            className={css.select}
            value={targetValue(target)}
            onChange={(event) => { actions.setTarget(targetOf(event.currentTarget.value)) }}
          >
            <option value={SOURCE_CWD}>{t('target.sourceCwd')}</option>
            {workspaces.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
          </Select>
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
        <span className={css.label}>{t('upload.label')}</span>
        <div className={css.toolbar}>
          <input
            ref={picker}
            type="file"
            hidden
            accept=".jsonl,.zstd"
            aria-label={t('upload.label')}
            aria-describedby={uploadHint}
            disabled={state.importing}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) void importFile(file, target, limit)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            aria-describedby={uploadHint}
            disabled={state.importing}
            onClick={() => { (picker.current as HTMLInputElement).click() }}
          >
            {t('upload.choose')}
          </Button>
        </div>
        <span id={uploadHint} className={css.meta}>{t('upload.hint')}</span>
      </div>
      <div className={css.field}>
        <span className={css.label}>{t('chat.label')}</span>
        <div className={css.toolbar}>
          <input
            ref={chatPicker}
            type="file"
            hidden
            accept=".zip"
            aria-label={t('chat.label')}
            aria-describedby={chatHint}
            disabled={chatProgress !== null}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) void importChatExport(file)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            aria-describedby={chatHint}
            disabled={chatProgress !== null}
            onClick={() => { (chatPicker.current as HTMLInputElement).click() }}
          >
            {t('chat.choose')}
          </Button>
          {chatProgress === null ? null : (
            <span className={css.meta} role="status">{t('chat.progress', chatProgress)}</span>
          )}
        </div>
        <span id={chatHint} className={css.meta}>{t('chat.hint')}</span>
        {chatOutcome === null ? null : <p className={css.meta} role="status">{chatOutcome}</p>}
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
