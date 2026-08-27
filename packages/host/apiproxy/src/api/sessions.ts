/**
 * sessions domain contract. Method signatures are the source of truth:
 * unary methods take the RpcRequest<P> narrow form and the impl echoes rpcId; everything
 * else references RequestPayload<'session.*'> / ResponseValue<'session.*'>.
 */

import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { AttachmentIdType, ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session/types'
// The pure-type outlet: api/ is browser-importable, and the package root's
// cordis Context merge (via dsh-agent) must not enter client aggregates.
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { RpcId, RpcRequest, RpcResponse } from './rpc.ts'
import type { HostBootId } from './host.ts'
import type { JobView } from './jobs.ts'
import type { QueuedInboxItem, ToolEventView } from './events.ts'
import type { WorkspaceId } from './workspace.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Session-list hints persisted by the projection cache. `blank: false`
     * is monotonic and may suppress a cold-log probe; `blank: true` is only a
     * checkpoint-prefix fact and must not hide a cold Session without direct
     * verification. `lastPromptAt` is the latest human-authored prompt time.
     */
    sessionListMetadata: SessionListMetadata
    /**
     * The deployment's image-intake limits: the attachments service's config
     * as this proxy enforces it at prompt admission, constant per host boot.
     * Clients pre-check count and bytes at intake and show the limits in
     * upload affordances. Key absence means no attachment service is
     * composed — clients skip the pre-check and let the host answer.
     */
    imageLimits: ImageAttachmentLimits
  }
}

/** Persisted hints used to summarize a cold Session without reading a large log. */
export interface SessionListMetadata {
  /** Whether the checkpoint prefix contains no turn/start event. */
  blank: boolean
  /** Latest source.kind=user message time in the checkpoint prefix. */
  lastPromptAt: number | null
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The prompt's rpcId is passed through MessageSource into the `user/message` event
     * (the client uses it to reconcile the optimistically
     * echoed provisional message with the event stream). kind stays `'user'` — the model face
     * carries no transport vocabulary; rpcId and the optional Host-validated browser zone are
     * durable JSON fields passed back to the client with the event.
     */
    'user-rpc': { kind: 'user'; rpcId: RpcId; clientTimeZone?: string }
  }
}

/**
 * One history page entry: the raw event plus the optional host-computed render
 * intent (same semantics as the mux frame's `view` slot — a pagination-time
 * derivation, never persisted).
 */
export interface HistoryEntry {
  event: SessionEvent
  view?: ToolEventView
}

/** Durable lifecycle of one admitted prompt message. */
export type SessionWorkStatus =
  | { state: 'unknown' }
  | { state: 'queued' }
  | { state: 'claimed'; turn: number }
  | { state: 'settled'; turn: number; reason: TurnEndReason }
  | { state: 'discarded' }

/** Immediate receipt carrying the exact durable inbox identity. */
export interface PromptReceipt {
  accepted: true
  messageId: MessageId
  /** Operation that can be queried after this admission response. */
  operationId: string
}

/** Backward message pages for display, or forward event pages for synchronization. */
export type SessionHistoryRequest =
  | {
    sessionId: SessionId
    projectionMode?: 'omit'
    beforeSeq?: number
    maxMessages?: number
    afterSeq?: never
    maxEvents?: never
  }
  | {
    sessionId: SessionId
    projectionMode: 'only'
    beforeSeq?: never
    maxMessages?: never
    afterSeq?: never
    maxEvents?: never
  }
  | {
    sessionId: SessionId
    projectionMode?: never
    afterSeq: number
    maxEvents: number
    beforeSeq?: never
    maxMessages?: never
  }

/** One answerable process-local interaction, preserving the rpcId required by `respond`. */
export type SessionPendingInteraction = RpcRequest<
  | { type: 'question/requested'; sessionId: SessionId; questions: AskUserQuestionItem[] }
  | {
    type: 'approval/requested'
    sessionId: SessionId
    approvalId: ApprovalRequestId
    toolName: string
    callId?: CallId
    reason?: string
  }
>

/** One boot-fenced point-in-time view of a Session's durable cursor and live control state. */
export interface SessionStatusSnapshot {
  sessionId: SessionId
  bootId: HostBootId
  /** Whether the Session is currently present in the live Session registry. */
  attached: boolean
  /** Current Agent activity; false when no exact Agent owns the attached Session. */
  running: boolean
  /** Whether an explicit `session.close` currently owns admission for this identity. */
  closing: boolean
  /** Last durable event seq in the sampled Session prefix, or -1 for an empty log. */
  lastSeq: number
  /** Complete process-local inbox projection; empty for a cold Session. */
  queue: QueuedInboxItem[]
  /** Complete visible background-job set; empty for a cold Session or absent jobs service. */
  jobs: JobView[]
  /** Complete answerable question/approval set for this Session in this Host boot. */
  interactions: SessionPendingInteraction[]
}

