/**
 * Queue wire types and the deployment config: plain JSON records shared by
 * the host service, the model-facing tools, and the panel Remote surface.
 * @module @deepseek-ai/dsh-queue/types
 */

import { z } from 'zod'

/** Deployment config of the queue service. */
export const queueConfigSchema = z.object({
  /** Fallback topic TTL when neither topic nor message overrides one. */
  defaultTtlMs: z.number().int().positive().max(2_592_000_000).default(86_400_000),
  /** Live-message ceiling per topic; a publish against a full topic rejects. */
  maxLiveMessages: z.number().int().positive().default(10_000),
  /** Archived-message ceiling per topic; the sweeper prunes oldest first. */
  maxArchivedMessages: z.number().int().positive().default(10_000),
  /** Ceiling for one serialized payload, applied to the complete value. */
  maxPayloadBytes: z.number().int().positive().default(262_144),
  /** Forced-archive sweep cadence. */
  sweepIntervalMs: z.number().int().positive().default(60_000),
})

/** Resolved deployment config (all defaults applied). */
export type QueueConfig = z.infer<typeof queueConfigSchema>

/** One durable topic. The name is a unique alias; a recreated name is a fresh topic. */
export interface QueueTopicInfo {
  id: number
  name: string
  /** Topic-level TTL override in ms, when configured. */
  ttlMs: number | null
  createdAt: number
  /** Next offset to assign (equals the number of messages ever appended). */
  nextOffset: number
}

/** Lifecycle state of one message: live until its deadline forces archival. */
export type QueueMessageState = 'live' | 'archived'

/** One appended message. */
export interface QueueMessageInfo {
  topicId: number
  /** Kafka-style offset inside the topic; dense, monotonic, never reused. */
  offset: number
  payload: unknown
  headers: Readonly<Record<string, string>>
  /** Publisher identity: a session id or `panel`. */
  publisher: string
  publishedAt: number
  expiresAt: number
  state: QueueMessageState
}

/** One subscription row — the session × topic relation model. */
export interface QueueSubscriptionInfo {
  sessionId: string
  topicId: number
  /** Delivery watermark: the highest offset accounted for (delivered or skipped). */
  cursor: number
  subscribedAt: number
  lastDeliveredAt: number | null
}

/** Aggregate topic view for list and stats surfaces. */
export interface QueueTopicStats {
  topic: QueueTopicInfo
  liveCount: number
  archivedCount: number
  subscriberCount: number
  oldestLiveOffset: number | null
  newestLiveOffset: number | null
}
