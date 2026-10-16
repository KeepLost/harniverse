/**
 * Connection supervisor: owns the MCP client/transport generations for one
 * plugin instance, keeps the harness tool registry in sync with the live
 * generation, and — when the connection drops — restarts the configured
 * server with bounded exponential backoff.
 *
 * One outage shares one attempt budget (`maxAttempts` consecutive failed
 * attempts, delays doubling from `initialDelayMs` up to `maxDelayMs`). A
 * connection that stays up past the stability window closes the outage, so
 * the next disconnect starts a fresh budget while a crash-looping server —
 * even one whose connects briefly succeed — still exhausts the cap instead of
 * restarting forever. Exhaustion unregisters the server's tools and stops;
 * disposal (including HMR) is the only way back from that state.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js'
import { ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { boundedResourceResult, MAX_RESOURCE_RESULT_BYTES } from '@deepseek-ai/dsh-mcp-resources'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createTransport } from './transport.ts'
import { cursorGuard, listToolDescriptors, publicToolName, RawCallToolResultSchema, syncTools } from './tools.ts'
import type { McpToolDescriptor, ToolBridgeOptions, ToolDisposers } from './tools.ts'
import type { ServerContext } from './server-context.ts'
import type { Config } from './index.ts'

/** Automatic reconnect policy for one MCP server connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good (default 10). */
  maxAttempts?: number
}

/** Defaults shared by the Config schema and {@link resolveReconnectPolicy}. */
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/** Default UTF-8 byte limit for attributed server instructions. */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768

/** Maximum total resources and templates retained for one connection. */
export const MAX_RESOURCE_ITEMS = 1_024