/**
 * The projection baseline riding the history tail page: one synchronous cut
 * over every registered projection unit, read from the registry's watermark
 * cache. `asOfSeq` is the seq of the last committed event every value
 * reflects — the window tail event seq (`-1` for an empty log, mirroring
 * `session/subscribed.lastSeq`), directly comparable with
 * `session/projection` frame seqs under the client's higher-seq-wins rule. A
 * key absent from `values` means the capability is absent (its domain plugin
 * is unmounted).
 */
export interface SessionProjectionsBlock {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: number
  /** Whole current value per registered projection key. */
  values: Partial<SessionProjectionMap>
}

/** Browser-submitted prompt content; the host promotes image bytes to durable references. */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }

/** Complete model selection for one session. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort; absence preserves adapter/provider default behavior. */
  reasoningEffort?: string
}

/** One adapter-owned reasoning effort displayed for an exact model route. */
export interface ModelReasoningEffort {
  /** Opaque value submitted back to the owning adapter. */
  id: string
  /** Adapter-supplied display name. */
  name: string
  /** Optional adapter-supplied description. */
  description?: string
}

/** Selectable reasoning metadata for one exact model route. */
export interface ModelReasoning {
  /** Efforts in adapter-preferred display order. */
  efforts: ModelReasoningEffort[]
  /** Adapter-configured default; absence preserves the provider default. */
  defaultEffort?: string
}

/** One model displayed inside its provider group. */
export interface ModelCatalogModel {
  /** Provider-owned model id. */
  id: string
  /** Provider-supplied display name. */
  name: string
  /** Optional provider-supplied description. */
  description?: string
  /** Exact-route reasoning metadata when the adapter exposes it. */
  reasoning?: ModelReasoning
}

/** One provider and the models it advertised successfully. */
export interface ModelProviderGroup {
  /** Provider route id used for requests. */
  id: string
  /** Provider display name. */
  name: string
  /** Models in provider-preferred order. */
  models: ModelCatalogModel[]
}

/** A provider whose asynchronous catalog lookup failed. */
export interface ModelCatalogFailure {
  /** Provider route id. */
  id: string
  /** Provider display name. */
  name: string
  /** Lookup failure diagnostic. */
  message: string
}

/** Detached model-directory snapshot for one session. */
export interface SessionModels {
  /** Model selection for the session's next assembled step. */
  current: ModelSelection
  /**
   * Whether an adapter currently serves `current.provider`, and therefore
   * whether this session can start a turn at all. Deliberately NOT derivable
   * from `groups`: catalog membership is advisory, so a route serving a model
   * it stopped advertising is absent from the groups yet perfectly usable,
   * while a route whose adapter is gone can serve nothing. A surface that
   * blocks input must read this rather than the groups.
   */
  routable: boolean
  /** Successfully loaded provider groups. */
  groups: ModelProviderGroup[]
  /** Provider-local failures; successful groups remain usable. */
  failures: ModelCatalogFailure[]
}

/** A client-requested mutation of one still-pending queue item. */
export type QueueAction =
  | { kind: 'edit'; content: ContentBlock[] }
  | { kind: 'remove' }
  | { kind: 'steer' }

/** One Session list entry. */
export interface SessionSummary {
  sessionId: SessionId
  /**
   * The later of creation and the latest human-authored prompt. Attached
   * Sessions fold their live log; cold Sessions use a projection-cache hint or
   * an exact small-artifact read, falling back to creation time.
   */
  updatedAt: number
  /** Status of the attached agent; always false for cold (unattached) sessions. */
  running: boolean
  /**
   * Derived conversation-not-started bit: true while no turn has run.
   * Standalone plugin events — command lifecycle
   * records, plan/mode, titles, goals — do not open a turn and therefore do
   * not clear it. Clients hide blank Sessions from lists and reuse them for
   * New Session on the same workspace. A cold Session is true only when a
   * small-artifact read verifies that no `turn/start` exists; unavailable
   * or oversized artifacts conservatively report false.
   */
  blank: boolean
  /** fork/spawn lineage (session.header.parentSession passthrough); absent for root sessions. */
  parentSessionId?: SessionId
  /** Coarse durable origin used by navigation surfaces; never proves resumability. */
  origin?: 'subagent'
  /** Session working directory (header.cwd passthrough); absent when unrecorded. */
  cwd?: string
  /**
   * Agent profile this session's agent was composed from (header passthrough);
   * absent when the deployment composes no profiles.
   */
  agentProfile?: string
  /**
   * Projection baseline for this row, with zero log loads: attached sessions
   * read the registry's live watermark cut; cold sessions read the persisted
   * projection cache's stored rows — as stale as that session's last durable
   * checkpoint (`asOfSeq` says exactly how stale), never wrong, and directly
   * seedable into the client's per-session value store under its
   * higher-seq-wins rule (a list baseline can never overwrite a newer push
   * frame). Absent when no value is available (no registry, no cache row for
   * a cold session, or a fail-soft cache read miss); a listing client treats
   * absence as "no title yet", exactly like a blank session.
   */
  projections?: SessionProjectionsBlock
}

