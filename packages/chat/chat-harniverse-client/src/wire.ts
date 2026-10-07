/**
 * Wire envelopes and mux-frame parsing. The schemas mirror the `/api` carrier
 * contract for the fields the bridge reads and nothing else; the keyless web
 * e2e pins them against the real carrier.
 * @module @deepseek-ai/dsh-chat-harniverse-client/wire
 */

import { z } from 'zod'
import type { HarniversePrincipal, MuxFrame, QuestionItem } from './types.ts'

const principalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bypass') }),
  z.object({ kind: z.literal('grant'), grantId: z.string().min(1), grantRevision: z.number().int().nonnegative() }),
])

/** Authentication identity as reported in `authentication` fields. */
export type WirePrincipal = z.infer<typeof principalSchema>

const rpcErrorSchema = z.looseObject({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()) })

/** `server-response` envelope; `value` is validated by the endpoint row. */
export const serverResponseSchema = z.object({
  type: z.literal('server-response'),
  rpcId: z.string(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown().optional() }),
    z.object({ ok: z.literal(false), error: rpcErrorSchema }),
  ]),
  authentication: principalSchema,
})

/** Carrier receipt of `/api/respond`. */
export const receiptSchema = z.union([
  z.object({ accepted: z.literal(true), authentication: principalSchema }),
  z.object({
    accepted: z.literal(false),
    reason: z.enum(['not-pending', 'bad-response', 'authentication-principal-mismatch']),
    authentication: principalSchema,
  }),
])

/** Stored attachment handle. */
export const uploadedAttachmentSchema = z.looseObject({
  attachmentId: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  name: z.string().optional(),
  mediaType: z.string().optional(),
})

/** Method name of the identity control frame opening every mux stream. */
export const CONNECTION_AUTHENTICATED_METHOD = 'connection.authenticated'

const serverRequestSchema = z.object({ type: z.literal('server-request'), rpcId: z.string(), method: z.string(), payload: z.unknown() })

const sessionId = z.string().min(1)

const questionItemSchema: z.ZodType<QuestionItem> = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  intent: z.object({ kind: z.literal('plan-review'), approve: z.string() }).optional(),
}) as unknown as z.ZodType<QuestionItem>

const consumedFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session/event'), sessionId, event: z.object({ type: z.string(), seq: z.number().int().nonnegative(), time: z.number(), data: z.unknown() }) }),
  z.object({ type: z.literal('approval/requested'), sessionId, approvalId: z.string(), toolName: z.string(), callId: z.string().optional(), reason: z.string().optional() }),
  z.object({ type: z.literal('approval/resolved'), sessionId, approvalId: z.string(), outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']) }),
  z.object({ type: z.literal('question/requested'), sessionId, questions: z.array(questionItemSchema).min(1) }),
  z.object({ type: z.literal('question/resolved'), sessionId, questionRpcId: z.string(), outcome: z.enum(['answered', 'cancelled']) }),
])

const CONSUMED_FRAME_KINDS: ReadonlySet<unknown> = new Set([
  'session/event', 'approval/requested', 'approval/resolved', 'question/requested', 'question/resolved',
])

/** Result of parsing one mux text message. */
export type ParsedMuxMessage =
  | { kind: 'identity'; principal: WirePrincipal }
  | { kind: 'frame'; rpcId: string; frame: MuxFrame }
  | { kind: 'ignored' }

/**
 * Parse one mux text message into an identity signal, a consumed frame, or an
 * ignorable frame kind. Malformed JSON or a consumed kind with a wrong shape
 * throws so the caller logs and drops it.
 * @param text - raw WebSocket text.
 * @returns the classified message.
 */
export function parseMuxMessage(text: string): ParsedMuxMessage {
  const request = serverRequestSchema.parse(JSON.parse(text))
  if (request.method === CONNECTION_AUTHENTICATED_METHOD) {
    return { kind: 'identity', principal: principalSchema.parse(request.payload) }
  }
  if (!CONSUMED_FRAME_KINDS.has((request.payload as { type?: unknown } | null)?.type)) return { kind: 'ignored' }
  return { kind: 'frame', rpcId: request.rpcId, frame: consumedFrameSchema.parse(request.payload) as MuxFrame }
}

/**
 * Narrow a wire principal to a grant identity.
 * @param principal - identity from the carrier.
 * @returns the grant identity, or undefined for a bypass instance.
 */
export function grantPrincipal(principal: WirePrincipal): HarniversePrincipal | undefined {
  return principal.kind === 'grant' ? principal : undefined
}
