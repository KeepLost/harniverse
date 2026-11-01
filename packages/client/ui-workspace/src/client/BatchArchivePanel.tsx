import { useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionArchiveActiveError } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import css from './ArchivePanel.module.css'

type Translate = WorkspaceBrowserProps['t']

interface BatchArchivePanelProps {
  items: readonly SessionSummary[]
  archiveSession: WorkspaceBrowserProps['archiveSession']
  t: Translate
}

/**
 * Batch-archive picker over the live session account: checkbox rows plus
 * select-all, archiving each checked session in order. Active sessions are
 * the host's call — a SESSION_ACTIVE refusal surfaces as an explicit
 * per-session line in the alert and the row stays until it goes quiet.
 */
export function BatchArchivePanel({ items, archiveSession, t }: BatchArchivePanelProps) {
  const [selected, setSelected] = useState<SessionId[]>([])
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<string | null>(null)

  const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items])
  const allSelected = items.length > 0 && items.every(item => selected.includes(item.id))

  // The archive-set echo drops rows as they land; a selection member that
  // left the live account must not survive into the next batch.
  useEffect(() => {
    setSelected(ids => ids.filter(id => byId.has(id)))
  }, [byId])

  const confirm = (): void => {
    setBusy(true)
    setFailures(null)
    void (async () => {
      const failed: string[] = []
      for (const item of items) {
        if (!selected.includes(item.id)) continue
        try {
          await archiveSession(item.id)
        } catch (reason: unknown) {
          failed.push(reason instanceof SessionArchiveActiveError
            ? t('batchArchive.activeSkipped', { name: item.displayTitle })
            : `${item.displayTitle}: ${reason instanceof Error ? reason.message : String(reason)}`)
        }
      }
      setFailures(failed.length > 0 ? failed.join('\n') : null)
      setBusy(false)
    })()
  }

  return (
    <section className={css.root} aria-label={t('batchArchive.title')}>
      <div className={css.toolbar}>
        <label className={css.selectAll}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => { setSelected(allSelected ? [] : items.map(item => item.id)) }}
            aria-label={t('batchArchive.selectAll')}
          />
          <span>{t('archive.selected', { n: selected.length })}</span>
        </label>
        <Button variant="outline" disabled={busy || selected.length === 0} onClick={confirm}>
          {busy ? t('batchArchive.busy') : t('batchArchive.action')}
        </Button>
      </div>
      {items.length === 0 && <div className={css.empty}>{t('batchArchive.empty')}</div>}
      <div className={css.list} role="list">
        {items.map(item => (
          <div key={item.id} className={css.row} role="listitem">
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={() => {
                setSelected(ids => ids.includes(item.id)
                  ? ids.filter(candidate => candidate !== item.id)
                  : [...ids, item.id])
              }}
              aria-label={t('batchArchive.select', { name: item.displayTitle })}
            />
            <span className={css.rowBody}>
              <span className={css.rowTitle}>{item.displayTitle}</span>
              <span className={css.rowMeta}>{item.running ? t('status.running') : item.cwd ?? item.id}</span>
            </span>
          </div>
        ))}
      </div>
      {failures !== null && <div className={css.error} role="alert">{failures}</div>}
    </section>
  )
}
