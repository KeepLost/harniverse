/** Wire schemas for API contract discovery. */

import { z } from 'zod'
import type { ApiContractDescription, ApiMethodDescription } from './contract.ts'
import type { Wire } from './rpc.schema.ts'

/** Validate the empty payload accepted by `api.describe`. */
export const apiDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<Record<string, never>>>

const apiMethodDescriptionSchema = z.object({
  method: z.string().min(1),
  requiredCapability: z.union([
    z.literal('harniverse.observe'),
    z.literal('harniverse.operate'),
    z.literal('harniverse.administer'),
    z.literal('harniverse.authorize'),
  ]),
  effect: z.union([z.literal('read'), z.literal('mutate')]),
  stability: z.union([z.literal('stable'), z.literal('deprecated')]),
  replacement: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ApiMethodDescription>>

/** Validate the versioned public API registry returned by `api.describe`. */
export const apiDescribeValueSchema = z.object({
  version: z.literal(1),
  methods: z.array(apiMethodDescriptionSchema),
}) satisfies z.ZodType<Wire<ApiContractDescription>>