/** One session-content search result; display metadata stays owned by `session.list`. */
export interface SessionSearchItem {
  sessionId: SessionId
  /** Plain-text excerpt around the strongest matching visible message. */
  snippet: string
}

/** Session-domain unary methods (the map keys session.* of RpcMethodMap). */
export interface SessionsApi {
  /** Lists persisted sessions (updatedAt descending). v1 returns everything; cursor is a reserved seat, unimplemented. */
  list(request: RpcRequest<{ cursor?: string }>): Promise<RpcResponse<{ items: SessionSummary[] }>>

  /**
   * Searches the current user/assistant/steering message surface across
   * sessions visible to `list`. Results contain at most 20 sessions and carry
   * no continuation cursor; `hasMore` asks the client to refine the query.
   */
  search(
    request: RpcRequest<{ query: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ items: SessionSearchItem[]; hasMore: boolean }>>

  /**
   * Creates a real session and its idle agent. At most one of `workspaceId` /
   * `cwd` is accepted; an omitted project uses the Host cwd. A caller may
   * preallocate `sessionId`: retries with the same id and cwd return the same
   * session, while a different cwd fails with `session-conflict`. Workspace
   * creation attaches the session after publication; an attach failure
   * returns `workspace-attach-failed` with the published session id.
   *
   * `agentProfile` names the server-defined profile the new session's agent is built
   * from; omitted, the effective default applies — the user's stored choice
   * where one exists, else the deployment's own. The resolved id is stored on
   * the session header, so a later resume rebuilds the same agent. An unknown
   * id fails with `agent-preset-not-found`, and a preset whose composition
   * cannot be mounted fails with `agent-preset-invalid`.
   */
  create(request: RpcRequest<{ workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId; agentProfile?: string }>):
  Promise<RpcResponse<{ sessionId: SessionId; agentProfile?: string }>>

  /**
   * Reads a window of history events; page boundaries align to append-origin message
   * boundaries: one page = all raw events owned by a whole number of such messages (including
   * their chunk / tool events), never cut mid-message. Model-only replacement copies consume no
   * `maxMessages`, so a compaction's `compaction/summary` record stays on the page of its replacement. The tail
   * page (beforeSeq absent) additionally carries the in-flight
   * partial — chunk events already emitted for the last unfinalized message.
   * Each entry pairs the raw SessionEvent with the host-computed view (tool events whose
   * presenter produced one, evaluated against the registry at pagination time); the client
   * rebuilds the surface from the events with the shared fold.
   * The default tail page additionally carries `projections` when the
   * deployment mounts the session-projection registry. `projectionMode:
   * 'omit'` serves events without waiting for that baseline; a later
   * `projectionMode: 'only'` request returns no events and one authoritative
   * baseline. loadOlder and forward gap repair never carry projections.
   * A deployment without the registry serves histories without the block.
   * Reading history uses an attached Session or persistence inspection and
   * never resumes or publishes an Agent. The mutually exclusive forward mode
   * returns at most `maxEvents` raw events whose seq is greater than
   * `afterSeq`; it carries no projection baseline and is intended for gap
   * repair rather than display pagination. The carrier signal cancels cold
   * metadata, page, projection-cache, and inspection work.
   */
  history(request: RpcRequest<SessionHistoryRequest>, signal?: AbortSignal):
  Promise<RpcResponse<{ events: HistoryEntry[]; hasMore: boolean; projections?: SessionProjectionsBlock }>>

  /** Reads one boot-fenced durable/live control snapshot without resuming a cold Session. */
  status(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<SessionStatusSnapshot>>

  /**
   * Derives one admitted message's durable lifecycle without resuming a cold
   * session. `settled` identifies the turn boundary that consumed the work; it
   * does not attribute that turn's assistant output to this message.
   */
  workStatus(request: RpcRequest<{ sessionId: SessionId; messageId: MessageId }>):
  Promise<RpcResponse<{ messageId: MessageId; status: SessionWorkStatus }>>

  /**
   * Reads a fresh advisory model directory for an ordinary session. Provider
   * lookups run independently; subagents reject with `agent-busy`.
   */
  models(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<SessionModels>>

  /**
   * Selects the complete model selection for this session. Exact model metadata
   * validates an optional reasoning effort, while catalog membership remains
   * advisory. Session-backed subagents reject with `agent-busy`.
   */
  selectModel(request: RpcRequest<{
    sessionId: SessionId
    provider: string
    model: string
    reasoningEffort?: string
  }>):
  Promise<RpcResponse<{ selected: ModelSelection }>>

  /**
   * Renames a session: appends a `session/title` event with the `user`
   * source, which pins the title against automatic regeneration. The
   * normalized accepted title and the title event's seq return so the caller
   * can settle its projection cell without waiting for the push frame. A
   * title that normalizes to empty fails with `title-invalid`.
   * Session-backed subagents reject with `agent-busy`.
   */
  rename(request: RpcRequest<{ sessionId: SessionId; title: string }>):
  Promise<RpcResponse<{ title: string; seq: number }>>

  /**
   * Forks a new session from a completed-turn prefix of the source. `atSeq`
   * anchors the cut: the boundary is the first `turn/end` at or after it
   * (a message's fork button passes the message seq, so the fork includes
   * that whole turn); a boundary past the log end, or an omitted `atSeq`,
   * falls back to the source's last completed turn. An in-log anchor whose
   * turn is still open fails with `fork-unavailable` instead of clipping to
   * an earlier turn. The child inherits the source cwd, latest logged model
   * target and `parentSessionId` lineage; the seed prefix carries the source
   * title. Reading the source uses attached state or persistence inspection
   * without acquiring an Agent. Workspace attachment follows the source
   * directly, or the nearest workspace-owning ancestor when the source is a
   * subagent.
   */
  fork(request: RpcRequest<{ sessionId: SessionId; atSeq?: number }>):
  Promise<RpcResponse<{ sessionId: SessionId }>>

  /**
   * Sends text and temporary image bytes to an ordinary session Agent after durable host admission.
   * Browser callers attach their current IANA zone;
   * the Host validates, canonicalizes, and records it on that exact user message. Omission remains
   * valid for non-browser callers. Session-backed subagents reject with `agent-busy` and use
   * `subagent.prompt`. The response identifies the exact admitted inbox message;
   * slash commands use the separate command API and never enter this method.
   */
  prompt(request: RpcRequest<{
    sessionId: SessionId
    mode: 'queue' | 'steer'
    content: PromptContentPart[]
    clientTimeZone?: string
  }>):
  Promise<RpcResponse<PromptReceipt>>

  /** Reads one durable image after proving that this session's log references its id. */
  attachment(request: RpcRequest<{ sessionId: SessionId; attachmentId: AttachmentIdType }>):
  Promise<RpcResponse<{ attachment: ImageAttachmentRef; data: string }>>

  /**
   * Edits, removes, or strictly steers one pending queued occurrence on an ordinary session.
   * Session-backed subagents reject with `agent-busy`.
   */
  updateQueue(request: RpcRequest<{ sessionId: SessionId; itemId: MessageId; action: QueueAction }>):
  Promise<RpcResponse<{ accepted: true }>>

  /**
   * Stops an ordinary session's active turn, preserving pending inbox work
   * that resumes in FIFO order after cancellation settles. Session-backed
   * subagents reject with `agent-busy`.
   */
  cancel(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ accepted: true }>>

  /**
   * Stops admission, drains continuable descendants, cancels the ordinary
   * Agent, flushes its Session, and detaches both live objects. Durable history
   * remains available for a later resume. Session-backed subagents reject.
   */
  close(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ closed: true }>>

  /**
   * Permanently deletes one cold leaf Session. The operation journals recovery,
   * fences projection write-back, commits the authoritative log deletion, then
   * removes workspace/archive references and clears the journal. Shared
   * content-addressed attachments are retained for global garbage collection.
   * A live Session must be closed first, and a Session with descendants is refused.
   */
  delete(request: RpcRequest<{ sessionId: SessionId }>):
  Promise<RpcResponse<{ deleted: true; attachmentsRetained: true }>>

}
