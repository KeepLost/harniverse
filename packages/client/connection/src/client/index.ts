/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AuthenticationPrincipalIdentity } from '@deepseek-ai/dsh-authentication'
import type {} from '@deepseek-ai/dsh-client-authentication'
import { sameAuthenticationPrincipalIdentity, type HostDescription, type IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc, resolveBase } from './rpc.ts'
import { createWebFileUploadTransport } from './upload.ts'
import type { FileUploadTransport } from './upload.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'
import { isHostManagement, TargetGeneration, type MachineTarget, type MachineTargetSource } from './target.ts'
export type { MachineTarget, MachineTargetSource } from './target.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  BrowserStreamFrame, HoldStreamFrame, TerminalStreamFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView, WorkspaceFileEntry, WorkspaceFileWatchFrame,
  WorkspaceGitApi, WorkspaceGitCommit, WorkspaceGitStatusEntry,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  ModelProfileDescriptor, ModelRouteDescriptor, ModelTarget,
  SessionWorkDelivery, SessionWorkStatus,
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

/** Host-verified page-authority identity. Local management keeps this identity during remote navigation. */
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

/** Shared bootstrap authentication is available before any protected carrier opens. */
export const inject = ['clientAuthentication']

/**
 * Optional carrier override consumed by test-support boots (remote-mock): when
 * the service `connectionCarrier` is provided, the connection plugin runs its
 * real handle/controller assembly over the supplied programmable carrier
 * instead of the fixture or Web transport. Production compositions never
 * provide it.
 */
export interface ConnectionCarrierOverride {
  /** Programmable unary + downlink carrier. */
  readonly api: IApiClient
  /** Optional logical-channel carrier; defaults to the web RPC transport. */
  readonly rpc?: ClientConnectionRpc
  /** Optional upload transport; defaults to the web upload transport. */
  readonly upload?: FileUploadTransport
}

/** Transport/authentication projection consumed by the read-only status seat. */
export type ConnectionHealthState = 'connecting' | 'connected' | 'reconnecting' | 'renewing' | 'recovering' | 'required' | 'bypass'

