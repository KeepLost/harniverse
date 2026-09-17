/**
 * The session message queue service: Kafka-style durable topics with dense
 * per-topic offsets, time-based forced archival (an expired or archived
 * message is never delivered, even to a subscriber that lagged behind), a
 * silent bidirectional subscription relation model (deleting either side
 * dissolves the relation immediately, no notification), and wake-on-deliver
 * fan-out — an idle subscribed session wakes and processes the message,
 * a running one receives it after the blocking command at its next request.
 * See the package README and the queue Agent Note for the full semantics.
 *
 * @module @deepseek-ai/dsh-queue
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { foldRequestHeader, SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import type {
  QueueConfig, QueueMessageInfo, QueueSubscriptionInfo, QueueTopicInfo, QueueTopicStats,
} from './types.ts'
import { queueConfigSchema } from './types.ts'
import { queueDomainSpec } from './spec.ts'
import { queueDeliveryMessage } from './envelope.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    queue: QueueService
  }
}

/** Row shapes as stored (the wire infos are derived views of these). */

/** Constructor input: every config field optional, defaults applied on parse. */
export type QueueConfigInput = Partial<QueueConfig>

/** The four opened storage tables in one bag. */
interface QueueTables {
  topics: KvTable<string, TopicRow>
  topicNames: KvTable<string, number>
  messages: KvTable<string, MessageRow>
  subscriptions: KvTable<string, SubscriptionRow>
}
type TopicRow = { id: number; name: string; ttlMs: number | null; createdAt: number; nextOffset: number }
type MessageRow = Omit<QueueMessageInfo, 'payload'> & { payload: unknown }
type SubscriptionRow = Omit<QueueSubscriptionInfo, 'dormant'>

/** Session-state classification the fan-out and subscribe gates read. */
type SubscriberState = 'deliverable' | 'archived' | 'deleted'

const messageKey = (topicId: number, offset: number): string => `${topicId}#${offset}`
const subscriptionKey = (sessionId: string, topicId: number): string => `${sessionId}#${topicId}`

/**
 * The session message queue service (`ctx.queue`). One instance owns the
 * storage domain, the forced-archive sweeper, and the delivery fan-out.
 */
