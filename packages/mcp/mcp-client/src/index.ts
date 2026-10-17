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
import type {} from '@deepseek-ai/dsh-capabilities'
import { DEFAULT_MAX_INSTRUCTION_BYTES, resolveReconnectPolicy, startConnection } from './connection.ts'
import { exposeScopedServer } from './exposure.ts'

import type { Config } from './config.ts'
export { Config } from './config.ts'
export type { StdioConfig, StreamableHttpConfig } from './config.ts'
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

// ---- Shared-connection core re-exports (owner fleet + scoped registrars) ----
export {
  connectionsOf,
  McpConnectionsRegistry,
  MCP_CONNECTIONS_SERVICE,
} from './shared-service.ts'
export type { McpConnectionsService } from './shared-service.ts'
export { McpOwnerPlugin } from './owner.ts'
export { McpRegistrarPlugin } from './registrar.ts'
export { startSharedConnection } from './connection.ts'
export type { McpConnectionState, SharedConnection } from './connection.ts'
export { RECONNECT_DEFAULTS } from './connection.ts'
export { activeServerNamesOf } from './reservations.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/**
 * Live `serverName` reservations per app and optional owner key. Scoped profile
 * compositions may mount the same user server in separate registries, while
 * direct rows without an owner key retain one-app duplicate detection.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

// ---- Config ----




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
  // Exposure (server context, capability adapter, member restriction) is the
  // same scoped route the shared-connection registrar takes.
  /* v8 ignore next -- placeholder until the exposure assigns the live invalidator; the supervisor first notifies asynchronously. */
  let invalidate = (): void => {}
  const connection = startConnection(ctx, config, reconnect, () => {
    invalidate()
  })
  invalidate = exposeScopedServer(ctx, config.serverName, config.reservationKey, connection)

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
