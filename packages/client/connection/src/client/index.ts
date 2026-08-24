/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AuthenticationPrincipalIdentity } from '@deepseek-ai/dsh-authentication'
import { sameAuthenticationPrincipalIdentity, type HostDescription, type IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Host-verified principal identity shared by one matched unary/mux/host generation. */
export interface ConnectionAuthenticationSource {
  /** Current matched identity, absent before connect and while reconnecting. */
  getSnapshot(): AuthenticationPrincipalIdentity | undefined
  /** Subscribe to identity publication and synchronous retraction. */
  subscribe(listener: () => void): () => void
  /**
   * Validate identity metadata on a later unary settlement. A mismatch retracts
   * the generation synchronously and starts the normal reconnect path.
   * @param identity - identity attached by the Host unary carrier.
   * @returns whether it belongs to the current matched generation.
   */
  validate(identity: AuthenticationPrincipalIdentity | undefined): boolean
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Matched Host-verified identity of the active unary and stream transports. */
  readonly authentication: ConnectionAuthenticationSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  let authentication: AuthenticationPrincipalIdentity | undefined
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const authenticationListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const publishAuthentication = (next: AuthenticationPrincipalIdentity | undefined): void => {
    if (sameAuthenticationPrincipalIdentity(authentication, next)) return
    if (authentication === undefined && next === undefined) return
    authentication = next
    for (const listener of [...authenticationListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] authentication listener threw:', error)
      }
    }
  }
  let controller: ConnectionController | undefined
  const invalidateAuthentication = (): void => {
    publishAuthentication(undefined)
    publishDescription(undefined)
    controller?.invalidate()
  }
  const api: IApiClient = fixtureClient ?? new WebApiClient(
    undefined,
    () => authentication,
    invalidateAuthentication,
  )
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc()
  const handle: ConnectionHandle = {
    api,
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    authentication: {
      getSnapshot: () => authentication,
      subscribe: (listener) => {
        authenticationListeners.add(listener)
        return () => { authenticationListeners.delete(listener) }
      },
      validate: (identity) => {
        if (sameAuthenticationPrincipalIdentity(authentication, identity)) return true
        invalidateAuthentication()
        return false
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next, identity) => {
          publishAuthentication(identity)
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)
            || !sameAuthenticationPrincipalIdentity(authentication, identity)) return
          sinks.onConnected?.(next, identity)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') {
            publishAuthentication(undefined)
            publishDescription(undefined)
          }
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller?.stop()
          controller = undefined
          publishAuthentication(undefined)
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
