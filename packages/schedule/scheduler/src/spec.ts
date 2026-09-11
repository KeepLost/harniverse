/**
 * Storage Domain for the scheduler's central durable records.
 * @module @deepseek-ai/dsh-scheduler/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ScheduleRecord, ScheduleRun } from './types.ts'

const scheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('after'), delayMs: z.number().int().positive() }),
  z.object({ kind: z.literal('at'), at: z.string().min(1) }),
  z.object({
    kind: z.literal('every'),
    intervalMs: z.number().int().positive(),
    anchor: z.string().min(1),
  }),
])

const scheduleTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current') }),
  z.object({ kind: z.literal('job') }),
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
])

const scheduleRecordSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  rule: scheduleRuleSchema,
  target: scheduleTargetSchema,
  contextMode: z.enum(['fresh', 'continue']),
  createdBy: z.object({
    kind: z.enum(['user', 'model']),
    sessionId: z.string().min(1),
  }),
  status: z.enum(['active', 'paused', 'done']),
  jobSessionId: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  promptRevision: z.number().int().positive().optional(),
  lastPromptEdit: z.object({
    version: z.number().int().positive(),
    prompt: z.string().min(1),
    editedBy: z.object({
      kind: z.enum(['user', 'model']),
      sessionId: z.string().min(1),
    }),
    editedAt: z.number().int().nonnegative(),
  }).optional(),
  nextDue: z.number().int().nonnegative().optional(),
  lastRunAt: z.number().int().nonnegative().optional(),
  lastDue: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
}) as unknown as z.ZodType<ScheduleRecord>

const scheduleRunSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  ownerSessionId: z.string().min(1),
  targetSessionId: z.string().min(1),
  dueAt: z.number().int().nonnegative(),
  attemptedAt: z.number().int().nonnegative(),
  promptRevision: z.number().int().positive().optional(),
  status: z.enum(['succeeded', 'failed']),
  error: z.string().optional(),
}) as unknown as z.ZodType<ScheduleRun>

/**
 * Durable central store for scheduled prompts. Version 1 adds the `session`
 * delivery target; records of version 0 keep their layout unchanged, so the
 * stamp rewrites in place through `migrateFrom`.
 */
export const schedulerDomainSpec = defineDomain({
  name: 'scheduler',
  version: 1,
  migrateFrom: [0],
  tables: {
    schedules: domainTable<string, ScheduleRecord>(scheduleRecordSchema),
    runs: domainTable<string, ScheduleRun>(scheduleRunSchema),
  },
})
