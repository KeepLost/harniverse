import { useCallback, useEffect, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { QueueMessageInfo, QueueSubscriptionInfo, QueueTopicStats } from '@deepseek-ai/dsh-queue/types'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './QueueTab.module.css'

/** Injected business face of the queue tab (the queue Remote verbs it uses). */
export interface QueueTabActions {
  topicList: () => Promise<RemoteResult<QueueTopicStats[]>>
  topicCreate: (name: string, ttlMs: number | null) => Promise<RemoteResult<unknown>>
  topicDelete: (name: string) => Promise<RemoteResult<void>>
  publish: QueueTabPublish
  messages: (topic: string, fromOffset: number, limit: number, includeArchived: boolean) => Promise<RemoteResult<QueueMessageInfo[]>>
  subscriptions: QueueTabSubscriptions
  subscribe: (sessionId: string, topic: string) => Promise<RemoteResult<QueueSubscriptionInfo>>
  unsubscribe: (sessionId: string, topic: string) => Promise<RemoteResult<void>>
  pollMs: number
}

/** The publish verb, split so the interface lines stay within the wrap limit. */
export type QueueTabPublish =
  (topic: string, payload: JsonValue, headers: Readonly<Record<string, string>>, ttlMs: number | null, publisher: string)
  => Promise<RemoteResult<QueueMessageInfo>>

/** The subscriptions verb, split for the wrap limit. */
export type QueueTabSubscriptions =
  (topic: string | null, sessionId: string | null) => Promise<RemoteResult<QueueSubscriptionInfo[]>>

/** Full props composed by the governor.center.tab slot. */
export type QueueTabProps =
  PropsRuntime<'governor.center.tab'>
  & InjectFace<QueueTabActions>
  & PropsLocale<typeof NS>

type LoadState = 'loading' | 'ready' | 'error'

/**
 * The message-queue tab: the topic table, one topic's live/archived message
 * history, the subscription relation with dormant badges, and gated publish
 * and subscribe controls — all over the queue Remote at the polling cadence.
 * @param props - tab slot currency, the Remote verbs, and the translator.
 * @returns the queue surface.
 */
export function QueueTab({
  topicList, topicCreate, topicDelete, publish, messages, subscriptions, subscribe, unsubscribe, pollMs, t,
}: QueueTabProps) {
  const [state, setState] = useState<LoadState>('loading')
  const [topics, setTopics] = useState<readonly QueueTopicStats[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [rows, setRows] = useState<readonly QueueMessageInfo[]>([])
  const [subs, setSubs] = useState<readonly QueueSubscriptionInfo[]>([])
  const [newTopic, setNewTopic] = useState('')
  const [newTtl, setNewTtl] = useState('')
  const [payload, setPayload] = useState('')
  const [ttlOverride, setTtlOverride] = useState('')
  const [sessionDraft, setSessionDraft] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const refresh = useCallback(async (topic: string | null, archived: boolean) => {
    const result = await topicList()
    if (!result.ok) {
      setState('error')
      return
    }
    setTopics(result.value)
    setState('ready')
    if (topic !== null) {
      const [messageResult, subResult] = await Promise.all([
        messages(topic, 0, 100, archived),
        subscriptions(topic, null),
      ])
      if (messageResult.ok) setRows(messageResult.value)
      if (subResult.ok) setSubs(subResult.value)
    }
  }, [topicList, messages, subscriptions])

  useEffect(() => {
    void refresh(selected, includeArchived)
    const poll = setInterval(() => { void refresh(selected, includeArchived) }, pollMs)
    return () => { clearInterval(poll) }
  }, [refresh, pollMs, selected, includeArchived])

  const run = useCallback(async (op: () => Promise<unknown>) => {
    setFailure(null)
    const result = await op() as { ok: boolean; error?: unknown }
    if (!result.ok) setFailure(t('op.failed', { message: String((result as { error?: { message?: string } }).error?.message ?? (result as { error?: unknown }).error) }))
    await refresh(selected, includeArchived)
  }, [refresh, selected, includeArchived, t])

  const selectedStats = topics.find(entry => entry.topic.name === selected)

  return (
    <div className={css.tabBody}>
      <div className={css.toolbar}>
        <span />
        <div className={css.toolbarActions}>
          <input className={css.input} placeholder={t('topic.name')} value={newTopic} onChange={(event) => { setNewTopic(event.target.value) }} />
          <input className={css.input} placeholder={t('topic.ttl')} value={newTtl} onChange={(event) => { setNewTtl(event.target.value) }} />
          <button type="button" className={css.button} onClick={() => {
            const ttl = Number(newTtl)
            void run(() => topicCreate(newTopic, newTtl.trim().length === 0 || !Number.isFinite(ttl) || ttl <= 0 ? null : ttl))
            setNewTopic('')
            setNewTtl('')
          }}>{t('topic.create')}</button>
          <button type="button" className={css.button} onClick={() => { void refresh(selected, includeArchived) }}>{t('view.refresh')}</button>
        </div>
      </div>
      {failure !== null ? <p className={css.note}>{failure}</p> : null}
      {state === 'loading' ? <p className={css.note}>{t('view.loading')}</p> : null}
      {state === 'error' ? (
        <p className={css.note}>
          {t('view.error')}
          <button type="button" className={css.button} onClick={() => { void refresh(selected, includeArchived) }}>{t('view.retry')}</button>
        </p>
      ) : null}
      {state === 'ready' && topics.length === 0 ? <p className={css.note}>{t('view.empty')}</p> : null}
      {state === 'ready' && topics.length > 0 ? (
        <table className={css.table}>
          <thead>
            <tr>
              <th scope="col">{t('table.name')}</th>
              <th scope="col">{t('table.live')}</th>
              <th scope="col">{t('table.archived')}</th>
              <th scope="col">{t('table.subscribers')}</th>
              <th scope="col">{t('table.nextOffset')}</th>
              <th scope="col" aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {topics.map(entry => (
              <tr key={entry.topic.id} className={entry.topic.name === selected ? css.rowActive : undefined}>
                <td>{entry.topic.name}</td>
                <td>{entry.liveCount}</td>
                <td>{entry.archivedCount}</td>
                <td>{entry.subscriberCount}</td>
                <td>{entry.topic.nextOffset}</td>
                <td>
                  <button type="button" className={css.button} onClick={() => { setSelected(entry.topic.name) }}>{t('topic.select')}</button>
                  <button type="button" className={css.button} onClick={() => {
                    if (window.confirm(t('topic.deleteConfirm'))) void run(() => topicDelete(entry.topic.name))
                  }}>{t('topic.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {selectedStats !== undefined ? (
        <section className={css.detail} aria-label={`${t('detail.title')}: ${selectedStats.topic.name}`}>
          <h3 className={css.detailTitle}>{t('detail.title')}:{selectedStats.topic.name}</h3>
          <label className={css.check}>
            <input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked) }} />
            {t('detail.showArchived')}
          </label>
          <table className={css.table}>
            <thead>
              <tr>
                <th scope="col">{t('messages.offset')}</th>
                <th scope="col">{t('messages.publisher')}</th>
                <th scope="col">{t('messages.expires')}</th>
                <th scope="col">{t('messages.payload')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={4} className={css.note}>{t('messages.empty')}</td></tr>
              ) : rows.map(message => (
                <tr key={message.offset} className={message.state === 'archived' ? css.rowArchived : undefined}>
                  <td>#{message.offset}</td>
                  <td>{message.publisher}</td>
                  <td title={String(message.expiresAt)}>{message.state === 'archived' ? t('table.archived') : new Date(message.expiresAt).toISOString().slice(11, 19)}</td>
                  <td><code className={css.payload}>{JSON.stringify(message.payload)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={css.publish}>
            <input className={css.inputWide} placeholder={t('detail.payload')} value={payload} onChange={(event) => { setPayload(event.target.value) }} />
            <input className={css.input} placeholder={t('detail.ttl')} value={ttlOverride} onChange={(event) => { setTtlOverride(event.target.value) }} />
            <button type="button" className={css.button} onClick={() => {
              const ttl = Number(ttlOverride)
              void run(async () => publish(selectedStats.topic.name, JSON.parse(payload), {},
                ttlOverride.trim().length === 0 || !Number.isFinite(ttl) || ttl <= 0 ? null : ttl, 'panel'))
            }}>{t('detail.publish')}</button>
          </div>
          <h4 className={css.subsTitle}>{t('subs.title')}</h4>
          <div className={css.subsBar}>
            <input className={css.input} placeholder={t('subs.session')} value={sessionDraft} onChange={(event) => { setSessionDraft(event.target.value) }} />
            <button type="button" className={css.button} onClick={() => { void run(() => subscribe(sessionDraft, selectedStats.topic.name)) }}>{t('subs.subscribe')}</button>
          </div>
          <table className={css.table}>
            <thead>
              <tr>
                <th scope="col">{t('subs.session')}</th>
                <th scope="col">{t('subs.cursor')}</th>
              </tr>
            </thead>
            <tbody>
              {subs.map(row => (
                <tr key={row.sessionId}>
                  <td>
                    {row.sessionId}
                    {row.dormant ? <span className={css.dormant}>{t('subs.dormant')}</span> : null}
                  </td>
                  <td>
                    {row.cursor}
                    <button type="button" className={css.button} onClick={() => { void run(() => unsubscribe(row.sessionId, selectedStats.topic.name)) }}>{t('subs.unsubscribe')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  )
}