/** Stable primitive snapshots avoid a second mutable copy of authentication state. */
export interface ConnectionHealthSource {
  getSnapshot(): ConnectionHealthState
  subscribe(listener: () => void): () => void
}

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Stable API face for current-machine operations; local management stays on the page authority. */
  readonly api: IApiClient
  /** Current machine; the source and unchanged snapshots retain their identity. */
  readonly target: MachineTargetSource
  /**
   * Bind machine-owned entities to the current API generation.
   * @returns a captured API that rejects after a browser-machine switch.
   */
  captureApi(): IApiClient
  /**
   * Switch in this document. Retires operations and clears consumer state synchronously;
   * new streams start after consumer teardown. A repeated target shares the existing transition.
   * @param target - page host or configured remote machine.
   * @returns completion of consumer teardown and new-controller startup, without waiting for network readiness.
   */
  switchTarget(target: MachineTarget): Promise<void>
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Host-verified page identity used by local settings and credential consumers. */
  readonly authentication: ConnectionAuthenticationSource
  /** Combined admission and transport health, without credential material. */
  readonly health: ConnectionHealthSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Upload one file's raw bytes to the Host attachment route and resolve its
   * content-addressed receipt (fixture mode: an in-memory transport over the
   * same state graph). Progress and cancellation ride the hooks argument.
   */
  readonly upload: FileUploadTransport
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
  const browserAuthentication = ctx.clientAuthentication
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  let authentication: AuthenticationPrincipalIdentity | undefined
  let hostAuthentication: AuthenticationPrincipalIdentity | undefined
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  let generation = new TargetGeneration({ kind: 'host' })
  const hostGeneration = new TargetGeneration({ kind: 'host' })
  const targetListeners = new Set<() => void>()
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const authenticationListeners = new Set<() => void>()
  const healthListeners = new Set<() => void>()
  let transportState: ConnectionState | 'connecting' = 'connecting'
  const health: ConnectionHealthSource = {
    getSnapshot: () => {
      const snapshot = browserAuthentication.getSnapshot()
      if (snapshot.phase === 'required' || snapshot.phase === 'stopped') return 'required'
      if (snapshot.phase === 'recovering') return 'recovering'
      if (transportState !== 'connected') return transportState
      if (authentication === undefined) return 'connecting'
      if (snapshot.phase === 'renewing') return 'renewing'
      return snapshot.mode === 'bypass' ? 'bypass' : 'connected'
    },
    subscribe: (listener) => { healthListeners.add(listener); return () => { healthListeners.delete(listener) } },
  }
  const publishHealth = (): void => {
    for (const listener of [...healthListeners]) {
      try { listener() } catch (error) { console.error('[client-connection] health observer failed:', error) }
    }
  }
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
  const publishHostAuthentication = (next: AuthenticationPrincipalIdentity | undefined): void => {
    if (sameAuthenticationPrincipalIdentity(hostAuthentication, next)
      || (hostAuthentication === undefined && next === undefined)) return
    hostAuthentication = next
    for (const listener of [...authenticationListeners]) {
      try { listener() } catch (error) { console.error('[web-runtime] authentication listener threw:', error) }
    }
  }
  const publishAuthentication = (next: AuthenticationPrincipalIdentity | undefined): void => {
    /* v8 ignore next -- idempotence guard with no reachable caller: the loop
     * always retracts through onStateChange('reconnecting') before it can
     * publish a matched identity again, so no republish repeats an identity. */
    if (sameAuthenticationPrincipalIdentity(authentication, next)) return
    if (authentication === undefined && next === undefined) return
    authentication = next
    publishHealth()
    if (generation.target.kind === 'host') publishHostAuthentication(next)
  }
  let controller: ConnectionController | undefined
  const invalidateAuthentication = (): void => {
    publishAuthentication(undefined)
    publishDescription(undefined)
    controller?.invalidate()
  }
  const carrier = ctx.get('connectionCarrier') as ConnectionCarrierOverride | undefined
  const createApi = (owner: TargetGeneration): WebApiClient => new WebApiClient(
    undefined, () => owner.controller.signal.aborted ? undefined : authentication,
    () => { if (owner === generation) invalidateAuthentication() }, browserAuthentication,
    owner.resolvePath, () => owner,
  )
  const hostApi = new WebApiClient(
    undefined, () => hostAuthentication,
    () => { publishHostAuthentication(undefined); invalidateAuthentication() }, browserAuthentication,
    hostGeneration.resolvePath, () => hostGeneration,
  )
  let targetApi = createApi(generation)
  const api: IApiClient = carrier?.api ?? fixtureClient ?? new WebApiClient(
    undefined, undefined, undefined, undefined, undefined, undefined,
    method => method !== undefined && isHostManagement(method) ? hostApi : targetApi,
  )
  const rpc: ClientConnectionRpc = {
    call(channel, endpoint, payload, signal) {
      const owner = channel === '/api' && isHostManagement(endpoint) ? hostGeneration : generation
      const call = carrier?.rpc ?? fixtureClient?.rpc ?? createWebConnectionRpc(
        (input, init) => browserAuthentication.fetch(input, init), owner.resolvePath,
      )
      return owner.run(() => call.call(channel, endpoint, payload, owner.signal(signal)))
    },
  }
  const upload: FileUploadTransport = (request, hooks) => {
    const owner = generation
    const send = carrier?.upload ?? fixtureClient?.upload
      ?? createWebFileUploadTransport(resolveBase, browserAuthentication, owner.resolvePath)
    return owner.run(() => send(request, {
      ...hooks, signal: owner.signal(hooks?.signal),
      onProgress: (progress) => { if (!owner.controller.signal.aborted) hooks?.onProgress?.(progress) },
    }))
  }
  let consumer: { sinks: ConnectionSinks; config?: ConnectionConfig } | undefined
  let switching = Promise.resolve()
  let disposed = false
  ctx.effect(() => browserAuthentication.subscribe(() => {
    if (health.getSnapshot() === 'required') {
      publishHostAuthentication(undefined)
      controller?.stop()
      publishAuthentication(undefined)
      publishDescription(undefined)
    }
    publishHealth()
  }), 'client-connection: authentication lifecycle')
  const handle: ConnectionHandle = {
    api,
    captureApi: () => carrier?.api ?? fixtureClient ?? targetApi,
    target: {
      getSnapshot: () => generation.target,
      subscribe: (listener) => { targetListeners.add(listener); return () => { targetListeners.delete(listener) } },
    },
    switchTarget(target) {
      if (disposed) throw new Error('connection: disposed')
      if (target.kind === generation.target.kind
        && (target.kind === 'host' || (generation.target.kind === 'remote' && target.id === generation.target.id))) return switching
      if (target.kind === 'remote' && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(target.id)) {
        throw new TypeError('connection: invalid remote host id')
      }
      controller?.stop()
      generation.retire()
      generation = new TargetGeneration(target.kind === 'host' ? { kind: 'host' } : { kind: 'remote', id: target.id })
      if (target.kind === 'host') publishHostAuthentication(undefined)
      targetApi = createApi(generation)
      if (api instanceof WebApiClient) api.observeTarget()
      const owner = generation
      transportState = 'connecting'
      publishAuthentication(undefined)
      publishDescription(undefined)
      const reset = Promise.withResolvers<undefined>()
      switching = Promise.allSettled([switching, reset.promise]).then(([, result]) => {
        if (result.status === 'rejected') {
          const error: unknown = result.reason
          throw error instanceof Error ? error : new Error(String(error))
        }
        if (!disposed && consumer !== undefined && owner === generation) startController(consumer.sinks, consumer.config)
      })
      try {
        void Promise.resolve(consumer?.sinks.onTargetChange?.()).then(() => { reset.resolve(undefined) }, reset.reject)
      } catch (error) { reset.reject(error) }
      for (const listener of [...targetListeners]) {
        try { listener() } catch (error) { console.error('[client-connection] target observer failed:', error) }
      }
      publishHealth()
      return switching
    },
    health,
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    upload,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    authentication: {
      getSnapshot: () => hostAuthentication,
      subscribe: (listener) => {
        authenticationListeners.add(listener)
        return () => { authenticationListeners.delete(listener) }
      },
      validate: (identity) => {
        if (sameAuthenticationPrincipalIdentity(hostAuthentication, identity)) return true
        publishHostAuthentication(undefined)
        invalidateAuthentication()
        return false
      },
    },
    rpc,
    start(sinks, config) {
      if (disposed) throw new Error('connection: disposed')
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      consumer = { sinks, ...(config === undefined ? {} : { config }) }
      startController(sinks, config)
      return {
        stop: () => {
          consumer = undefined
          controller?.stop()
          controller = undefined
          transportState = 'connecting'
          publishAuthentication(undefined)
          publishDescription(undefined)
        },
      }
    },
  }
  function startController(sinks: ConnectionSinks, config?: ConnectionConfig): void {
    const owner = generation
    const active = (): boolean => owner === generation && authentication !== undefined
    controller = new ConnectionController(handle.captureApi(), {
      ...sinks,
      onConnected: (next, identity) => {
        publishAuthentication(identity)
        if (!active()) return
        // Remote proxies authenticate the browser on the page authority too.
        publishHostAuthentication(identity)
        if (!active()) return
        publishDescription(next)
        // A description subscriber can synchronously stop or retarget the loop.
        if (!active() || !Object.is(description, next)
          || !sameAuthenticationPrincipalIdentity(authentication, identity)) return
        sinks.onConnected?.(next, identity)
      },
      onStateChange: (state) => {
        transportState = state
        publishHealth()
        if (state === 'reconnecting') {
          publishAuthentication(undefined)
          publishDescription(undefined)
        }
        sinks.onStateChange?.(state)
      },
    }, config ?? {})
    controller.start()
  }
  ctx.effect(() => () => {
    disposed = true
    consumer = undefined
    controller?.stop()
    generation.retire()
    hostGeneration.retire()
  }, 'connection: target lifecycle')
  ctx.provide('connection', handle)
}
