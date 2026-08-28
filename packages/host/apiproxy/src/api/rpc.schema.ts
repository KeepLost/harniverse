/**
 * Message-layer zod schemas: the four wire full forms + error body +
 * carrier receipt. The payload slot is unknown in the full-form schemas — business payloads
 * get a second parse dispatched by method (two-level parse discipline).
 * Brand cast point: rpcIdSchema, and only there.
 */

import { z } from 'zod'
import type { z as zCore } from 'zod'
type ZodIssue = zCore.core.$ZodIssue
import type { ClientRequest, ClientResponse, RequestId, RpcError, RpcId, RpcReceipt, ServerRequest, ServerResponse } from './rpc.ts'
import type { AuthenticationPrincipalIdentity } from '@deepseek-ai/dsh-authentication'

/**
 * Wire widening of a contract type: widens every property (deeply) to `original | undefined`.
 * The repo enables exactOptionalPropertyTypes while zod `.optional()` outputs `T | undefined`,
 * so `satisfies z.ZodType<ContractType>` is unusable across the board; anchoring is always
 * written `satisfies z.ZodType<Wire<ContractType>>` — the widening only adds undefined, so
 * missing fields / wrong types still fail to compile. On the JSON wire, "absent" and
 * "value undefined" serialize identically, so the widening loses no validation semantics.
 */
export type Wire<T> = T extends readonly (infer E)[] ? Wire<E>[]
  : T extends object ? { [K in keyof T]: Wire<T[K]> | undefined }
    : T

/**
 * RpcId: one brand cast after schema validation (the only cast point in this
 * file). No min-length: the id is an opaque echo token, and rejecting values
 * here would only turn a correlatable error report into a client-side parse
 * failure (the handler substitutes a sentinel when a request's id is unreadable).
 */
export const rpcIdSchema = z.string() as unknown as z.ZodType<RpcId>

/** Request correlation id; unlike rpcId it may be reused for a retry. */
export const requestIdSchema = z.string().min(1) as unknown as z.ZodType<RequestId>

/** Stable non-secret principal identity carried by authenticated transports. */
export const authenticationPrincipalIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bypass') }),
  z.object({
    kind: z.literal('grant'),
    grantId: z.string().min(1),
    grantRevision: z.number().int().nonnegative(),
  }),
]) as unknown as z.ZodType<AuthenticationPrincipalIdentity>

