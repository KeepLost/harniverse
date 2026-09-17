# 会话消息队列

[English](queue.md) | 中文

队列是会话侧事件流:Kafka 语义的持久 topic(每 topic 稠密 offset)、基于时间的强制归档、双向静默级联的订阅关系模型、投递即唤醒的扇出。[队列 Agent Note](../../.agents/notes/implemented/architecture/2026-09-17-session-message-queue.md) 拥有语义;[包 README](../../packages/queue/queue/README.md) 拥有组合、Remote 面与配置。本页记录来自 [`packages/queue/queue/src/types.ts`](../../packages/queue/queue/src/types.ts) 的线上形状。

## Topic 与消息

`QueueTopicInfo` 是一个持久 topic:数字 id(同名重建铸造全新 id——名字是别名,不是身份)、可选的 topic 级 TTL 覆盖、以及已分配的稠密 offset 上限 `nextOffset`。`QueueMessageInfo` 是一条追加的消息:topic 内的 `offset`、有界 JSON `payload`(`maxPayloadBytes`)、字符串 `headers`、`publisher` 身份、Deadline `expiresAt`、生命周期 `state`——清扫器过限后强制归档前为 `live`。

```ts type-equiv
/** Lifecycle state of one message: live until its deadline forces archival. */
type QueueMessageState = 'live' | 'archived'
```

投递不触碰这些行:投递时刻已过 Deadline 的消息直接跳过,订阅水位照常推进——归档数据永不投递,规格如此。

## 订阅关系

`QueueSubscriptionInfo` 是一条 会话 × topic 关系行。`cursor` 是投递水位——已结清的最高 offset(已投或已跳;归档订阅者的水位只进不收,恢复后错过即错过)。`dormant` 标记订阅者会话已归档:关系保留、投递休眠,对已归档会话 `subscribe` 拒绝。

```ts type-equiv
/** One subscription row — the session × topic relation model. */
interface QueueSubscriptionInfo {
  sessionId: string
  topicId: number
  /** Delivery watermark: the highest offset accounted for (delivered or skipped). */
  cursor: number
  subscribedAt: number
  lastDeliveredAt: number | null
  /** True while the subscriber session is archived: the relation is dormant. */
  dormant: boolean
}
```

任一侧被删,关系静默解除——不通知、无残迹:topic 删除同批清空全部关系行;会话删除在一个清扫周期内收敛。同名重建的 topic 从零订阅起步。

## Cordis surface

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxqueue--queueservice"></a>

### `ctx.queue` — `QueueService`

The session message queue service (`ctx.queue`). One instance owns the storage domain, the forced-archive sweeper, and the delivery fan-out.

