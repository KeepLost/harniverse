import { useEffect, useRef, useState } from 'react'
import type { IApiClient, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { JobView } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './JobListAction.module.css'

/** Poll cadence of the live output follow, in milliseconds. */
const FOLLOW_INTERVAL_MS = 500

/** Props of the expanded row's read-only output viewer. */
export interface JobOutputPaneProps {
  /** Wire face carrying the non-consuming ring read. */
  api: Pick<IApiClient, 'jobs'>
  /** Session whose live Agent authorizes the ring read. */
  sessionId: SessionId
  /** Registry-issued job identity. */
  jobId: JobView['id']
  /** Whether the job is still live; polling stops after the settling read. */
  live: boolean
  /** Namespace translator. */
  t: TranslateNS<typeof NS>
}

/**
 * One job's retained output ring as a read-only, bottom-pinned text surface.
 * The pane owns nothing but its accumulated window: every poll is a fresh
 * non-consuming read from the last returned offset, so the model's consuming
 * cursor is never disturbed. A read failure renders inline and the poll keeps
 * trying while the job is live (the wire self-heals across reconnects).
 * @param props - the wire face, identities, liveness, and translator.
 * @returns the scrollable output region.
 */
export function JobOutputPane({ api, sessionId, jobId, live, t }: JobOutputPaneProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const offsetRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    let active = true
    const pull = async (): Promise<void> => {
      try {
        const response = await api.jobs.follow({ sessionId, jobId, offsetBytes: offsetRef.current })
        if (!active) return
        if (!response.result.ok) {
          setError(response.result.error.message)
          return
        }
        setError(undefined)
        const { text: chunk, nextOffsetBytes } = response.result.value
        offsetRef.current = nextOffsetBytes
        if (chunk !== '') setText(current => current + chunk)
      } catch (error: unknown) {
        if (active) setError(error instanceof Error ? error.message : String(error))
      }
    }
    void pull()
    if (!live) return () => { active = false }
    const timer = setInterval(() => { void pull() }, FOLLOW_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api, sessionId, jobId, live])

  useEffect(() => {
    const node = scrollRef.current
    if (node !== null && pinnedRef.current) node.scrollTop = node.scrollHeight
  }, [text])

  /** A view the user scrolled away from the bottom stays where they left it. */
  const onScroll = (): void => {
    const node = scrollRef.current
    if (node === null) return
    pinnedRef.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 4
  }

  return (
    <div
      ref={scrollRef}
      className={css.output}
      role="log"
      aria-label={t('output.aria')}
      onScroll={onScroll}
    >
      {error !== undefined
        ? <p className={css.outputError} role="alert">{t('output.error', { message: error })}</p>
        : null}
      <span className={css.outputText}>{text}</span>
    </div>
  )
}
