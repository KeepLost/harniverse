/**
 * speech domain zod schemas: the transcription request and value validators
 * and the preparation request and value validators.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** Wire validator for one transcription request. */
export const speechTranscribeRequestSchema = z.object({
  wavBase64: z.string().min(44),
  language: z.string().min(2).max(35).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'speech.transcribe'>>>

/** Wire validator for one transcription result. */
export const speechTranscribeValueSchema = z.object({
  text: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'speech.transcribe'>>>

/** Wire validator for one preparation request. */
export const speechPrepareRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'speech.prepare'>>>

/** Wire validator for one preparation result. */
export const speechPrepareValueSchema = z.object({
  status: z.union([z.literal('ready'), z.literal('unprepared'), z.literal('failed')]),
  detail: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'speech.prepare'>>>
