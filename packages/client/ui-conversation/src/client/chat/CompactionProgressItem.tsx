import { memo, useEffect, useState } from 'react'
import type { CompactionProgressSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './MessageItem.module.css'

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

function phaseText(
  phase: CompactionProgressSnapshot['phase'],
  t: ChatViewSlotProps['t'],
): string {
  switch (phase) {
    case 'preparing': return t('message.compaction.progress.preparing')
    case 'reasoning': return t('message.compaction.progress.reasoning')
    case 'summary': return t('message.compaction.progress.summary')
    case 'failed': return t('message.compaction.progress.failed')
  }
}

/** Live compaction disclosure that stays visually aligned with the settled marker. */
export const CompactionProgressItem = memo(function CompactionProgressItem({
  progress,
  t,
}: {
  progress: CompactionProgressSnapshot
  t: ChatViewSlotProps['t']
}) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])

  const latest = latestLine(progress.summaryText || progress.reasoningText)
  const seconds = Math.max(0, Math.floor((now - progress.startedAt) / 1000))
  const phase = phaseText(progress.phase, t)
  return (
    <div className={css.compactionProgress} data-state={progress.phase} role="status" aria-live="polite">
      <button
        type="button"
        className={css.compactionProgressButton}
        aria-expanded={expanded}
        aria-label={t('message.compaction.progress.toggle')}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon}>
            <IconApiOutline14 />
          </span>
          <span className={css.compactionDisclosureIcon}>
            {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
        <span className={css.compactionTitle} data-failed={progress.phase === 'failed' || undefined}>
          {progress.phase === 'failed' ? t('message.compaction.progress.failedTitle') : t('message.compaction.progress.title')}
        </span>
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionProgressPhase}>{phase}</span>
        <span className={css.compactionSummary} data-follow-end={progress.phase !== 'preparing' || undefined}>
          {latest || progress.error || t('message.compaction.progress.waiting')}
        </span>
        <time className={css.compactionProgressClock} dateTime={`PT${seconds}S`}>
          {t('message.compaction.progress.elapsed', { seconds })}
        </time>
      </button>
      {expanded && (
        <div className={css.compactionProgressBody}>
          {progress.reasoningText.length > 0 && (
            <section>
              <div className={css.compactionProgressLabel}>{t('message.compaction.progress.reasoning')}</div>
              <div className={css.compactionProgressReasoning}>{progress.reasoningText}</div>
            </section>
          )}
          {progress.summaryText.length > 0 && (
            <section>
              <div className={css.compactionProgressLabel}>{t('message.compaction.progress.summary')}</div>
              <div className={css.compactionProgressSummary}>{progress.summaryText}</div>
            </section>
          )}
          {progress.error !== undefined && (
            <div className={css.compactionProgressError}>{progress.error}</div>
          )}
        </div>
      )}
    </div>
  )
})
