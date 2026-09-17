# Session Message Queue

English | [中文](queue.zh.md)

The queue is the session-side event stream: Kafka-style durable topics with dense per-topic offsets, time-based forced archival, a silent bidirectional subscription relation model, and wake-on-deliver fan-out into subscribed sessions. The [queue Agent Note](../../.agents/notes/implemented/architecture/2026-09-17-session-message-queue.md) owns the semantics; the [package README](../../packages/queue/queue/README.md) owns composition, the Remote surface, and configuration. This page records the wire-facing shapes from [`packages/queue/queue/src/types.ts`](../../packages/queue/queue/src/types.ts).

## Topics and messages

`QueueTopicInfo` is one durable topic: the numeric id (a recreated name mints a fresh id — names are aliases, never identities), the optional topic-level TTL override, and `nextOffset`, the dense offset ceiling already assigned. `QueueMessageInfo` is one appended message: its `offset` inside the topic, the JSON `payload` (bounded by `maxPayloadBytes`), string `headers`, the `publisher` identity, the deadline `expiresAt`, and the lifecycle `state` — `live` until the sweeper force-archives it past its deadline.

```ts type-equiv
/** Lifecycle state of one message: live until its deadline forces archival. */
type QueueMessageState = 'live' | 'archived'
```

Delivery never touches these rows: a message past its deadline at delivery time is skipped outright, and the subscription watermark still advances — archived data is never delivered, by specification.

## The subscription relation

`QueueSubscriptionInfo` is one session × topic relation row. The `cursor` is the delivery watermark — the highest offset accounted for, whether delivered or skipped (an archived subscriber's watermark advances without receiving anything, so missed messages stay missed after unarchiving). `dormant` marks a subscriber whose session is archived: the relation is retained, delivery suspended, and `subscribe` on an archived session rejects.

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

Deleting either side dissolves the relation silently — no notification, no residue: topic deletion drops every row in the same batch; session deletion resolves within one sweeper interval. A recreated same-name topic starts with zero subscriptions.

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

A `TypertRemoteService` over the `queue` storage domain. Reads (`topicList`, `messages`, `subscriptions`, `stats`) sit under `harniverse.observe`; writes (`topicCreate`, `topicDelete`, `publish`, `subscribe`, `unsubscribe`) under `harniverse.operate`. The model tools (`dsh-queue/tool`) call the service in-process; the panel tab polls the same Remote namespace.

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

A delivered message arrives as a plugin-source `user/message` labelled `queue` — an envelope line naming topic, offset, publisher, and expiry, then the payload verbatim. Idle sessions wake through `agent.followup`; running sessions receive it as injected context at the next step boundary. Token cost is the envelope plus the payload; there is no polling verb.
