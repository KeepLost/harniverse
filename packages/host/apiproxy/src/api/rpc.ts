/**
 * Four-quadrant RPC message model. Channels and messages are decoupled: HTTP,
 * WebSocket, and in-process SSE are physical carriers, while logical messages
 * are channel-independent and form a four-member discriminated union.
 * api/ contract layer: zero Node dependencies, importable from the browser.
 */
import type {
  AuthenticationPrincipal, AuthenticationPrincipalIdentity,
} from '@deepseek-ai/dsh-authentication'
import type { z as zCore } from 'zod'
type ZodIssue = zCore.core.$ZodIssue
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Message correlation id: the initiator mints it on a request; a response
 * echoes the matching request's rpcId and never mints a new one.
 */
export type RpcId = Branded<'rpc-id'>

/**
 * Brands a string as RpcId (same precedent as core `SessionId()`). Minted by the initiator:
 * client-request → client mints; server-request → host mints (answerable frames get a stable
 * logical id, pure pushes mint a fresh one each time).
 * @param id - Raw id string (implementations mint UUIDs; tests may pass fixtures).
 * @returns The same string, branded (compile-time cast, zero runtime cost).
 */
export function RpcId(id: string): RpcId {
  return id as RpcId
}

/** Request correlation id: stable across retries of one logical client operation. */
export type RequestId = Branded<'request-id'>

/** Brand a raw request correlation id after the wire schema has validated it.
 * @param id - validated non-empty request correlation id.
 * @returns the branded request correlation id.
 */
export function RequestId(id: string): RequestId {
  return id as RequestId
}

/** Error code → details type map (a second table isomorphic to RpcMethodMap). New code = one row here + one branch in the error schema. */
export interface RpcErrorDetailsMap {
  /** The authenticated principal changed after the client initiated a mutation. */
  'authentication-principal-mismatch': {}
  'bad-request': { issues: ZodIssue[] }
  'cancelled': {}
  'session-not-found': { sessionId: SessionId }
  'model-unavailable': { provider: string; model: string }
  'session-conflict': { sessionId: SessionId; requestedCwd: string; existingCwd?: string }
  'session-has-children': { sessionId: SessionId; childSessionIds: SessionId[] }
  'invalid-time-zone': { value: string }
  'workspace-attach-failed': { sessionId: SessionId; workspaceId: string }
  'workspace-not-found': { workspaceId: string }
  'workspace-invalid-path': { path: string }
  'workspace-name-conflict': { name: string }
  'workspace-move-invalid': { workspaceId: string; sessionId: SessionId; beforeSessionId?: SessionId }
  'workspace-path-invalid': { workspaceId: string; path: string }
  'workspace-entry-not-found': { workspaceId: string; path: string }
  'workspace-entry-not-readable': { workspaceId: string; path: string }
  'workspace-entry-type-invalid': { workspaceId: string; path: string }
  'workspace-file-binary': { workspaceId: string; path: string }
  'workspace-file-preview-unsupported': { workspaceId: string; path: string }
  'workspace-file-too-large': { workspaceId: string; path: string }
  'workspace-git-not-repository': { workspaceId: string }
  'workspace-git-failed': { workspaceId: string; operation: string }
  'directory-unreadable': { path: string }
  'directory-exists': { path: string }
  'directory-create-failed': { path: string }
  'directory-picker-unavailable': { capability: string }
  'agent-preset-read-only': { agentPreset: string; reason: string }
  'agent-preset-conflict': { sessionId: SessionId; requestedPreset: string; existingPreset?: string }
  'agent-preset-not-found': { agentPreset: string; available: string[] }
  'agent-preset-invalid': { agentPreset: string; reason: string }
  'agent-busy': { reason: string }
  'attachment-error': { reason: string }
  'queue-item-not-found': { itemId: MessageId }
  'steer-unavailable': { itemId: MessageId }
  /** A known slash command reported a usage/state error; the message is the command's own text. */
  'command-error': {}
  /** A leading-/ prompt named no registered command; the message names the token. */
  'unknown-command': {}
  /**
   * A settings write was refused (schema validation, unknown namespace,
   * read-only provider, or storage failure); the message is the seam's text.
   */
  'settings-rejected': { ns: string }
  /**
   * A settings namespace exists in the seam but is outside the configuration
   * plane's model-provider boundary, so this proxy neither reads nor writes
   * it; the message names the namespace.
   */
  'settings-not-exposed': { ns: string }
  /**
   * A settings write carried an `expectedRevision` the namespace has already
   * moved past: another writer (tab, editor, or an external file edit) landed
   * first. The details carry both revisions so a client can re-read and retry.
   */
  'settings-conflict': { ns: string; expected: number; actual: number }
  /** A credential write was refused (read-only shadowing layer or storage failure); the message is the seam's own text. */
  'credential-rejected': { ref: string }
  /**
   * Interrogating a draft provider endpoint did not produce a model listing:
   * no adapter family serves the namespace, the protocol has no listing this
   * build can read, or the endpoint was unreachable, refused the credential,
   * or answered with something else. The message is the adapter's own text —
   * it is what the form shows before falling back to hand-entry — and the
   * details name the endpoint asked, never the credential offered.
   */
  'model-discovery-failed': { settingsNs: string; baseURL?: string }
  'title-invalid': { sessionId: SessionId }
  'fork-unavailable': { sessionId: SessionId }
  'subagent-parent-unavailable': { parentSessionId: SessionId }
  'subagent-not-found': { parentSessionId: SessionId; childSessionId: SessionId }
  'subagent-catalog-diagnostic': {
    parentSessionId: SessionId
    childSessionId: SessionId
    reason: 'corrupt' | 'unsupported' | 'unavailable'
  }
  'subagent-not-resumable': { childSessionId: SessionId }
  'subagent-unauthorized': { childSessionId: SessionId }
  'subagent-delivery-unavailable': { childSessionId: SessionId }
  'internal': {}
  /** The same idempotency key was reused with a different operation payload. */
  'idempotency-key-reused': { key: string }
  /** No operation with that id is visible in this Host process. */
  'operation-not-found': { operationId: string }
}