/** Error body: discriminated by code, per-branch details aligned to RpcErrorDetailsMap; details is required. */
export const rpcErrorSchema: z.ZodType<RpcError> = z.discriminatedUnion('code', [
  z.object({ code: z.literal('authentication-principal-mismatch'), message: z.string(), details: z.object({}) }),
  z.object({ code: z.literal('bad-request'), message: z.string(), details: z.object({ issues: z.array(z.custom<ZodIssue>()) }) }),
  z.object({ code: z.literal('cancelled'), message: z.string(), details: z.object({}) }),
  z.object({ code: z.literal('session-not-found'), message: z.string(), details: z.object({ sessionId: z.string() }) }),
  z.object({ code: z.literal('model-unavailable'), message: z.string(), details: z.object({ provider: z.string(), model: z.string() }) }),
  z.object({ code: z.literal('session-conflict'), message: z.string(), details: z.object({ sessionId: z.string(), requestedCwd: z.string(), existingCwd: z.string().optional() }) }),
  z.object({ code: z.literal('session-has-children'), message: z.string(), details: z.object({ sessionId: z.string(), childSessionIds: z.array(z.string()) }) }),
  z.object({ code: z.literal('invalid-time-zone'), message: z.string(), details: z.object({ value: z.string() }) }),
  z.object({ code: z.literal('workspace-attach-failed'), message: z.string(), details: z.object({ sessionId: z.string(), workspaceId: z.string() }) }),
  z.object({ code: z.literal('workspace-not-found'), message: z.string(), details: z.object({ workspaceId: z.string() }) }),
  z.object({ code: z.literal('workspace-invalid-path'), message: z.string(), details: z.object({ path: z.string() }) }),
  z.object({ code: z.literal('workspace-name-conflict'), message: z.string(), details: z.object({ name: z.string() }) }),
  z.object({ code: z.literal('workspace-move-invalid'), message: z.string(), details: z.object({ workspaceId: z.string(), sessionId: z.string(), beforeSessionId: z.string().optional() }) }),
  z.object({ code: z.literal('workspace-path-invalid'), message: z.string(), details: z.object({ workspaceId: z.string(), path: z.string() }) }),
  z.object({ code: z.literal('workspace-entry-not-found'), message: z.string(), details: z.object({ workspaceId: z.string(), path: z.string() }) }),
  z.object({ code: z.literal('workspace-entry-not-readable'), message: z.string(), details: z.object({ workspaceId: z.string(), path: z.string() }) }),
  z.object({ code: z.literal('workspace-entry-type-invalid'), message: z.string(), details: z.object({ workspaceId: z.string(), path: z.string() }) }),
  z.object({ code: z.literal('workspace-file-binary'), message: z.string(), details: z.object({ workspaceId: z.string(), path: z.string() }) }),
  z.object({ code: z.literal('workspace-file-preview-unsupported'), message: z.string(), details: z.object({ workspaceId: z.string(), path: z.string() }) }),
  z.object({ code: z.literal('workspace-file-too-large'), message: z.string(), details: z.object({ workspaceId: z.string(), path: z.string() }) }),
  z.object({ code: z.literal('workspace-git-not-repository'), message: z.string(), details: z.object({ workspaceId: z.string() }) }),
  z.object({ code: z.literal('workspace-git-failed'), message: z.string(), details: z.object({ workspaceId: z.string(), operation: z.string() }) }),
  z.object({ code: z.literal('directory-unreadable'), message: z.string(), details: z.object({ path: z.string() }) }),
  z.object({ code: z.literal('directory-exists'), message: z.string(), details: z.object({ path: z.string() }) }),
  z.object({ code: z.literal('directory-create-failed'), message: z.string(), details: z.object({ path: z.string() }) }),
  z.object({ code: z.literal('directory-picker-unavailable'), message: z.string(), details: z.object({ capability: z.string() }) }),
  z.object({ code: z.literal('agent-preset-read-only'), message: z.string(), details: z.object({ agentPreset: z.string(), reason: z.string() }) }),
  z.object({ code: z.literal('agent-preset-conflict'), message: z.string(), details: z.object({ sessionId: z.string(), requestedPreset: z.string(), existingPreset: z.string().optional() }) }),
  z.object({ code: z.literal('agent-preset-not-found'), message: z.string(), details: z.object({ agentPreset: z.string(), available: z.array(z.string()) }) }),
  z.object({ code: z.literal('agent-preset-invalid'), message: z.string(), details: z.object({ agentPreset: z.string(), reason: z.string() }) }),
  z.object({ code: z.literal('agent-busy'), message: z.string(), details: z.object({ reason: z.string() }) }),
  z.object({ code: z.literal('attachment-error'), message: z.string(), details: z.object({ reason: z.string() }) }),
  z.object({ code: z.literal('queue-item-not-found'), message: z.string(), details: z.object({ itemId: z.string() }) }),
  z.object({ code: z.literal('steer-unavailable'), message: z.string(), details: z.object({ itemId: z.string() }) }),
  z.object({ code: z.literal('command-error'), message: z.string(), details: z.object({}) }),
  z.object({ code: z.literal('unknown-command'), message: z.string(), details: z.object({}) }),
  z.object({ code: z.literal('settings-rejected'), message: z.string(), details: z.object({ ns: z.string() }) }),
  z.object({ code: z.literal('settings-not-exposed'), message: z.string(), details: z.object({ ns: z.string() }) }),
  z.object({ code: z.literal('settings-conflict'), message: z.string(), details: z.object({ ns: z.string(), expected: z.number(), actual: z.number() }) }),
  z.object({ code: z.literal('credential-rejected'), message: z.string(), details: z.object({ ref: z.string() }) }),
  z.object({ code: z.literal('model-discovery-failed'), message: z.string(), details: z.object({ settingsNs: z.string(), baseURL: z.string().optional() }) }),
  z.object({ code: z.literal('title-invalid'), message: z.string(), details: z.object({ sessionId: z.string() }) }),
  z.object({ code: z.literal('fork-unavailable'), message: z.string(), details: z.object({ sessionId: z.string() }) }),
  z.object({ code: z.literal('subagent-parent-unavailable'), message: z.string(), details: z.object({ parentSessionId: z.string() }) }),
  z.object({ code: z.literal('subagent-not-found'), message: z.string(), details: z.object({ parentSessionId: z.string(), childSessionId: z.string() }) }),
  z.object({ code: z.literal('subagent-catalog-diagnostic'), message: z.string(), details: z.object({
    parentSessionId: z.string(),
    childSessionId: z.string(),
    reason: z.union([z.literal('corrupt'), z.literal('unsupported'), z.literal('unavailable')]),
  }) }),
  z.object({ code: z.literal('subagent-not-resumable'), message: z.string(), details: z.object({ childSessionId: z.string() }) }),
  z.object({ code: z.literal('subagent-unauthorized'), message: z.string(), details: z.object({ childSessionId: z.string() }) }),
  z.object({ code: z.literal('subagent-delivery-unavailable'), message: z.string(), details: z.object({ childSessionId: z.string() }) }),
  z.object({ code: z.literal('internal'), message: z.string(), details: z.object({}) }),
  z.object({ code: z.literal('idempotency-key-reused'), message: z.string(), details: z.object({ key: z.string().min(1) }) }),
  z.object({ code: z.literal('operation-not-found'), message: z.string(), details: z.object({ operationId: z.string().min(1) }) }),
]) as unknown as z.ZodType<RpcError>