export class QueueService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'workspaceRegistry', 'storageDomain']

  private readonly config: QueueConfig
  private topicTable: KvTable<string, TopicRow> | undefined
  private nameIndex: KvTable<string, number> | undefined
  private messageTable: KvTable<string, MessageRow> | undefined
  private subscriptionTable: KvTable<string, SubscriptionRow> | undefined
  private nextTopicId = 1
  private sweeper: ReturnType<typeof setInterval> | undefined = undefined
  private closed = false
  /** Serializes offset assignment + fan-out so publishes commit in order. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: QueueConfigInput = {}) {
    super(ctx, 'queue')
    this.config = queueConfigSchema.parse(config)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(queueDomainSpec)
    this.topicTable = domain.table('topics')
    this.nameIndex = domain.table('topic_names')
    this.messageTable = domain.table('messages')
    this.subscriptionTable = domain.table('subscriptions')
    for (const key of this.topicTable.keys()) this.nextTopicId = Math.max(this.nextTopicId, Number(key) + 1)
    /* v8 ignore next 1 -- the cadence wrapper; tick/sweep are covered directly. */
    this.sweeper = setInterval(() => { this.tick() }, this.config.sweepIntervalMs)
    this.ctx.effect(() => async () => { await this.teardown(domain) }, 'queue lifecycle')
  }

  /** One sweeper tick; extracted so the cadence wrapper itself stays trivial. */
  private tick(): void {
    void this.sweep()
  }

  /** Stop the sweeper, drain the write chain, and close the domain. */
  private async teardown(domain: { close: () => Promise<void> }): Promise<void> {
    this.closed = true
    clearInterval(this.sweeper)
    // serialize() keeps the chain non-rejecting by construction.
    await this.chain
    await domain.close()
  }

  private requireTables(): QueueTables {
    const topics = this.topicTable
    const topicNames = this.nameIndex
    const messages = this.messageTable
    const subscriptions = this.subscriptionTable
    if (topics === undefined || topicNames === undefined || messages === undefined || subscriptions === undefined) {
      throw new Error('queue service is not initialized')
    }
    return { topics, topicNames, messages, subscriptions }
  }

  private classifySubscriber(sessionId: string): SubscriberState {
    if (this.ctx.workspaceRegistry.pendingSessionDeletionIds.includes(sessionId as SessionId)) return 'deleted'
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId as SessionId)) return 'archived'
    return 'deliverable'
  }

  private topicByName(name: string): { row: TopicRow } | undefined {
    const { topics, topicNames } = this.requireTables()
    const id = topicNames.get(name)
    if (id === undefined) return undefined
    /* v8 ignore next 1 -- defensive: the name index and topic rows are written
       together in one task, so a dangling index is unreachable corruption. */
    const row = topics.get(String(id)) ?? { id, name, ttlMs: null, createdAt: 0, nextOffset: 0 }
    return { row }
  }

  private messageRowsOf(topicId: number): MessageRow[] {
    const { messages } = this.requireTables()
    const prefix = `${topicId}#`
    const rows: MessageRow[] = []
    for (const [key, row] of messages.entries()) if (key.startsWith(prefix)) rows.push(row)
    rows.sort((a, b) => a.offset - b.offset)
    return rows
  }

  private subscriptionRowsOf(topicId?: number, sessionId?: string): SubscriptionRow[] {
    const { subscriptions } = this.requireTables()
    const rows: SubscriptionRow[] = []
    for (const [, row] of subscriptions.entries()) {
      if (topicId !== undefined && row.topicId !== topicId) continue
      if (sessionId !== undefined && row.sessionId !== sessionId) continue
      rows.push(row)
    }
    return rows
  }

  private topicStatsOf(row: TopicRow): QueueTopicStats {
    const rows = this.messageRowsOf(row.id)
    const live = rows.filter(message => message.state === 'live')
    const archived = rows.filter(message => message.state === 'archived')
    return {
      topic: row,
      liveCount: live.length,
      archivedCount: archived.length,
      subscriberCount: this.subscriptionRowsOf(row.id).length,
      oldestLiveOffset: live[0]?.offset ?? null,
      newestLiveOffset: live[live.length - 1]?.offset ?? null,
    }
  }

  /**
   * Resolve one subscribed session to a live agent, cold-resuming it when
   * needed (the scheduler's resolve shape, trimmed to the queue's needs).
   */
  private async resolveAgent(sessionId: string): Promise<Agent | undefined> {
    const live = this.ctx.agents.get(sessionId as SessionId)
    if (live !== undefined) return live
    if (this.ctx.sessions.get(sessionId as SessionId) !== undefined) return undefined
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const listed = (await persistence.list()).find(header => header.id === (sessionId as SessionId))
    if (listed === undefined) return undefined
    const inspected = await persistence.inspect(sessionId as SessionId)
    const defaultModel = this.ctx.get('agentDefaultModel')
    const selection = foldRequestHeader(inspected.events)?.config ?? defaultModel?.currentSelection()
    if (selection === undefined) return undefined
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId as SessionId,
      agentOptions: selection,
    })
    return handle.agent
  }

  /** Deliver one message to one subscriber; returns false when the row must dissolve. */
  private async deliverTo(row: SubscriptionRow, topic: TopicRow, message: MessageRow): Promise<boolean> {
    const { subscriptions } = this.requireTables()
    const state = this.classifySubscriber(row.sessionId)
    if (state === 'deleted') return false
    const expired = message.expiresAt <= Date.now() || message.state !== 'live'
    if (state === 'deliverable' && !expired) {
      const agent = await this.resolveAgent(row.sessionId)
      if (agent === undefined) return false
      const envelope = queueDeliveryMessage({
        topicName: topic.name,
        offset: message.offset,
        payloadText: JSON.stringify(message.payload),
        publisher: message.publisher,
        publishedAt: message.publishedAt,
        expiresAt: message.expiresAt,
      })
      // Running drivers take injected context at the next step boundary (after
      // the blocking command); idle ones wake on the follow-up itself.
      if (agent.status === 'running') {
        agent.inject(envelope)
      } else {
        const session: Session = agent.session
        await agent.runMaintenance(() => {
          agent.followup(envelope)
          return Promise.resolve(true)
        }).catch(async () => {
          // The scheduler's retry shape: wait out a busy turn, then redeliver.
          /* v8 ignore next 1 -- the idle-to-running race between the branch
             above and the retry; the wait is the same wait the scheduler uses. */
          if (agent.status === 'running') await agent.whenIdle()
          await agent.runMaintenance(() => {
            agent.followup(envelope)
            return Promise.resolve(true)
          })
        })
        await this.ctx.sessions.flush(session)
      }
    }
    // Archived subscribers (and expired skips) still advance the watermark:
    // missed messages stay missed, by specification.
    await subscriptions.put(subscriptionKey(row.sessionId, row.topicId), {
      ...row,
      cursor: Math.max(row.cursor, message.offset),
      lastDeliveredAt: state === 'deliverable' && !expired ? Date.now() : row.lastDeliveredAt,
    })
    return true
  }

  /** Fan out one freshly committed message to every subscriber of its topic. */
  private async fanOut(topic: TopicRow, message: MessageRow): Promise<void> {
    const { subscriptions } = this.requireTables()
    const rows = this.subscriptionRowsOf(topic.id)
    for (const row of rows) {
      const keep = await this.deliverTo(row, topic, message)
      if (!keep) await subscriptions.delete(subscriptionKey(row.sessionId, row.topicId))
    }
  }

  /** Forced-archive pass: flip expired live rows, prune archive overflow, drop vanished sessions. */
  async sweep(): Promise<void> {
    if (this.closed) return
    const { messages, subscriptions } = this.requireTables()
    const now = Date.now()
    for (const [key, message] of messages.entries()) {
      if (message.state === 'live' && message.expiresAt <= now) {
        await messages.put(key, { ...message, state: 'archived' })
      }
    }
    const archivedByTopic = new Map<number, number[]>()
    for (const [, message] of messages.entries()) {
      if (message.state !== 'archived') continue
      const offsets = archivedByTopic.get(message.topicId) ?? []
      offsets.push(message.offset)
      archivedByTopic.set(message.topicId, offsets)
    }
    for (const [topicId, offsets] of archivedByTopic) {
      if (offsets.length <= this.config.maxArchivedMessages) continue
      const excess = offsets.sort((a, b) => a - b).slice(0, offsets.length - this.config.maxArchivedMessages)
      for (const offset of excess) await messages.delete(messageKey(topicId, offset))
    }
    // Silent cascade for deleted sessions: no event exists on the deletion
    // path, so the sweeper dissolves their relation rows within one interval.
    for (const row of this.subscriptionRowsOf()) {
      if (this.classifySubscriber(row.sessionId) === 'deleted') {
        await subscriptions.delete(subscriptionKey(row.sessionId, row.topicId))
      }
    }
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  // ---- Remote surface ----

  /**
   * Topic list with aggregates (`harniverse.observe`).
   * @returns every topic with live/archived counts, subscribers, and offsets.
   */
  @Remote({ exportName: 'topicList', requiredCapability: 'harniverse.observe' })
  topicList(): QueueTopicStats[] {
    const { topics } = this.requireTables()
    return [...topics.entries()].map(([, row]) => this.topicStatsOf(row)).sort((a, b) => a.topic.id - b.topic.id)
  }

  /**
   * Create a topic explicitly (`harniverse.operate`); publishing creates one implicitly.
   * @param name - unique topic name.
   * @param ttlMs - optional topic-level TTL override.
   * @returns the created topic.
   */
  @Remote({ exportName: 'topicCreate', requiredCapability: 'harniverse.operate' })
  topicCreate(name: string, ttlMs: number | null): Promise<QueueTopicInfo> {
    return this.serialize(() => this.createTopic(name, ttlMs))
  }

  private async createTopic(name: string, ttlMs: number | null): Promise<TopicRow> {
    const { topics, topicNames } = this.requireTables()
    const existing = this.topicByName(name)
    if (existing !== undefined) throw new Error(`topic "${name}" already exists`)
    const row: TopicRow = { id: this.nextTopicId++, name, ttlMs, createdAt: Date.now(), nextOffset: 0 }
    await topics.put(String(row.id), row)
    await topicNames.put(name, row.id)
    return row
  }

  /**
   * Delete a topic and everything it owns (`harniverse.operate`): messages and
   * every subscription row dissolve silently in the same batch — subscribers
   * are not notified. A later topic under the same name starts fresh.
   * @param name - topic name.
   */
  @Remote({ exportName: 'topicDelete', requiredCapability: 'harniverse.operate' })
  async topicDelete(name: string): Promise<void> {
    return this.serialize(() => this.deleteTopic(name))
  }

  private async deleteTopic(name: string): Promise<void> {
    const { topics, topicNames, messages, subscriptions } = this.requireTables()
    const found = this.topicByName(name)
    if (found === undefined) throw new Error(`topic "${name}" not found`)
    for (const row of this.messageRowsOf(found.row.id)) await messages.delete(messageKey(found.row.id, row.offset))
    for (const row of this.subscriptionRowsOf(found.row.id)) {
      await subscriptions.delete(subscriptionKey(row.sessionId, row.topicId))
    }
    await topics.delete(String(found.row.id))
    await topicNames.delete(name)
  }

  /**
   * Append one message and fan it out (`harniverse.operate`).
   * @param topicName - target topic (created with defaults when absent).
   * @param payload - JSON payload (bounded by `maxPayloadBytes`).
   * @param headers - optional string headers.
   * @param ttlMs - optional per-message TTL override.
   * @param publisher - publisher identity for auditing.
   * @returns the stored message with its assigned offset.
   */
  @Remote({ exportName: 'publish', requiredCapability: 'harniverse.operate' })
  publish(
    topicName: string,
    payload: JsonValue,
    headers: Readonly<Record<string, string>>,
    ttlMs: number | null,
    publisher: string,
  ): Promise<QueueMessageInfo> {
    return this.serialize(() => this.publishNow(topicName, payload, headers, ttlMs, publisher))
  }

  private async publishNow(
    topicName: string,
    payload: JsonValue,
    headers: Readonly<Record<string, string>>,
    ttlMs: number | null,
    publisher: string,
  ): Promise<QueueMessageInfo> {
    const { topics } = this.requireTables()
    const serialized = JSON.stringify(payload)
    if (serialized.length > this.config.maxPayloadBytes) {
      throw new Error(`payload of ${serialized.length} bytes exceeds the ${this.config.maxPayloadBytes}-byte ceiling`)
    }
    const existing = this.topicByName(topicName)
    const topic = existing?.row ?? await this.createTopic(topicName, null)
    const liveCount = this.messageRowsOf(topic.id).filter(message => message.state === 'live').length
    if (liveCount >= this.config.maxLiveMessages) {
      throw new Error(`topic "${topicName}" holds ${liveCount} live messages at its ceiling`)
    }
    const offset = topic.nextOffset
    const updated: TopicRow = { ...topic, nextOffset: offset + 1 }
    await topics.put(String(updated.id), updated)
    const now = Date.now()
    const message: MessageRow = {
      topicId: topic.id,
      offset,
      payload,
      headers: { ...headers },
      publisher,
      publishedAt: now,
      expiresAt: now + (ttlMs ?? topic.ttlMs ?? this.config.defaultTtlMs),
      state: 'live',
    }
    await this.requireTables().messages.put(messageKey(topic.id, offset), message)
    await this.fanOut(updated, message)
    return message as QueueMessageInfo
  }

  /**
   * Subscribe one session to one topic (`harniverse.operate`). The relation
   * belongs to the named session — the panel surface manages it for
   * housekeeping; the model tool binds it to the calling session only.
   * New subscriptions start at latest: only future messages arrive.
   * @param sessionId - subscriber session id.
   * @param topicName - existing topic name.
   * @returns the relation row with its dormant classification.
   */
  @Remote({ exportName: 'subscribe', requiredCapability: 'harniverse.operate' })
  subscribe(sessionId: string, topicName: string): Promise<QueueSubscriptionInfo & { dormant: boolean }> {
    return this.serialize(async () => {
      const row = await this.subscribeNow(sessionId, topicName)
      return { ...row, dormant: this.classifySubscriber(row.sessionId) === 'archived' }
    })
  }

  private async subscribeNow(sessionId: string, topicName: string): Promise<SubscriptionRow> {
    const { subscriptions } = this.requireTables()
    const found = this.topicByName(topicName)
    if (found === undefined) throw new Error(`topic "${topicName}" not found`)
    if (this.classifySubscriber(sessionId) === 'archived') {
      throw new Error(`session "${sessionId}" is archived; archived sessions only observe`)
    }
    const existing = subscriptions.get(subscriptionKey(sessionId, found.row.id))
    if (existing !== undefined) return existing
    const row: SubscriptionRow = {
      sessionId,
      topicId: found.row.id,
      cursor: Math.max(0, found.row.nextOffset - 1),
      subscribedAt: Date.now(),
      lastDeliveredAt: null,
    }
    await subscriptions.put(subscriptionKey(sessionId, row.topicId), row)
    return row
  }

  /**
   * Dissolve one subscription (`harniverse.operate`); absent rows resolve.
   * @param sessionId - subscriber session id.
   * @param topicName - topic name.
   */
  @Remote({ exportName: 'unsubscribe', requiredCapability: 'harniverse.operate' })
  async unsubscribe(sessionId: string, topicName: string): Promise<void> {
    return this.serialize(async () => {
      const { subscriptions } = this.requireTables()
      const found = this.topicByName(topicName)
      if (found !== undefined) await subscriptions.delete(subscriptionKey(sessionId, found.row.id))
    })
  }

  /**
   * Read the subscription relation (`harniverse.observe`), by topic, by session, or whole.
   * @param topicName - filter by topic when given.
   * @param sessionId - filter by session when given.
   * @returns matching relation rows.
   */
  @Remote({ exportName: 'subscriptions', requiredCapability: 'harniverse.observe' })
  subscriptions(topicName: string | null, sessionId: string | null): Array<QueueSubscriptionInfo & { dormant: boolean }> {
    const topicId = topicName === null ? undefined : this.topicByName(topicName)?.row.id
    return this.subscriptionRowsOf(topicId, sessionId ?? undefined)
      .map(row => ({ ...row, dormant: this.classifySubscriber(row.sessionId) === 'archived' }))
  }

  /**
   * Query one topic's messages (`harniverse.observe`) — the past-tense,
   * cursor-free history read; it never moves a watermark.
   * @param topicName - topic name.
   * @param fromOffset - first offset to include.
   * @param limit - maximum rows to return.
   * @param includeArchived - include forced-archived rows when true.
   * @returns matching messages in offset order.
   */
  @Remote({ exportName: 'messages', requiredCapability: 'harniverse.observe' })
  messages(topicName: string, fromOffset: number, limit: number, includeArchived: boolean): QueueMessageInfo[] {
    const found = this.topicByName(topicName)
    if (found === undefined) throw new Error(`topic "${topicName}" not found`)
    const rows = this.messageRowsOf(found.row.id)
      .filter(message => message.offset >= fromOffset)
      .filter(message => includeArchived || message.state === 'live')
    return rows.slice(0, Math.max(1, limit)) as QueueMessageInfo[]
  }

  /**
   * Aggregate stats for one topic (`harniverse.observe`).
   * @param topicName - topic name.
   * @returns counts, subscriber total, and live offset bounds.
   */
  @Remote({ exportName: 'stats', requiredCapability: 'harniverse.observe' })
  stats(topicName: string): QueueTopicStats {
    const found = this.topicByName(topicName)
    if (found === undefined) throw new Error(`topic "${topicName}" not found`)
    return this.topicStatsOf(found.row)
  }
}

export default QueueService
