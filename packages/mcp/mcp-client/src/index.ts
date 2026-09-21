/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js'
import type {} from '@deepseek-ai/dsh-capabilities'
import z from '@deepseek-ai/schemastery'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { DEFAULT_MAX_INSTRUCTION_BYTES, RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
import { MCP_SERVER_NAME_PATTERN, mcpResourceMemberId, mcpResourceTemplateMemberId, resolveMcpMemberVisibility } from './resource-contract.ts'
import type { McpMemberVisibility } from './resource-contract.ts'
import { registerServerContext } from './server-context.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export type { McpResult } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'
export {
  classifyMcpRefresh,
  isMcpResourceIdentity,
  isMcpServerName,
  MCP_SERVER_NAME_PATTERN,
  mcpResourceMemberId,
  mcpResourceTemplateMemberId,
  mcpServerCapabilityId,
  resolveMcpMemberVisibility,
} from './resource-contract.ts'
export type {
  McpMemberVisibility,
  McpRefreshKind,
  McpRefreshTrigger,
  McpResourceIdentity,
} from './resource-contract.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/**
 * Live `serverName` reservations per app and optional owner key. Scoped profile
 * compositions may mount the same user server in separate registries, while
 * direct rows without an owner key retain one-app duplicate detection.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Optional owner key allowing the same public namespace in separate scoped registries. */
  reservationKey?: string | undefined
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** UTF-8 byte ceiling for the attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Optional owner key allowing the same public namespace in separate scoped registries. */
  reservationKey?: string | undefined
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** UTF-8 byte ceiling for the attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(MCP_SERVER_NAME_PATTERN),
    reservationKey: z.string(),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(MCP_SERVER_NAME_PATTERN),
    reservationKey: z.string(),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: Reconnect,
  }),
]) as unknown as z<Config>

