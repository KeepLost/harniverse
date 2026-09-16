/**
 * Queue panel tab, browser half: registers the 消息队列 tab into the panel
 * (会话看板) center view through the `governor.center.tab` slot, polling the
 * queue Remote at the sampling cadence — the same HTTP API surface scripts
 * and the model tools use, so the page cannot drift from the service.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: loads the queue namespace merge onto TypertClientRemote.
import type {} from '@deepseek-ai/dsh-queue/remote'
// Type-only: pulls the ui-governor SlotMap merge (the panel tab list).
import type {} from '@deepseek-ai/dsh-client-ui-governor/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { QueueTab } from './QueueTab.tsx'
import { en, NS, zh, type QueueKey } from './locales.ts'

/** Services the browser half binds. */
export const inject = ['slots', 'locale', 'remote', 'remote.queue']

/** Poll cadence, matching the governor board's sampling rhythm. */
const POLL_MS = 5_000

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Queue panel copy. */
    'queue': QueueKey
  }
}

/**
 * Client plugin body: register the dictionaries and the panel tab.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-queue: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('governor.center.tab', () => ctx.slots.register({
    name: 'governor.center.tab',
    id: 'queue',
    order: 20,
    locale: NS,
    label: () => t('tab.queue'),
    inject: () => ({
      topicList: () => ctx.remote.queue.topicList(),
      topicCreate: (name: string, ttlMs: number | null) => ctx.remote.queue.topicCreate(name, ttlMs),
      topicDelete: (name: string) => ctx.remote.queue.topicDelete(name),
      publish: (topic: string, payload: JsonValue, headers: Readonly<Record<string, string>>, ttlMs: number | null, publisher: string) =>
        ctx.remote.queue.publish(topic, payload, headers, ttlMs, publisher),
      messages: (topic: string, fromOffset: number, limit: number, includeArchived: boolean) =>
        ctx.remote.queue.messages(topic, fromOffset, limit, includeArchived),
      subscriptions: (topic: string | null, sessionId: string | null) => ctx.remote.queue.subscriptions(topic, sessionId),
      subscribe: (sessionId: string, topic: string) => ctx.remote.queue.subscribe(sessionId, topic),
      unsubscribe: (sessionId: string, topic: string) => ctx.remote.queue.unsubscribe(sessionId, topic),
      pollMs: POLL_MS,
    }),
  }, QueueTab))
}
