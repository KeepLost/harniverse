/**
 * Shared-connection owner: the host-scope half of the shared-connection
 * split. One owner plugin instance starts the transport and reconnect
 * supervisor for one configured server — without registering anything — and
 * publishes the handle into the {@link McpConnectionsService} registry keyed
 * by the server's stable settings id. Scoped registrars attach to it.
 *
 * Connection outcomes are always contained here: a shared connection is
 * process-global, so one server being down must never fail the composition
 * that hosts the owner. Status surfaces carry the failure instead.
 *
 * @module
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveReconnectPolicy, startSharedConnection } from './connection.ts'
import type { Config } from './index.ts'
import { Config as McpClientConfig } from './config.ts'
import { connectionsOf, MCP_CONNECTIONS_SERVICE } from './shared-service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const ownerName = 'mcp-client-owner'

/** The registry service is the one host-side requirement. */
export const ownerInject = [MCP_CONNECTIONS_SERVICE]

/** One shared server's connection configuration plus its stable identity. */
export type McpOwnerConfig = Config & {
  /** Stable settings identity registrars attach by. */
  serverId: string
}

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Owner schema: the standalone client schema narrowed by the stable id. */
export const McpOwnerConfigSchema = z.intersect([
  McpClientConfig,
  z.object({ serverId: z.string().required().pattern(SERVER_ID_PATTERN) }),
])

/**
 * Start one shared connection and publish it into the registry.
 * @param ctx - owner plugin context in the host/base scope.
 * @param config - resolved transport, server identity, and stable id.
 */
export async function ownerApply(ctx: Context, config: McpOwnerConfig): Promise<void> {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)
  const connections = connectionsOf(ctx)
  if (connections === undefined) {
    throw new Error('mcp-client-owner: no shared-connection registry serves this composition')
  }

  const connection = startSharedConnection(ctx, config, reconnect)
  ctx.effect(() => connections.register(config.serverId, connection), 'mcp-client-owner.registry')
  ctx.effect(() => () => { void connection.dispose() }, 'mcp-client-owner.connection')
  // Startup never blocks on the first attempt: a shared connection reports
  // through status, and a down server disables tools, it does not fail boots.
  await connection.ready
}

/** The owner plugin object programmatic mounts reference. */
export const McpOwnerPlugin: Plugin<McpOwnerConfig> = {
  name: ownerName,
  inject: ownerInject,
  Config: McpOwnerConfigSchema as unknown as NonNullable<Plugin<McpOwnerConfig>['Config']>,
  apply: ownerApply,
}