// The SDK's stdio transport owns two two-second termination grace periods.
// Keep one additional second for the process-close event that proves the old
// generation is gone; timing out fails closed instead of overlapping children.
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/** Fully resolved reconnect policy captured at plugin load. */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/**
 * The one explicit resolve step from raw reconnect config to the policy the
 * supervisor runs. Programmatic construction may bypass Schemastery
 * normalization, so every default and bound is re-judged here — misconfiguration
 * fails the plugin instance at load.
 *
 * @param config - Raw `reconnect` config; omission uses the defaults.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved policy.
 */
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  /* jscpd:ignore-start — domain-specific delay validation parallels llm retry-policy; not extractable */
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`)
  }
  /* jscpd:ignore-end */
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/** Result from the initial connection attempt, for startup-await semantics. */
export interface ConnectionOutcome {
  /** If the initial connection or tool sync failed, the error; otherwise absent. */
  error?: unknown
}

/** Handle for one plugin instance's supervised connection. */
export interface ConnectionHandle extends ServerContext {
  /**
   * Settles when the first connection attempt completes (success or failure).
   * The supervisor enters its reconnect loop regardless; the caller decides
   * whether a failed startup is fatal via `failOnStartupError`.
   */
  ready: Promise<ConnectionOutcome>
  /** Public tool names in the current last-good generation. */
  toolNames(): string[]
  /** Whether a live MCP generation completed its initial synchronization. */
  connected(): boolean
  /** Sorted resource URIs from the last successful inventory. */
  resourceUris(): string[]
  /** Sorted URI templates from the same last successful inventory. */
  resourceTemplates(): string[]
  /**
   * Stop reconnection, close the live client, wait for the in-flight attempt
   * and queued tool syncs to quiesce, then unregister every tool this server
   * still owns.
   */
  dispose(): Promise<void>
}

/** Connection lifecycle state reported by a shared connection. */
export type McpConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'exhausted'
  | 'stopped'
  | 'disposed'

/** Observable status snapshot of one shared connection. */
export interface McpConnectionStatus {
  /** Derived lifecycle state of the supervised connection. */
  state: McpConnectionState
  /** Epoch ms of the current generation's initial sync; absent while down. */
  connectedAtMs?: number
  /** Consecutive failed attempts within the current outage. */
  failedAttempts: number
  /** The outage budget this supervisor allows. */
  maxAttempts: number
  /** Error name of the most recent failed attempt; absent while none occurred. */
  lastErrorKind?: string
}

/**
 * Connection-only handle: the transport, reconnect supervisor, and tool
 * inventory of one MCP server WITHOUT any tool registration. A host-scope
 * owner publishes this; scoped registrars project the inventory into their
 * own tool registries, so one live connection serves every composition.
 */
export interface SharedConnection extends ServerContext {
  /** Public server namespace this connection serves. */
  readonly serverName: string
  /**
   * Settles when the first connection attempt completes (success or failure).
   * A shared owner never treats a failed startup as fatal; status carries it.
   */
  ready: Promise<ConnectionOutcome>
  /** Whether a live MCP generation completed its initial synchronization. */
  connected(): boolean
  /** Derived lifecycle status for management surfaces. */
  status(): McpConnectionStatus
  /** Full tool advertisements of the current last-good generation. */
  toolDescriptors(): readonly McpToolDescriptor[]
  /** Public tool names in the current last-good generation. */
  toolNames(): string[]
  /** Sorted resource URIs from the last successful inventory. */
  resourceUris(): string[]
  /** Sorted URI templates from the same last successful inventory. */
  resourceTemplates(): string[]
  /** One raw `tools/call` routed through the current generation. */
  callTool(rawName: string, args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<unknown>
  /** Observe inventory/connection changes; the disposer removes the listener. */
  subscribe(listener: () => void): () => void
  /**
   * Stop reconnection, close the live client, and quiesce; the inventory
   * empties and every subscriber hears the final change.
   */
  dispose(): Promise<void>
}

/** Which side of the shared-connection split a supervisor serves. */
type SuperviseMode = 'register' | 'shared'

/** Shared no-op change observer used as the wrappers' default. */
const NOOP_NOTIFY: () => void = () => {}

/**
 * Start the supervised connection for one MCP server and keep it alive per
 * the reconnect policy.
 *
 * @param ctx - Cordis context providing the `tools` registry and logger.
 * @param config - Resolved plugin config selecting the transport and server identity.
 * @param policy - Resolved reconnect policy from {@link resolveReconnectPolicy}.
 * @param onToolsChanged - observer notified when connection or tool topology changes.
 * @param mode - `register` syncs tools onto this context's registry (the
 * standalone plugin); `shared` only publishes the descriptor inventory (a
 * host-scope owner; scoped registrars project it).
 * @returns Handle with a `ready` promise for startup-await and a `dispose` for teardown.
 */
function supervise(
  ctx: Context,
  config: Config,
  policy: ResolvedReconnectPolicy,
  onToolsChanged: () => void,
  mode: SuperviseMode,
): ConnectionHandle & SharedConnection {
  const label = `mcp-client(${config.serverName})`
  const opts: ToolBridgeOptions = {
    registrationFailure: 'contain',
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  }
  // The initial sync uses 'throw' when failOnStartupError is configured, so
  // a registration conflict propagates to the startup-await path. Re-syncs
  // and reconnect syncs always contain conflicts. Shared mode never
  // registers, so no startup path can throw there.
  const startupOpts: ToolBridgeOptions = config.failOnStartupError && mode === 'register'
    ? { ...opts, registrationFailure: 'throw' }
    : opts

  let disposed = false
  const maxInstructionBytes = config.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES
  /** Attributed instructions from the last successfully connected generation. */
  let serverInstructions = ''
  /** Sorted resource URIs discovered by the last successful sync; never undefined. */
  let discoveredResourceUris: string[] = []
  let discoveredResourceTemplates: string[] = []
  /** Shared mode's published inventory; register mode leaves this empty. */
  let toolInventory: McpToolDescriptor[] = []
  /** Subscribers to inventory/connection changes in shared mode. */
  const subscribers = new Set<() => void>()
  /** Current generation: the connecting or connected client; undefined during backoff waits and after final failure. */
  let client: Client | undefined
  /** Close signal paired with {@link client}; captured by dispose before current ownership is cleared. */
  let clientClosed: Promise<void> | undefined
  /** Live tool registrations owned by this server; only {@link enqueueSync} and dispose swap it. */
  let disposers: ToolDisposers = new Map()
  let reconnectTimer: NodeJS.Timeout | undefined
  /** Consecutive failed connection attempts within the current outage. */
  let failedAttempts = 0
  /** When the current generation finished connect + initial sync; undefined while down. */
  let connectedAt: number | undefined
  /** The real error from the first connection attempt, for startup-await diagnostics. */
  let firstAttemptError: unknown
  /** The error of the most recent failed attempt, for status surfaces. */
  let lastError: unknown

  const notify = (): void => {
    onToolsChanged()
    for (const subscriber of subscribers) {
      try {
        subscriber()
      } catch (error) {
        ctx.logger.error(`${label}: inventory subscriber failed: ${String(error)}`)
      }
    }
  }

  /** Derived lifecycle state for {@link SharedConnection.status}. */
  const state = (): McpConnectionState => {
    if (disposed) return 'disposed'
    if (connectedAt !== undefined) return 'connected'
    // The first attempt (before any failure) is connecting whatever the
    // reconnect policy says; only later downtime distinguishes stopped/exhausted.
    if (client !== undefined && failedAttempts === 0) return 'connecting'
    if (reconnectTimer !== undefined) return 'reconnecting'
    if (!policy.enabled) return 'stopped'
    /* v8 ignore next -- defensive tail: with the policy enabled, every failure
       arms the reconnect timer or exhausts the budget synchronously, so
       downtime past the guards above has already returned. */
    return failedAttempts > policy.maxAttempts ? 'exhausted' : 'connecting'
  }

  /** A generation may act only while it is the current one on a live plugin. */
  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  /**
   * Serializes every syncTools call — initial syncs and notification re-syncs
   * across all generations — so two syncs can never interleave their
   * dispose-previous/register-next swap (which would double-dispose one
   * generation and leak another).
   */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueueSync(generation: Client, syncOpts: ToolBridgeOptions = opts): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      const previousNames = mode === 'shared' ? toolInventory.map(descriptor => publicToolName(config.serverName, descriptor.rawName)) : [...disposers.keys()]
      const previousResources = [...discoveredResourceUris]
      const previousTemplates = [...discoveredResourceTemplates]
      if (generation.getServerCapabilities()?.tools === undefined) {
        if (mode === 'shared') {
          toolInventory = []
        } else {
          for (const dispose of disposers.values()) dispose()
          disposers = new Map()
        }
        if (previousNames.length > 0) notify()
      } else if (mode === 'shared') {
        toolInventory = await listToolDescriptors(generation, config.serverName, () => isCurrent(generation))
      } else {
        disposers = await syncTools(generation, ctx, syncOpts, disposers, () => isCurrent(generation), (next) => {
          disposers = next
          if (JSON.stringify(previousNames) !== JSON.stringify([...next.keys()])) notify()
        })
      }
      await discoverResources(generation)
      if (!isCurrent(generation)) return
      if (mode === 'shared' && JSON.stringify(previousNames) !== JSON.stringify(toolInventory.map(descriptor => publicToolName(config.serverName, descriptor.rawName)))) notify()
      if (JSON.stringify(previousResources) !== JSON.stringify(discoveredResourceUris)
        || JSON.stringify(previousTemplates) !== JSON.stringify(discoveredResourceTemplates)) notify()
    })
    // The chain tail must survive a failed sync; the enqueuing caller owns reporting.
    syncChain = run.catch(() => {})
    return run
  }

  /**
   * Refresh the resource URI inventory from the live generation. A server
   * without the resources capability empties the cache; a failed discovery
   * keeps the previous cache so a transient failure does not hide members.
   */
  async function discoverResources(generation: Client): Promise<void> {
    if (!isCurrent(generation)) return
    if (generation.getServerCapabilities()?.resources === undefined) {
      discoveredResourceUris = []
      discoveredResourceTemplates = []
      return
    }
    try {
      const guard = cursorGuard(config.serverName)
      const uris = new Set<string>()
      let cursor: string | undefined
      let inventoryBytes = 0
      do {
        guard(cursor)
        const response = boundedResourceResult(await generation.listResources(
          cursor === undefined ? undefined : { cursor },
          { timeout: config.toolCallTimeoutMs },
        ))
        if (!isCurrent(generation)) return
        inventoryBytes += Buffer.byteLength(JSON.stringify(response))
        for (const resource of response.resources) uris.add(resource.uri)
        if (uris.size > MAX_RESOURCE_ITEMS || inventoryBytes > MAX_RESOURCE_RESULT_BYTES) throw new Error('MCP resource inventory exceeds its limit')
        cursor = response.nextCursor
      } while (cursor !== undefined)
      const templates = new Set<string>()
      const templateGuard = cursorGuard(config.serverName)
      let templateCursor: string | undefined
      do {
        templateGuard(templateCursor)
        const response = boundedResourceResult(await generation.listResourceTemplates(
          templateCursor === undefined ? undefined : { cursor: templateCursor },
          { timeout: config.toolCallTimeoutMs },
        ))
        if (!isCurrent(generation)) return
        inventoryBytes += Buffer.byteLength(JSON.stringify(response))
        for (const resource of response.resourceTemplates) {
          new UriTemplate(resource.uriTemplate)
          templates.add(resource.uriTemplate)
        }
        if (uris.size + templates.size > MAX_RESOURCE_ITEMS || inventoryBytes > MAX_RESOURCE_RESULT_BYTES) throw new Error('MCP resource inventory exceeds its limit')
        templateCursor = response.nextCursor
      } while (templateCursor !== undefined)
      discoveredResourceUris = [...uris].sort()
      discoveredResourceTemplates = [...templates].sort()
    } catch (error) {
      // v8 ignore next 2 -- after disposal nobody observes the log anyway
      if (!disposed) ctx.logger.error(`${label}: resource discovery failed: ${String(error)}`)
    }
  }

  /** One disconnect decision per generation: the isCurrent guard makes racing close/error signals idempotent. */
  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = undefined
    clientClosed = undefined
    scheduleReconnect()
    notify()
  }

  /** Wait for the transport-owned close signal without letting a broken transport wedge teardown forever. */
  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(false) }, GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      void closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    const lostEstablishedConnection = connectedAt !== undefined
    if (!policy.enabled) {
      connectedAt = undefined
      const message = lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect'
      ctx.logger.error(`${label}: ${message}`)
      return
    }
    // A connection that stayed up past the stability window (= maxDelayMs, the
    // longest backoff spacing) ended the previous outage: start a fresh budget.
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      // Enqueue the give-up disposal so it cannot race an in-flight sync's
      // phase-2 swap (which checks isCurrent inside the queue).
      syncChain = syncChain.then(() => {
        if (mode === 'shared') {
          toolInventory = []
        } else {
          for (const dispose of disposers.values()) dispose()
          disposers = new Map()
        }
        serverInstructions = ''
        discoveredResourceUris = []
        discoveredResourceTemplates = []
        notify()
      })
      ctx.logger.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    ctx.logger.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      settling = connectGeneration(false)
    }, delayMs)
    // An armed reconnect timer must never hold the process open on its own.
    reconnectTimer.unref()
  }

  /**
   * One connection attempt: fresh transport + client (the MCP SDK binds a
   * Protocol to one transport for life), connect, then queue the initial tool
   * sync. The startup flag belongs to the attempt rather than the shared sync
   * queue, so an early notification cannot consume strict startup semantics.
   * Every failure funnels through {@link generationDown}; success arms the
   * onclose-driven disconnect path. Never rejects.
   *
   * @param startup - Whether this is the plugin's activation attempt.
   */
  async function connectGeneration(startup: boolean): Promise<void> {
    const generation = new Client(
      { name: 'dsh-mcp-client', version: '0.0.1' },
      { capabilities: {} },
    )
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    let attemptSettled = false
    let closeObserved = false
    const hasClosed = (): boolean => closeObserved
    client = generation
    clientClosed = closed.promise
    generation.onclose = () => {
      closeObserved = true
      closed.resolve()
      // A failed connect owns its close barrier in the catch path below. An
      // established generation can transition down directly from this signal.
      if (attemptSettled) generationDown(generation)
    }
    // Registered before connect so a list change during the initial sync is
    // queued behind it rather than dropped.
    generation.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (!isCurrent(generation)) return
        ctx.logger.info(`${label}: tool list changed, re-syncing`)
        try {
          await enqueueSync(generation)
        } catch (error) {
          // Fetch-phase failure: the previous generation is still registered
          // and `disposers` still owns it — keep serving the last good list.
          if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
        }
      },
    )
    generation.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        if (!isCurrent(generation)) return
        ctx.logger.info(`${label}: resource list changed, re-discovering`)
        try {
          await enqueueSync(generation)
        } catch (error) {
          if (!disposed) ctx.logger.error(`${label}: resource re-sync failed: ${String(error)}`)
        }
      },
    )
    let instructions = ''
    try {
      await generation.connect(createTransport(config))
      if (hasClosed()) {
        attemptSettled = true
        generationDown(generation)
        return
      }
      const serverText = generation.getInstructions() ?? ''
      instructions = serverText ? `### MCP server: ${config.serverName}\n\n${serverText}` : ''
      if (Buffer.byteLength(instructions) > maxInstructionBytes) {
        throw new Error(`${label}: server instructions exceed maxInstructionBytes (${maxInstructionBytes})`)
      }
      await enqueueSync(generation, startup ? startupOpts : opts)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      lastError = error
      // Disposal clears current ownership before it closes the generation, so
      // only a live supervisor reports an attempt failure.
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`)
      try { await generation.close() } catch { /* transport already gone */ }
      const quiesced = hasClosed() || await waitForClose(closed.promise)
      attemptSettled = true
      if (!isCurrent(generation)) return
      if (!quiesced) {
        client = undefined
        clientClosed = undefined
        ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`)
        return
      }
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (hasClosed()) {
      generationDown(generation)
      return
    }
    if (!isCurrent(generation)) return
    serverInstructions = instructions
    connectedAt = Date.now()
    notify()
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
  }

  /** The in-flight (or last settled) connection attempt; dispose awaits it for quiescence. */
  let settling = connectGeneration(true)

  // The ready promise settles when the first attempt finishes (regardless of
  // success). If the first attempt fails and reconnect is enabled, the
  // supervisor is already scheduling a retry — ready just reports the outcome.
  const ready: Promise<ConnectionOutcome> = settling.then(() => {
    // After settling: if client is set the initial connect+sync succeeded.
    // If not, the supervisor either scheduled a retry (error logged) or gave
    // up (error logged). Either way the outcome is reported with the real error.
    // Note: settling.then() is a microtask; stdio onclose is a macrotask — so
    // a server that crashes AFTER a successful initial sync cannot flip client
    // to undefined before this continuation runs.
    if (client !== undefined) return {}
    /* v8 ignore next -- defensive: firstAttemptError is always set when connect/sync fails */
    return { error: firstAttemptError ?? new Error(`${label}: initial connection failed`) }
  })

  const inventoryNames = (): string[] =>
    mode === 'shared'
      ? toolInventory.map(descriptor => publicToolName(config.serverName, descriptor.rawName))
      : [...disposers.keys()]

  return {
    serverName: config.serverName,
    ready,
    toolNames: inventoryNames,
    connected: () => !disposed && connectedAt !== undefined,
    status: () => {
      const view: McpConnectionStatus = {
        state: state(),
        failedAttempts,
        maxAttempts: policy.maxAttempts,
        ...connectedAt === undefined ? {} : { connectedAtMs: connectedAt },
        ...lastError === undefined ? {} : { lastErrorKind: errorKindOf(lastError) },
      }
      return view
    },
    toolDescriptors: () => [...toolInventory],
    instructions: () => serverInstructions,
    resourceUris: () => [...discoveredResourceUris],
    resourceTemplates: () => [...discoveredResourceTemplates],
    subscribe(listener: () => void): () => void {
      subscribers.add(listener)
      return () => { subscribers.delete(listener) }
    },
    callTool(rawName: string, args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<unknown> {
      const generation = client
      if (!generation || connectedAt === undefined) return Promise.reject(new Error(`${label}: server is disconnected`))
      return generation.request(
        { method: 'tools/call', params: { name: rawName, arguments: args } },
        RawCallToolResultSchema,
        { timeout: config.toolCallTimeoutMs, ...exec.signal !== undefined ? { signal: exec.signal } : {} },
      )
    },
    resources: {
      async request(request, exec): Promise<JsonValue> {
        const generation = client
        if (!generation || connectedAt === undefined) throw new Error(`${label}: server is disconnected`)
        const options = { signal: exec.signal, timeout: config.toolCallTimeoutMs }
        switch (request.method) {
          case 'resources/list':
            return boundedResourceResult(await generation.listResources(
              request.cursor === undefined ? undefined : { cursor: request.cursor }, options,
            )) as JsonValue
          case 'resources/templates/list':
            return boundedResourceResult(await generation.listResourceTemplates(
              request.cursor === undefined ? undefined : { cursor: request.cursor }, options,
            )) as JsonValue
          case 'resources/read':
            return boundedResourceResult(await generation.readResource({ uri: request.uri }, options)) as JsonValue
          /* v8 ignore next 2 -- resource requests are the closed, typed tool operation union */
          default:
            return assertNever(request)
        }
      },
    },
    async dispose(): Promise<void> {
      disposed = true
      serverInstructions = ''
      discoveredResourceUris = []
      discoveredResourceTemplates = []
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const current = client
      const currentClosed = clientClosed
      client = undefined
      clientClosed = undefined
      if (current !== undefined) {
        try { await current.close() } catch { /* transport already gone */ }
        if (currentClosed !== undefined && !await waitForClose(currentClosed)) {
          ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal — server shutdown may be incomplete`)
        }
      }
      // Quiesce, don't just request it: the in-flight attempt enqueues its
      // sync before settling, so awaiting both leaves `disposers` final.
      await settling
      await syncChain
      if (mode === 'shared') {
        toolInventory = []
      } else {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      }
      notify()
    },
  }
}

/** Name the error kind without leaking message text into status surfaces. */
function errorKindOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/**
 * Start the supervised connection for one standalone plugin instance,
 * registering its tools on this context's registry.
 *
 * @param ctx - Cordis context providing the `tools` registry and logger.
 * @param config - Resolved plugin config selecting the transport and server identity.
 * @param policy - Resolved reconnect policy from {@link resolveReconnectPolicy}.
 * @param onToolsChanged - observer notified when connection or tool topology changes.
 * @returns Handle with a `ready` promise for startup-await and a `dispose` for teardown.
 */
export function startConnection(
  ctx: Context,
  config: Config,
  policy: ResolvedReconnectPolicy,
  onToolsChanged: () => void = NOOP_NOTIFY,
): ConnectionHandle {
  return supervise(ctx, config, policy, onToolsChanged, 'register')
}

/**
 * Start the connection-only supervisor for one shared server. Nothing is
 * registered here; the returned handle publishes its inventory for scoped
 * registrars and routes raw tool calls through the live generation.
 *
 * @param ctx - Cordis context providing the logger.
 * @param config - Resolved plugin config selecting the transport and server identity.
 * @param policy - Resolved reconnect policy from {@link resolveReconnectPolicy}.
 * @param onChanged - observer notified when connection or inventory changes.
 * @returns The shared-connection handle for an owner to publish.
 */
export function startSharedConnection(
  ctx: Context,
  config: Config,
  policy: ResolvedReconnectPolicy,
  onChanged: () => void = NOOP_NOTIFY,
): SharedConnection {
  return supervise(ctx, config, policy, onChanged, 'shared')
}
