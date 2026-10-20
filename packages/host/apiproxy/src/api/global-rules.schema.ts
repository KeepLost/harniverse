/**
 * global-rules domain zod schemas: the read and write request/value validators.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** Wire validator for one rules read request. */
export const globalRulesReadRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'globalRules.read'>>>

/** Wire validator for one rules read result. */
export const globalRulesReadValueSchema = z.object({
  exists: z.boolean(),
  content: z.string(),
  version: z.string().optional(),
  displayPath: z.string(),
  maxBytes: z.number().int().min(1),
}) satisfies z.ZodType<Wire<ResponseValue<'globalRules.read'>>>

/** Wire validator for one rules write request. */
export const globalRulesWriteRequestSchema = z.object({
  content: z.string(),
  expectedVersion: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'globalRules.write'>>>

/** Wire validator for one rules write result. */
export const globalRulesWriteValueSchema = z.object({
  version: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'globalRules.write'>>>
