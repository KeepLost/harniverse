/** Runtime schemas for the consolidated `session.status` snapshot. */

import { z } from 'zod'
import type { SessionPendingInteraction } from './sessions.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { rpcIdSchema } from './rpc.schema.ts'
import { approvalRequestIdSchema } from './approvals.schema.ts'
import { askUserQuestionItemSchema, queuedInboxItemSchema } from './events.schema.ts'
import { hostBootIdSchema } from './host.schema.ts'
import { taskViewSchema } from './jobs.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** session.status request payload. */
export const sessionStatusRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'session.status'>>>

/** One answerable request in the Host's process-local pending registry. */
const sessionPendingInteractionSchema = z.object({
  rpcId: rpcIdSchema,
  payload: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('question/requested'),
      sessionId: sessionIdSchema,
      questions: z.array(askUserQuestionItemSchema).min(1),
    }),
    z.object({
      type: z.literal('approval/requested'),
      sessionId: sessionIdSchema,
      approvalId: approvalRequestIdSchema,
      toolName: z.string(),
      callId: z.string().optional(),
      reason: z.string().optional(),
    }),
  ]),
}) as unknown as z.ZodType<Wire<SessionPendingInteraction>>

/** session.status response value. */
export const sessionStatusValueSchema: z.ZodType<Wire<ResponseValue<'session.status'>>> = z.object({
  sessionId: sessionIdSchema,
  bootId: hostBootIdSchema,
  attached: z.boolean(),
  running: z.boolean(),
  closing: z.boolean(),
  lastSeq: z.number().int().min(-1),
  queue: z.array(queuedInboxItemSchema),
  jobs: z.array(taskViewSchema),
  interactions: z.array(sessionPendingInteractionSchema),
}) as unknown as z.ZodType<Wire<ResponseValue<'session.status'>>>
