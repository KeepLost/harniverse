/**
 * apiproxy contract-layer barrel. api/ has zero Node dependencies and is
 * importable from the browser; the TS interfaces are the authoritative contract, while HTTP,
 * WebSocket, and in-process SSE are merely physical channels (four-quadrant message model).
 */

import type { SessionsApi } from './sessions.ts'
import type { HostApi } from './host.ts'
import type { WorkspaceApi } from './workspace.ts'
import type { AgentPresetsApi } from './agent-presets.ts'
import type { SkillsApi } from './skills.ts'
import type { SubagentsApi } from './subagents.ts'
import type { EventsApi } from './events.ts'
import type { GoalsApi } from './goals.ts'
import type { SettingsApi } from './settings.ts'
import type { CredentialsApi } from './credentials.ts'
import type { LlmApi } from './llm.ts'
import type { DownloadsApi } from './downloads.ts'
import type { ClientResponse, RpcReceipt } from './rpc.ts'
import type { ApiApi } from './contract.ts'
import type { OperationsApi } from './operations.ts'
import type { WorkspaceFilesApi } from './workspace-files.ts'
import type { WorkspaceGitApi } from './workspace-git.ts'

/** Root interface of the unified API. New client-request domain = one new file pair + one field here + one map row. */
export interface ApiProxy {
  /** Contract discovery is optional on legacy hand-built test implementations. */
  api?: ApiApi
  operations?: OperationsApi
  sessions: SessionsApi
  subagents: SubagentsApi
  host: HostApi
  workspace: WorkspaceApi
  /** Optional only for legacy hand-built implementations; the Host service always provides it. */
  workspaceFiles?: WorkspaceFilesApi
  /** Optional only for legacy hand-built implementations; the Host service always provides it. */
  workspaceGit?: WorkspaceGitApi
  skills: SkillsApi
  agentPresets: AgentPresetsApi
  events: EventsApi
  goals: GoalsApi
  settings: SettingsApi
  credentials: CredentialsApi
  llm: LlmApi
  /** Host-only download surfaces (GET, no wire envelope); absent from IApiClient. */
  downloads: DownloadsApi
  /**
   * Response entry for server requests; not a domain method.
   * @param message - Client response carrying the server request's rpcId.
   * @returns Transport receipt for the response delivery.
   */
  respond(message: ClientResponse): Promise<RpcReceipt>
}

// ---- Domain interfaces and payload entities ----
export type {
  HistoryEntry, ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelSelection, ModelProfileDescriptor, ModelRouteDescriptor, ModelTarget,
  PromptContentPart, PromptReceipt, QueueAction, SessionModels,
  SessionListMetadata, SessionProjectionsBlock, SessionSearchItem, SessionsApi, SessionSummary,
  SessionHistoryRequest, SessionPendingInteraction, SessionStatusSnapshot, SessionWorkDelivery, SessionWorkStatus,
} from './sessions.ts'
export { HostBootId } from './host.ts'
export type { DirectoryEntry, DirectoryListing, HostApi } from './host.ts'
export type {
  SubagentAddress, SubagentCatalog, SubagentInterruptReceipt, SubagentListEntry,
  SubagentPromptReceipt, SubagentsApi,
} from './subagents.ts'
export type { JobView } from './jobs.ts'
export type { WorkspaceApi, WorkspaceId, WorkspaceView } from './workspace.ts'
export type { WorkspaceFileEntry, WorkspaceFilesApi } from './workspace-files.ts'
export type { WorkspaceGitApi, WorkspaceGitCommit, WorkspaceGitStatusEntry } from './workspace-git.ts'
export type { SkillsApi, SkillEntry } from './skills.ts'
export type { AgentPresetsApi, AgentPresetEntry } from './agent-presets.ts'
export type { EventsApi, MuxFrame, HostFrame, QueuedInboxItem, ToolCallView, ToolEventView, ToolResultView } from './events.ts'
export type { GoalsApi, GoalId, GoalRef } from './goals.ts'
export type { SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView } from './settings.ts'
export type { CredentialsApi, CredentialView } from './credentials.ts'
export type { ConfigurableProviderView, DiscoveredModelView, LlmApi } from './llm.ts'
export type { DownloadsApi } from './downloads.ts'
export type { ApiApi, ApiContractDescription, ApiMethodDescription, RpcMethodStability } from './contract.ts'
export type { OperationStatus, OperationView, OperationsApi } from './operations.ts'
export type { ApprovalResponsePayload } from './approvals.ts'

export type { QuestionResponsePayload } from './questions.ts'

// ---- Message layer: narrow forms (domain-signature view) ----
export type { RpcRequest, RpcResponse } from './rpc.ts'

// ---- Message layer: the four wire full forms + carrier receipt ----
export type {
  ClientRequest,
  ClientResponse,
  RpcMessage,
  RpcReceipt,
  ServerRequest,
  ServerResponse,
} from './rpc.ts'

// ---- Errors and ids ----
export { CONNECTION_AUTHENTICATED_METHOD, RequestId, RpcId, sameAuthenticationPrincipalIdentity, transportError } from './rpc.ts'
export type { RpcError, RpcErrorCode, RpcErrorDetailsMap, RpcResult } from './rpc.ts'
// ---- Fixed session-search product bounds ----
export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './session-search.ts'

// ---- Method registry and derived generics ----
export { legacyRpcCapability, RPC_METHOD_CAPABILITIES, RPC_METHOD_EFFECTS, RPC_METHOD_METADATA } from './rpc-map.ts'
export type { RequestPayload, ResponseValue, RpcMethodMap } from './rpc-map.ts'
