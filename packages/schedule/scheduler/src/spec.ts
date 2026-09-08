/**
 * Storage Domain for the scheduler's central durable records.
 * @module @deepseek-ai/dsh-scheduler/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ScheduleRecord } from './types.ts'

const scheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('after'), delayMs: z.number().int().positive() }),
  z.object({ kind: z.literal('at'), at: z.string().min(1) }),
  z.object({
    kind: z.literal('every'),
    intervalMs: z.number().int().positive(),
    anchor: z.string().min(1),
  }),
])

const scheduleRecordSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  rule: scheduleRuleSchema,
  target: z.object({ kind: z.enum(['current', 'job']) }),
  contextMode: z.enum(['fresh', 'continue']),
  createdBy: z.object({
    kind: z.enum(['user', 'model']),
    sessionId: z.string().min(1),
  }),
  status: z.enum(['active', 'paused', 'done']),
  jobSessionId: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  nextDue: z.number().int().nonnegative().optional(),
  lastRunAt: z.number().int().nonnegative().optional(),
  lastDue: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
}) as unknown as z.ZodType<ScheduleRecord>

/** Durable central store for scheduled prompts. */
export const schedulerDomainSpec = defineDomain({
  name: 'scheduler',
  version: 0,
  tables: {
    schedules: domainTable<string, ScheduleRecord>(scheduleRecordSchema),
  },
})
