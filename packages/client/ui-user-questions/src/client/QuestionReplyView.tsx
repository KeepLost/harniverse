/** Settled question batches rendered as right-aligned user-style bubbles. */
import { memo, useCallback, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14, IconCopyOutline16,
  Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuestionReplyData } from './question-reply.ts'
import { replyAnswerValues, replyClipboardText } from './question-reply.ts'
import css from './QuestionReplyView.module.css'

type QuestionReplyViewProps =
  PropsRuntime<'conversation.chat.node', 'question-reply'>
  & PropsLocale<'question'>

/** Keyed Chat renderer for one answered question batch. */
export const QuestionReplyView = memo(function QuestionReplyView({ node, t }: QuestionReplyViewProps) {
  return <QuestionReplyBubble data={node.data} t={t} />
})

/**
 * Render one answered batch as a compact transcript bubble: the label and the
 * chosen answers when collapsed, every question above its answer when expanded.
 * @param props - Reply data and the question locale translator.
 * @returns The collapsible reply bubble.
 */
export function QuestionReplyBubble({ data, t }: { data: QuestionReplyData; t: PropsLocale<'question'>['t'] }) {
  const label = t('reply.label')
  const [open, setOpen] = useState(false)
  const toggleLabel = t(open ? 'text.collapse' : 'text.expand')
  const summary = data.questions.map(question => replyAnswerValues(data, question.id)).flat().join(', ')
  const copyText = replyClipboardText(data, t)
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, copyText])
  return (
    <div
      className={css.row} data-question-reply={data.callId} data-reply-outcome={data.outcome}
      role="group" aria-label={label}
    >
      <div className={css.stack}>
        <div className={css.bubble}>
          <button
            type="button"
            className={css.toggle}
            aria-expanded={open}
            aria-label={`${label} · ${toggleLabel}`}
            onClick={() => { setOpen(value => !value) }}
          >
            <span className={css.labelRow}>
              <span className={css.caret} aria-hidden="true">
                {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
              </span>
              <span className={css.label}>{label}</span>
            </span>
            {!open && <span className={css.summary}>{summary === '' ? t('reply.skipped') : summary}</span>}
          </button>
          {open && (data.questions.length === 0
            ? <p className={css.text}>{data.text}</p>
            : (
              <dl className={css.details}>
                {data.questions.map((question) => {
                  const values = replyAnswerValues(data, question.id)
                  return (
                    <div key={question.id}>
                      <dt className={css.question}>
                        {question.header !== undefined && question.header !== question.question && (
                          <span className={css.header}>{question.header}</span>
                        )}
                        <span>{question.question}</span>
                      </dt>
                      <dd className={css.answer}>{values.length === 0 ? t('reply.skipped') : values.join(', ')}</dd>
                    </div>
                  )
                })}
              </dl>
            ))}
        </div>
      </div>
      <div className={css.actions}>
        <span className={css.time}>
          {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(data.time)}
        </span>
        <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
          <button
            type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}
          >
            {copied ? <IconCheckOutline16 size={15} /> : <IconCopyOutline16 size={15} />}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
