/**
 * Public value types of the Harniverse chat client. Types only — no runtime
 * code lives in this module.
 * @module @deepseek-ai/dsh-chat-harniverse-client/types
 */

/** Stable non-secret identity of the authenticated Grant, as the `/api` carrier reports it. */
export interface HarniversePrincipal {
  kind: 'grant'
  grantId: string
  grantRevision: number
}

/** Per-call options shared by every request kind. */
export interface CallOptions {
  /**
   * Forward the request to this remote runtime (`?dshRemoteHost=<uuid>`).
   * Must be a lowercase RFC 4122 version-4 UUID.
   */
  remoteHost?: string | undefined
  /** `Idempotency-Key` header; honored for mutating methods only. */
  idempotencyKey?: string | undefined
  /** Cancellation for this request. */
  signal?: AbortSignal | undefined
  /**
   * `rpcId` of the request envelope. `session.prompt` echoes it as the
   * `user/message` source, so a caller that registers interest before sending
   * can correlate the event with the request without a race.
   */
  rpcId?: string | undefined
}

/** The slice of `host.describe` the bridge reads. */
export interface HostDescription {
  bootId: string
  version?: string
  cwd?: string
}

/** Stored attachment handle returned by `POST /api/attachment/upload`. */
export interface UploadedAttachment {
  attachmentId: string
  bytes: number
  name?: string
  mediaType?: string
}

/** Receipt of `POST /api/respond`. */
export type RespondReceipt =
  | { accepted: true }
  | { accepted: false; reason: 'not-pending' | 'bad-response' | 'authentication-principal-mismatch' }

/** Result slot of a `client-response` envelope. */
export type RespondResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** Durable session event carried by a `session/event` frame; `data` stays wide. */
export interface MuxSessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/** One question of a `question/requested` frame. */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string }
}

/** The mux frames the chat bridge consumes; every other frame kind is dropped by the mux. */
export type MuxFrame =
  | { type: 'session/event'; sessionId: string; event: MuxSessionEvent }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { type: 'question/requested'; sessionId: string; questions: QuestionItem[] }
  | { type: 'question/resolved'; sessionId: string; questionRpcId: string; outcome: 'answered' | 'cancelled' }

/** One delivered mux frame with the server-request id needed to answer approvals and questions. */
export interface MuxDelivery {
  rpcId: string
  frame: MuxFrame
  /** Remote runtime this stream is bound to, when any. */
  remoteHost?: string
}

/** Lifecycle of one mux connection loop. */
export type MuxState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** Handlers and resume state for one mux. */
export interface MuxOptions {
  /** Bind the stream to a remote runtime. */
  remoteHost?: string | undefined
  /** Per-session resume cursors (last applied `seq`) to replay from on connect. */
  cursors?: Record<string, number> | undefined
  /** Receives each frame in order; a rejection is logged and does not stop the stream. */
  onFrame(delivery: MuxDelivery): void | Promise<void>
  /** Called after a session cursor advanced, so the bridge can persist it. */
  onCursor?(sessionId: string, seq: number): void
  /** Called when `host.describe` reports a different `bootId` than the previous connection saw. */
  onHostRestart?(previousBootId: string, bootId: string): void
  /** Called on every lifecycle transition. */
  onState?(state: MuxState): void
}

/** Minimal socket surface the mux drives; `ws` implements it. */
export interface MuxSocket {
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  close(code?: number): void
}
