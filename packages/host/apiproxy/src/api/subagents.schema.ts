/** Zod schemas for the browser-safe subagent domain. */

import { z } from 'zod'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import {
  contentBlockSchema, historyEntrySchema, sessionIdSchema, sessionProjectionsBlockSchema,
} from './sessions.schema.ts'
import type { SubagentListEntry, SubagentProfileSnapshot } from './subagents.ts'

const childProfileSchema = z.object({
  profileId: z.string(),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  harnessId: z.string(),
  modelRouteId: z.string(),
  tools: z.array(z.string()),
  skills: z.array(z.string()),
  mcpServerIds: z.array(z.string()),
  childProfileIds: z.array(z.string()),
  workspaceCwd: z.string(),
  maxDepth: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  modelRoutePriority: z.number().int().nonnegative().optional(),
  schedulerPriority: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<Wire<SubagentProfileSnapshot>>

/** subagent.profiles response value. */
export const subagentProfilesValueSchema = z.object({
  profiles: z.array(childProfileSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'subagent.profiles'>>>

/** subagent.profiles request payload. */
export const subagentProfilesRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'subagent.profiles'>>>

/** Healthy and diagnostic durable catalog rows. */
export const subagentListEntrySchema = z.union([
  z.object({
    kind: z.literal('child'),
    id: sessionIdSchema,
    mode: z.literal('one-shot'),
    activity: z.union([z.literal('running'), z.literal('inactive')]),
    hasChildren: z.boolean(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('child'),
    id: sessionIdSchema,
    mode: z.literal('continuable'),
    activity: z.union([z.literal('running'), z.literal('inactive')]),
    hasChildren: z.boolean(),
    label: z.string(),
  }),
  z.object({
    kind: z.literal('diagnostic'),
    id: sessionIdSchema,
    reason: z.union([z.literal('corrupt'), z.literal('unsupported'), z.literal('unavailable')]),
  }),
]) satisfies z.ZodType<Wire<SubagentListEntry>>

/** subagent.list request payload. */
export const subagentListRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'subagent.list'>>>

/** subagent.list response value. */
export const subagentListValueSchema = z.object({
  entries: z.array(subagentListEntrySchema),
  parentAvailable: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'subagent.list'>>>

/** subagent.history request payload. */
export const subagentHistoryRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
  childSessionId: sessionIdSchema,
  mode: z.union([z.literal('one-shot'), z.literal('continuable')]),
  beforeSeq: z.number().int().nonnegative().optional(),
  maxMessages: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'subagent.history'>>>

/** subagent.history response value. */
export const subagentHistoryValueSchema = z.object({
  events: z.array(historyEntrySchema),
  hasMore: z.boolean(),
  projections: sessionProjectionsBlockSchema.optional(),
}) as unknown as z.ZodType<Wire<ResponseValue<'subagent.history'>>>

/** subagent.prompt request payload. */
export const subagentPromptRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
  childSessionId: sessionIdSchema,
  mode: z.literal('continuable'),
  content: z.array(contentBlockSchema),
  clientTimeZone: z.string().optional(),
}) as unknown as z.ZodType<RequestPayload<'subagent.prompt'>>

/** subagent.interrupt request payload. */
export const subagentInterruptRequestSchema = z.object({
  parentSessionId: sessionIdSchema,
  childSessionId: sessionIdSchema,
  mode: z.literal('continuable'),
}) satisfies z.ZodType<Wire<RequestPayload<'subagent.interrupt'>>>

/** subagent.interrupt response value. */
export const subagentInterruptValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'subagent.interrupt'>>>

const messageIdSchema = z.string() as unknown as z.ZodType<MessageId>

/** subagent.prompt response value. */
export const subagentPromptValueSchema = z.object({
  messageId: messageIdSchema,
  operationId: z.string().min(1),
}) satisfies z.ZodType<Wire<ResponseValue<'subagent.prompt'>>>
