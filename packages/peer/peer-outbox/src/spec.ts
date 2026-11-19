/**
 * Storage Domain for the peer outbox's central settlement ledger.
 * @module @deepseek-ai/dsh-peer-outbox/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { PeerOutboxEntry } from './types.ts'

const failureSchema = z.enum([
  'TARGET_UNREACHABLE',
  'TARGET_RECORD_NOT_FOUND',
  'SESSION_DROPPED',
  'OWNER_SESSION_NOT_LIVE',
  'READ_FAILED',
])

const entrySchema = z.object({
  id: z.string().min(1),
  targetInstanceId: z.string().min(1),
  targetDisplayName: z.string().min(1),
  peerSessionId: z.string().min(1),
  messageId: z.string().min(1),
  ownerSessionId: z.string().min(1),
  label: z.string(),
  state: z.enum(['watching', 'settled', 'failed']),
  submittedAt: z.number().int().nonnegative(),
  settledAt: z.number().int().nonnegative().optional(),
  reply: z.string().optional(),
  endReason: z.string().optional(),
  failureReason: failureSchema.optional(),
  failureDetail: z.string().optional(),
}) as unknown as z.ZodType<PeerOutboxEntry>

/**
 * Durable central ledger of watched delegated turns. Version 1 is the
 * initial layout; no prior versions exist.
 */
export const peerOutboxDomainSpec = defineDomain({
  name: 'peer_outbox',
  version: 1,
  tables: {
    entries: domainTable<string, PeerOutboxEntry>(entrySchema),
  },
})