```ts cordis-catalog
/** Forced-archive pass: flip expired live rows, prune archive overflow, drop vanished sessions. */
async sweep(): Promise<void>

/**
 * Topic list with aggregates (`harniverse.observe`).
 * @returns every topic with live/archived counts, subscribers, and offsets.
 */
@Remote({ exportName: 'topicList', requiredCapability: 'harniverse.observe' }) topicList(): QueueTopicStats[]

/**
 * Create a topic explicitly (`harniverse.operate`); publishing creates one implicitly.
 * @param name - unique topic name.
 * @param ttlMs - optional topic-level TTL override.
 * @returns the created topic.
 */
@Remote({ exportName: 'topicCreate', requiredCapability: 'harniverse.operate' }) topicCreate(name: string, ttlMs: number | null): Promise<QueueTopicInfo>

/**
 * Delete a topic and everything it owns (`harniverse.operate`): messages and
 * every subscription row dissolve silently in the same batch — subscribers
 * are not notified. A later topic under the same name starts fresh.
 * @param name - topic name.
 */
@Remote({ exportName: 'topicDelete', requiredCapability: 'harniverse.operate' }) async topicDelete(name: string): Promise<void>

/**
 * Append one message and fan it out (`harniverse.operate`).
 * @param topicName - target topic (created with defaults when absent).
 * @param payload - JSON payload (bounded by `maxPayloadBytes`).
 * @param headers - optional string headers.
 * @param ttlMs - optional per-message TTL override.
 * @param publisher - publisher identity for auditing.
 * @returns the stored message with its assigned offset.
 */
@Remote({ exportName: 'publish', requiredCapability: 'harniverse.operate' }) publish( topicName: string, payload: JsonValue, headers: Readonly<Record<string, string>>, ttlMs: number | null, publisher: string, ): Promise<QueueMessageInfo>

/**
 * Subscribe one session to one topic (`harniverse.operate`). The relation
 * belongs to the named session — the panel surface manages it for
 * housekeeping; the model tool binds it to the calling session only.
 * New subscriptions start at latest: only future messages arrive.
 * @param sessionId - subscriber session id.
 * @param topicName - existing topic name.
 * @returns the relation row with its dormant classification.
 */
@Remote({ exportName: 'subscribe', requiredCapability: 'harniverse.operate' }) subscribe(sessionId: string, topicName: string): Promise<QueueSubscriptionInfo & { dormant: boolean }>

/**
 * Dissolve one subscription (`harniverse.operate`); absent rows resolve.
 * @param sessionId - subscriber session id.
 * @param topicName - topic name.
 */
@Remote({ exportName: 'unsubscribe', requiredCapability: 'harniverse.operate' }) async unsubscribe(sessionId: string, topicName: string): Promise<void>

/**
 * Read the subscription relation (`harniverse.observe`), by topic, by session, or whole.
 * @param topicName - filter by topic when given.
 * @param sessionId - filter by session when given.
 * @returns matching relation rows.
 */
@Remote({ exportName: 'subscriptions', requiredCapability: 'harniverse.observe' }) subscriptions(topicName: string | null, sessionId: string | null): Array<QueueSubscriptionInfo & { dormant: boolean }>

/**
 * Query one topic's messages (`harniverse.observe`) — the past-tense,
 * cursor-free history read; it never moves a watermark.
 * @param topicName - topic name.
 * @param fromOffset - first offset to include.
 * @param limit - maximum rows to return.
 * @param includeArchived - include forced-archived rows when true.
 * @returns matching messages in offset order.
 */
@Remote({ exportName: 'messages', requiredCapability: 'harniverse.observe' }) messages(topicName: string, fromOffset: number, limit: number, includeArchived: boolean): QueueMessageInfo[]

/**
 * Aggregate stats for one topic (`harniverse.observe`).
 * @param topicName - topic name.
 * @returns counts, subscriber total, and live offset bounds.
 */
@Remote({ exportName: 'stats', requiredCapability: 'harniverse.observe' }) stats(topicName: string): QueueTopicStats
```

Source: [`packages/queue/queue/src/index.ts:63`](../../packages/queue/queue/src/index.ts)
<!-- END GENERATED cordis-surface -->

## Cordis API

### `ctx.queue` — `QueueService`

`queue` storage domain 之上的 `TypertRemoteService`。读(`topicList`、`messages`、`subscriptions`、`stats`)挂 `harniverse.observe`;写(`topicCreate`、`topicDelete`、`publish`、`subscribe`、`unsubscribe`)挂 `harniverse.operate`。模型工具(`dsh-queue/tool`)进程内直调;面板 tab 轮询同一 Remote 命名空间。

```ts type-equiv
/** Aggregate topic view for list and stats surfaces. */
interface QueueTopicStats {
  topic: QueueTopicInfo
  liveCount: number
  archivedCount: number
  subscriberCount: number
  oldestLiveOffset: number | null
  newestLiveOffset: number | null
}
```

## Model Experience

投递以 `queue` 标注的插件源 `user/message` 到达——一行信封(topic、offset、发布者、过期时刻)+ 载荷原文。空闲会话经 `agent.followup` 唤醒;运行中会话在下一 step 边界作为注入上下文接收。Token 成本 = 信封 + 载荷;没有轮询动词。