/** Closed error-code union (the keys of RpcErrorDetailsMap). */
export type RpcErrorCode = keyof RpcErrorDetailsMap

/**
 * Distributive union expanded from the map: code is the discriminant, so
 * `switch (error.code)` narrows details. details is required (internal uses an explicit {}).
 */
export type RpcError = {
  [C in RpcErrorCode]: { code: C; message: string; details: RpcErrorDetailsMap[C] }
}[RpcErrorCode]

/** Business success/failure result: the result slot of a unary response; methods never throw business errors. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/**
 * Fold a transport exception into the RpcResult error branch (unified error
 * API; 'internal' as the catch-all code). Lives with RpcResult so every
 * carrier consumer folds the same way.
 * @param error - the thrown value from the carrier.
 * @returns the error branch of an RpcResult.
 */
export function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
  }
}

/**
 * Signature-layer narrow form, request side (domain-interface view, shared by
 * both directions): rpcId is explicit in the signature, never mixed into the
 * business payload; the type tag and method are filled in by the carrier layer.
 */
export interface RpcRequest<P> {
  rpcId: RpcId
  payload: P
  /** Authenticated network identity; absent for in-process callers and server-originated frames. */
  principal?: AuthenticationPrincipal
  /** Correlates retries and server-side operation records independently of rpcId. */
  requestId?: RequestId
}

/** Signature-layer narrow form, response side: rpcId always echoes the matching request. */
export interface RpcResponse<T> {
  rpcId: RpcId
  result: RpcResult<T>
  /** Host-verified non-secret identity attached by an authenticated unary carrier. */
  authentication?: AuthenticationPrincipalIdentity
  /** Correlates the response with the logical client request. */
  requestId?: RequestId
}

/**
 * Compare the non-secret principal identities carried by browser transports.
 * @param left - one wire identity.
 * @param right - the other wire identity.
 * @returns whether both identify the same Host authorization generation.
 */
export function sameAuthenticationPrincipalIdentity(
  left: AuthenticationPrincipalIdentity | undefined,
  right: AuthenticationPrincipalIdentity | undefined,
): boolean {
  if (left?.kind === 'bypass') return right?.kind === 'bypass'
  if (left?.kind !== 'grant' || right?.kind !== 'grant') return false
  return left.grantId === right.grantId && left.grantRevision === right.grantRevision
}

// ---- Wire full forms: four named members of a discriminated union (discriminant = the four `type` literals) ----

/** Call initiated by the client (wire carrier: POST /api/<method> body). */
export interface ClientRequest {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: unknown
  /** Initiating identity required on mutating methods and checked by the authenticated Host carrier. */
  expectedPrincipal?: AuthenticationPrincipalIdentity
  /** Correlation id stable across retries of one logical request. */
  requestId?: RequestId
}

/** Response to a ClientRequest (wire carrier: the HTTP response body of that POST); rpcId echoed. */
export interface ServerResponse {
  type: 'server-response'
  rpcId: RpcId
  result: RpcResult<unknown>
  /** Host-verified non-secret identity attached by an authenticated unary carrier. */
  authentication?: AuthenticationPrincipalIdentity
  /** Correlation id copied from the initiating ClientRequest. */
  requestId?: RequestId
}

/** Transport control method preceding every authenticated downstream stream. */
export const CONNECTION_AUTHENTICATED_METHOD = 'connection.authenticated'

/**
 * Message initiated by the server (wire carrier: downstream stream frame). Answerable interactions
 * (approval/question requested — stable rpcId, reused on replay) and pure pushes
 * (session/event etc. — rpcId identifies that one push) share this shape; whether a
 * response is expected is determined statically by method (a strict dichotomy, no third kind).
 */
export interface ServerRequest {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

/** Response to a ServerRequest (wire carrier: POST /api/respond body); rpcId echoed, never minted anew. */
export interface ClientResponse {
  type: 'client-response'
  rpcId: RpcId
  result: RpcResult<unknown>
  /** Identity initiating this answer, checked before the Host claims the pending interaction. */
  expectedPrincipal?: AuthenticationPrincipalIdentity
}

/** Authoritative wire full-form union; narrow via `switch (message.type)`. */
export type RpcMessage = ClientRequest | ServerResponse | ServerRequest | ClientResponse

/**
 * Carrier receipt (not an RpcMessage — it belongs to the carrier layer, same
 * discipline as "HTTP status describes only the carrier"): the HTTP response
 * body of the POST carrying a client-response. Late/duplicate responses yield not-pending.
 */
export type RpcReceipt = {
  accepted: true
  /** Host-authenticated identity added by the carrier; absent on direct ApiProxy calls. */
  authentication?: AuthenticationPrincipalIdentity
} | {
  accepted: false
  reason: 'not-pending' | 'bad-response' | 'authentication-principal-mismatch'
  /** Host-authenticated identity added by the carrier; absent on direct ApiProxy calls. */
  authentication?: AuthenticationPrincipalIdentity
}
