/**
 * tasks domain zod schemas: the branded job id, the wire view carried by
 * `session/jobs` frames, and the follow/kill request and value validators.
 */

import { z } from 'zod'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobView } from './jobs.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** JobId: one brand cast after non-empty string validation. */
export const taskIdSchema = z.string().min(1) as unknown as z.ZodType<JobId>

/**
 * One wire task view. `kind` stays an open string because producer plugins
 * extend the registry's kind map by declaration merging, so the closed set is
 * not knowable at this boundary.
 */
export const taskViewSchema = z.object({
  operationId: z.string().min(1).optional(),
  id: taskIdSchema,
  kind: z.string().min(1),
  label: z.string().min(1),
  status: z.union([
    z.literal('running'),
    z.literal('stopping'),
    z.literal('completed'),
    z.literal('killed'),
    z.literal('failed'),
  ]),
  detail: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<Wire<JobView>>

/** Wire validator for one output-ring follow request. */
export const jobsFollowRequestSchema = z.object({
  sessionId: sessionIdSchema,
  jobId: taskIdSchema,
  offsetBytes: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'jobs.follow'>>>

/** Wire validator for one output-ring follow result. */
export const jobsFollowValueSchema = z.object({
  text: z.string(),
  nextOffsetBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  totalBytes: z.number().int().nonnegative(),
  status: z.union([
    z.literal('running'),
    z.literal('stopping'),
    z.literal('completed'),
    z.literal('killed'),
    z.literal('failed'),
  ]),
}) satisfies z.ZodType<Wire<ResponseValue<'jobs.follow'>>>

/** Wire validator for one human-stop request. */
export const jobsKillRequestSchema = z.object({
  sessionId: sessionIdSchema,
  jobId: taskIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'jobs.kill'>>>

/** Wire validator for one human-stop result. */
export const jobsKillValueSchema = z.object({
  result: z.union([z.literal('requested'), z.literal('already-finished')]),
}) satisfies z.ZodType<Wire<ResponseValue<'jobs.kill'>>>