/**
 * Business success/failure result schema (generic, reusable).
 * @param value - Schema for the business value.
 * @returns Schema for RpcResult<T>.
 */
export function rpcResultSchema<T>(value: z.ZodType<T>): z.ZodUnion<readonly [z.ZodType, z.ZodType]> {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: rpcErrorSchema }),
  ])
}

// ---- The four wire full-form schemas (payload/result.value slots stay wide — business layer does the second parse) ----
// The wide value slot is optional: a void business result serializes with no
// `value` field at all. Each endpoint's own second parse still requires its
// declared value, so absence never passes for a method that returns data.

/** ClientRequest full form (payload stays wide — the business layer runs the second parse). */
export const clientRequestSchema = z.object({
  type: z.literal('client-request'),
  rpcId: rpcIdSchema,
  method: z.string(),
  payload: z.unknown(),
  expectedPrincipal: authenticationPrincipalIdentitySchema.optional(),
  requestId: requestIdSchema.optional(),
}) as unknown as z.ZodType<ClientRequest>

/** ServerResponse full form (result.value stays wide). */
export const serverResponseSchema = z.object({
  type: z.literal('server-response'),
  rpcId: rpcIdSchema,
  result: rpcResultSchema(z.unknown().optional()),
  authentication: authenticationPrincipalIdentitySchema,
  requestId: requestIdSchema.optional(),
}) as unknown as z.ZodType<ServerResponse>

/** ServerRequest full form (payload stays wide). */
export const serverRequestSchema = z.object({
  type: z.literal('server-request'),
  rpcId: rpcIdSchema,
  method: z.string(),
  payload: z.unknown(),
}) as unknown as z.ZodType<ServerRequest>

/** ClientResponse full form (result.value stays wide). */
export const clientResponseSchema = z.object({
  type: z.literal('client-response'),
  rpcId: rpcIdSchema,
  result: rpcResultSchema(z.unknown().optional()),
  expectedPrincipal: authenticationPrincipalIdentitySchema.optional(),
}) as unknown as z.ZodType<ClientResponse>

/** Wire full-form union (discriminated by type). */
export const rpcMessageSchema = z.discriminatedUnion('type', [
  clientRequestSchema as unknown as z.ZodObject<z.ZodRawShape>,
  serverResponseSchema as unknown as z.ZodObject<z.ZodRawShape>,
  serverRequestSchema as unknown as z.ZodObject<z.ZodRawShape>,
  clientResponseSchema as unknown as z.ZodObject<z.ZodRawShape>,
])

/** Carrier receipt schema. */
export const rpcReceiptSchema = z.union([
  z.object({ accepted: z.literal(true), authentication: authenticationPrincipalIdentitySchema }),
  z.object({
    accepted: z.literal(false),
    reason: z.union([
      z.literal('not-pending'), z.literal('bad-response'), z.literal('authentication-principal-mismatch'),
    ]),
    authentication: authenticationPrincipalIdentitySchema,
  }),
]) satisfies z.ZodType<Wire<RpcReceipt>>
