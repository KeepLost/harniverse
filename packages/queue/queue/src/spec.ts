/**
 * Durable layout of the queue's storage domain: topics (id-keyed with a
 * unique-name index), messages (composite topic#offset keys), and the
 * subscription relation model (session#topic keys). See the package README
 * for the cascade and archival semantics these tables carry.
 * @module @deepseek-ai/dsh-queue/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const topicSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1),
  ttlMs: z.number().int().positive().nullable(),
  createdAt: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
})

const messageSchema = z.object({
  topicId: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  payload: z.unknown(),
  headers: z.record(z.string(), z.string()),
  publisher: z.string(),
  publishedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  state: z.enum(['live', 'archived']),
})

const subscriptionSchema = z.object({
  sessionId: z.string().min(1),
  topicId: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  subscribedAt: z.number().int().nonnegative(),
  lastDeliveredAt: z.number().int().nonnegative().nullable(),
})

/** Durable layout of the queue's storage domain. */
export const queueDomainSpec = defineDomain({
  name: 'queue',
  version: 1,
  migrateFrom: [],
  tables: {
    /** Topic records keyed by their numeric id rendered as a string; `topic_names` holds the unique alias index. */
    topics: domainTable<string, z.infer<typeof topicSchema>>(topicSchema),
    /** Unique-name index: topic name -> topic id. */
    topic_names: domainTable<string, number>(z.number().int().nonnegative()),
    /** All messages (live and archived), keyed `topicId#offset`. */
    messages: domainTable<string, z.infer<typeof messageSchema>>(messageSchema),
    /** The subscription relation model, keyed `sessionId#topicId`. */
    subscriptions: domainTable<string, z.infer<typeof subscriptionSchema>>(subscriptionSchema),
  },
})
