/** Wire schemas for operation lookup. */

import { z } from 'zod'
import type { OperationView } from './operations.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'

const messageIdSchema = z.string() as unknown as z.ZodType<MessageId>
const jobIdSchema = z.string().min(1) as unknown as z.ZodType<JobId>

/** Validate an operation lookup request and its optional ownership session. */
export const operationGetRequestSchema = z.object({
  operationId: z.string().min(1),
  sessionId: sessionIdSchema.optional(),
}) satisfies z.ZodType<Wire<{ operationId: string; sessionId?: SessionId }>>

/** Validate the point-in-time operation lifecycle view returned to clients. */
export const operationGetValueSchema = z.object({
  operationId: z.string().min(1),
  kind: z.union([z.literal('session.prompt'), z.literal('subagent.prompt'), z.literal('job')]),
  status: z.union([
    z.literal('accepted'), z.literal('running'), z.literal('succeeded'),
    z.literal('failed'), z.literal('cancelled'),
  ]),
  acceptedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  sessionId: sessionIdSchema.optional(),
  messageId: messageIdSchema.optional(),
  jobId: jobIdSchema.optional(),
}) satisfies z.ZodType<Wire<OperationView>>