// ---- Plugin apply ----

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)
  const instructionBytes = config.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES
  if (!Number.isSafeInteger(instructionBytes) || instructionBytes < 1) {
    throw new Error('mcp-client: maxInstructionBytes must be a positive safe integer')
  }

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  ctx.effect(() => {
    const reservationScope = ctx.root
    const reservationName = config.reservationKey === undefined
      ? config.serverName
      : `${config.reservationKey}:${config.serverName}`
    let names = activeServerNames.get(reservationScope)
    if (!names) {
      names = new Set()
      activeServerNames.set(reservationScope, names)
    }
    if (names.has(reservationName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(reservationName)
    return () => void names.delete(reservationName)
  }, 'mcp-client.serverName')

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  let capabilityChanged = (): void => {}
  const restrictionRefreshers = new Set<() => void>()
  /**
   * Resource URIs visible per composition scope key. A Profile member
   * selection records its narrowing here; a scope with no record (including
   * compositions without the capabilities service) reaches every resource.
   */
  const resourceSelection = new WeakMap<object, McpMemberVisibility>()
  const connection = startConnection(ctx, config, reconnect, () => {
    capabilityChanged()
    for (const refresh of restrictionRefreshers) {
      try {
        refresh()
      } catch (error) {
        ctx.logger.error(`mcp-client(${config.serverName}): composition restriction refresh failed: ${String(error)}`)
      }
    }
  })

  /** Nearest composition record on the caller's scope chain, or undefined when unrestricted. */
  const nearestResourceRecord = (agent: object | undefined): McpMemberVisibility | undefined => {
    for (const key of scopeChainOf(agent)) {
      const record = resourceSelection.get(key)
      if (record !== undefined) return record
    }
    return undefined
  }

  /**
   * Narrow one resources/list result to the caller-visible URIs; other result
   * shapes pass through untouched.
   */
  const filterResourceList = (result: JsonValue, visible: McpMemberVisibility, templates: boolean): JsonValue => {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return result
    const key = templates ? 'resourceTemplates' : 'resources'
    const resources = (result as Record<string, unknown>)[key]
    if (!Array.isArray(resources)) return result
    const kept = resources.filter((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
      const value = templates ? (item as { uriTemplate?: unknown }).uriTemplate : (item as { uri?: unknown }).uri
      return typeof value === 'string' && (templates ? visible.visibleResourceTemplates.includes(value) : visible.visibleResourceUris.includes(value))
    })
    return { ...result, [key]: kept }
  }

  const templateMatches = (template: string, uri: string): boolean => new UriTemplate(template).match(uri) !== null

  // Resource requests are enforced at the provider — the composition that
  // made the decision cannot be bypassed by calling the shared tools with a
  // different server argument.
  registerServerContext(ctx, config.serverName, config.reservationKey ?? config.serverName, {
    resources: {
      async request(request, exec): Promise<JsonValue> {
        const record = nearestResourceRecord(exec.agent)
        if (record !== undefined && !record.serverSelected) {
          throw new Error(`mcp-client(${config.serverName}): resource server is not visible to this agent`)
        }
        if (request.method === 'resources/read' && record !== undefined && !record.unrestrictedResources
          && !record.visibleResourceUris.includes(request.uri)
          && !record.visibleResourceTemplates.some(template => templateMatches(template, request.uri))) {
          throw new Error(`mcp-client(${config.serverName}): resource "${request.uri}" is not visible to this agent`)
        }
        const result = await connection.resources.request(request, exec)
        if (record === undefined || record.unrestrictedResources) return result
        if (request.method === 'resources/list') return filterResourceList(result, record, false)
        if (request.method === 'resources/templates/list') return filterResourceList(result, record, true)
        return result
      },
    },
    instructions: () => connection.instructions(),
  }, scope => nearestResourceRecord(scope)?.serverSelected !== false)

  ctx.inject(['capabilities'], (capabilityCtx) => {
    const encodedName = Buffer.from(config.serverName).toString('hex')
    const capabilityId = `mcp-server:${encodedName}`
    capabilityCtx.capabilities.registerAdapter((control) => {
      capabilityChanged = () => { control.invalidate() }
      return {
        id: `mcp-client:${encodedName}`,
        snapshot: () => ({
          complete: true,
          entries: [{
            id: capabilityId,
            kind: 'mcp-server',
            name: config.serverName,
            description: `MCP server ${config.serverName}`,
            provenance: 'external',
            assembleable: true,
            available: connection.connected(),
            defaultLoaded: true,
            manageable: true,
            owner: '@deepseek-ai/dsh-mcp-client',
            requires: [],
            members: [
              ...connection.toolNames().map(name => ({
                id: `${capabilityId}/mcp-tool:${Buffer.from(name).toString('hex')}`,
                kind: 'mcp-tool' as const,
                name,
                description: `MCP tool ${name}`,
                defaultVisible: true,
                available: true,
                requires: [],
              })),
              ...connection.resourceUris().map(uri => ({
                id: mcpResourceMemberId(config.serverName, uri),
                kind: 'mcp-resource' as const,
                name: uri,
                description: `MCP resource ${uri}`,
                defaultVisible: true,
                available: true,
                requires: [],
              })),
              ...connection.resourceTemplates().map(uriTemplate => ({
                id: mcpResourceTemplateMemberId(config.serverName, uriTemplate),
                kind: 'mcp-resource' as const,
                name: uriTemplate,
                description: `MCP resource template ${uriTemplate}`,
                defaultVisible: true,
                available: true,
                requires: [],
              })),
            ],
          }],
        }),
        restrict: (compositionCtx, entries) => {
          const entry = entries.find(candidate => candidate.id === capabilityId)
          if (entry === undefined) return
          const tools = compositionCtx.get('tools')
          if (tools === undefined) return
          const scope = scopeOf(compositionCtx)
          let release = (): void => {}
          const refresh = (): void => {
            const names = connection.toolNames()
            const uris = connection.resourceUris()
            const templates = connection.resourceTemplates()
            const visibility = resolveMcpMemberVisibility(entry, names, uris, templates)
            if (scope !== undefined) resourceSelection.set(scope, visibility)
            const denied = visibility.serverSelected ? visibility.deniedToolNames : names
            const next = denied.length === 0
              ? (): void => {}
              : tools.restrict({ deny: denied, includeOwn: true })
            const previous = release
            release = next
            previous()
          }
          compositionCtx.effect(() => {
            restrictionRefreshers.add(refresh)
            refresh()
            return () => {
              restrictionRefreshers.delete(refresh)
              if (scope !== undefined) resourceSelection.delete(scope)
              release()
            }
          }, `mcp-client.capabilityComposition(${JSON.stringify(config.serverName)})`)
        },
      }
    })
    capabilityCtx.effect(() => () => { capabilityChanged = () => {} }, 'mcp-client.capabilities()')
  })

  ctx.effect(() => {
    return () => connection.dispose()
  }, 'mcp-client.connection')

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor enters its reconnect loop.
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
