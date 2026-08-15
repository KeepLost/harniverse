/** Durable HTTP notification outbox declaration. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { NotificationEventId } from '@deepseek-ai/dsh-notification'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { HttpNotificationEnvelope } from './config.ts'

/** Deterministic durable key for one endpoint/event pair. */
export type NotificationDeliveryKey = Branded<'NotificationDeliveryKey'>

/** Stable identifier reused by every attempt for one endpoint/event pair. */
export type NotificationDeliveryId = Branded<'NotificationDeliveryId'>

/** Privacy-minimized failure metadata retained with pending and dead records. */
export interface NotificationDeliveryFailure {
  kind: 'http' | 'network'
  status?: number
  errorName?: string
}

/** One durable delivery obligation or retained terminal tombstone. */
export interface NotificationOutboxRecord {
  deliveryId: NotificationDeliveryId
  endpointId: string
  event: HttpNotificationEnvelope
  status: 'pending' | 'delivered' | 'dead'
  attempts: number
  sequence: number
  createdAt: number
  updatedAt: number
  nextAttemptAt: number
  terminalAt?: number
  lastFailure?: NotificationDeliveryFailure
}

const subjectSchema = z.strictObject({
  sessionId: z.string().min(1).optional(),
  parentSessionId: z.string().min(1).optional(),
})
const baseEnvelope = {
  specVersion: z.literal(1),
  eventId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  subject: subjectSchema,
}
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const turnReasonSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('completed') }),
  z.strictObject({ kind: z.literal('aborted'), cause: z.enum(['user', 'parent', 'hook', 'disposed', 'legacy']) }),
  z.strictObject({ kind: z.literal('blocked') }),
  z.strictObject({ kind: z.literal('error'), error: z.strictObject({ code: z.string() }) }),
  z.strictObject({ kind: z.literal('max-tokens') }),
  z.strictObject({ kind: z.literal('interrupted') }),
  z.strictObject({ kind: z.literal('unknown') }),
])
/** Strict version-one envelope schema shared by synchronous admission and durable reload. */
export const notificationEnvelopeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...baseEnvelope,
    type: z.literal('session.turn-settled'),
    data: z.strictObject({ turn: sequence, seq: sequence, reason: turnReasonSchema }),
  }),
  z.strictObject({ ...baseEnvelope, type: z.literal('session.closed'), data: z.strictObject({}) }),
  z.strictObject({ ...baseEnvelope, type: z.literal('session.detached'), data: z.strictObject({}) }),
  z.strictObject({
    ...baseEnvelope,
    type: z.literal('agent.status-changed'),
    data: z.strictObject({ status: z.enum(['running', 'idle']) }),
  }),
  z.strictObject({
    ...baseEnvelope,
    type: z.literal('approval.requested'),
    data: z.strictObject({
      approvalId: z.string().min(1),
      toolName: z.string().min(1),
      callId: z.string().min(1).optional(),
      turn: sequence,
      seq: sequence,
    }),
  }),
  z.strictObject({
    ...baseEnvelope,
    type: z.literal('approval.decided'),
    data: z.strictObject({
      approvalId: z.string().min(1),
      outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']),
      turn: sequence,
      seq: sequence,
    }),
  }),
  z.strictObject({
    ...baseEnvelope,
    type: z.literal('tool.called'),
    data: z.strictObject({
      callId: z.string().min(1),
      toolName: z.string().min(1),
      turn: sequence,
      step: sequence,
      seq: sequence,
    }),
  }),
  z.strictObject({
    ...baseEnvelope,
    type: z.literal('tool.settled'),
    data: z.strictObject({
      callId: z.string().min(1),
      toolName: z.string().min(1),
      turn: sequence,
      step: sequence,
      seq: sequence,
      ok: z.boolean(),
      error: z.strictObject({ name: z.string(), code: z.string() }).optional(),
    }),
  }),
]) as unknown as z.ZodType<HttpNotificationEnvelope>

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Durable schema for one outbox row. */
export const notificationOutboxRecordSchema = z.object({
  deliveryId: z.uuid().transform(value => value as NotificationDeliveryId),
  endpointId: z.string().min(1),
  event: notificationEnvelopeSchema,
  status: z.enum(['pending', 'delivered', 'dead']),
  attempts: nonNegativeSafeInteger,
  sequence: nonNegativeSafeInteger,
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
  nextAttemptAt: nonNegativeSafeInteger,
  terminalAt: nonNegativeSafeInteger.optional(),
  lastFailure: z.object({
    kind: z.enum(['http', 'network']),
    status: z.number().int().min(100).max(599).optional(),
    errorName: z.string().min(1).optional(),
  }).optional(),
}).superRefine((record, ctx) => {
  if (record.updatedAt < record.createdAt) {
    ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'updatedAt must not precede createdAt' })
  }
  if ((record.status === 'pending') === (record.terminalAt !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['terminalAt'], message: 'terminalAt must exist exactly for terminal records' })
  }
}) as unknown as z.ZodType<NotificationOutboxRecord>

/** Storage Domain for durable pending work and retained terminal tombstones. */
export const notificationHttpDomainSpec = defineDomain({
  name: 'notification_http',
  version: 0,
  tables: {
    deliveries: domainTable<NotificationDeliveryKey, NotificationOutboxRecord>(notificationOutboxRecordSchema),
  },
})

/**
 * Derive the deduplication key for one endpoint/event pair.
 * @param endpointId - configured endpoint identity.
 * @param eventId - stable external event identity.
 * @returns fixed-width non-sensitive storage key.
 */
export function notificationDeliveryKey(
  endpointId: string,
  eventId: NotificationEventId,
): NotificationDeliveryKey {
  return createHash('sha256').update(endpointId).update('\0').update(eventId).digest('hex') as NotificationDeliveryKey
}
