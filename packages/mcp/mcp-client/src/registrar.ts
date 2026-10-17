/**
 * Shared-connection registrar: the scoped half of the shared-connection
 * split. One registrar mounts inside a profile composition, resolves its
 * server's live connection from the {@link McpConnectionsService} registry,
 * and projects the published tool inventory into its own `ctx.tools` layer —
 * per-scope public names, member permissions, resources, and instructions —
 * while every execution routes through the one host-owned transport.
 *
 * @module
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { McpResourceProvider } from '@deepseek-ai/dsh-mcp-resources'
import z from '@deepseek-ai/schemastery'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { exposeScopedServer } from './exposure.ts'
import type { SharedConnection } from './connection.ts'
import { activeServerNamesOf } from './reservations.ts'
import { connectionsOf, MCP_CONNECTIONS_SERVICE } from './shared-service.ts'
import { descriptorToDefinition } from './tools.ts'
import type { ToolDisposers } from './tools.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const registrarName = 'mcp-client-registrar'

/** Services required by a registrar. */
export const registrarInject = ['tools', MCP_CONNECTIONS_SERVICE]

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Configuration resolving one shared connection into this scope. */
export interface McpRegistrarConfig {
  /** Stable settings identity of the shared server to attach to. */
  serverId: string
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`), as captured by this composition.
   */
  serverName: string
  /** Optional owner key allowing the same public namespace in separate scoped registries. */
  reservationKey?: string
}

/** Config for one preset-scoped registrar child exposing a shared server's tools. */
export const McpRegistrarConfigSchema = z.object({
  serverId: z.string().required().pattern(SERVER_ID_PATTERN),
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  reservationKey: z.string(),
})

/** Live attachment state resynced from the registry on every change. */
interface Attachment {
  connection: SharedConnection
  unsubscribe: () => void
}

/**
 * Attach one shared server into this context's registries.
 *
 * The registrar never fails its fiber on connection state: an absent owner
 * (server disabled or removed mid-generation) or a down connection simply
 * registers nothing, and the exposure reports the server unavailable.
 *
 * @param ctx - registrar plugin context carrying the scoped tool registry.
 * @param config - resolved attachment identity.
 */
export function registrarApply(ctx: Context, config: McpRegistrarConfig): void {
  const connections = connectionsOf(ctx)
  if (connections === undefined) {
    throw new Error('mcp-client-registrar: no shared-connection registry serves this composition')
  }

  // Reserve the namespace first: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  ctx.effect(() => {
    const reservationScope = ctx.root
    const reservationName = config.reservationKey === undefined
      ? config.serverName
      : `${config.reservationKey}:${config.serverName}`
    const names = activeServerNamesOf(reservationScope)
    if (names.has(reservationName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(reservationName)
    return () => void names.delete(reservationName)
  }, 'mcp-client.serverName')

  let attachment: Attachment | undefined
  let disposers: ToolDisposers = new Map()
  const resources: McpResourceProvider = {
    async request(request, exec): Promise<JsonValue> {
      const handle = attachment?.connection
      if (handle === undefined) throw new Error(`mcp-client(${config.serverName}): server is not attached`)
      return await handle.resources.request(request, exec)
    },
  }
  const invalidate: () => void = exposeScopedServer(ctx, config.serverName, config.reservationKey, {
    toolNames: () => attachment?.connection.toolNames() ?? [],
    connected: () => attachment?.connection.connected() ?? false,
    resourceUris: () => attachment?.connection.resourceUris() ?? [],
    resourceTemplates: () => attachment?.connection.resourceTemplates() ?? [],
    instructions: () => attachment?.connection.instructions() ?? '',
    resources,
  })
  /** Rebuild this scope's registrations from the current inventory snapshot. */
  const sync = (): void => {
    const handle = attachment?.connection
    const next = new Map<string, () => () => void>()
    if (handle !== undefined) {
      for (const descriptor of handle.toolDescriptors()) {
        const definition = descriptorToDefinition(config.serverName, descriptor, (rawName, args, exec) =>
          handle.callTool(rawName, args, exec))
        next.set(definition.name, () => ctx.tools.register(definition))
      }
    }
    // Swap: dispose the previous generation first so a re-registration of the
    // same public name never conflicts with itself. A foreign squatter on
    // this server's namespace fails its own registration and is contained —
    // the model sees the full generation minus the conflict, as the bridge does.
    for (const dispose of disposers.values()) dispose()
    disposers = new Map()
    for (const [publicName, register] of next) {
      try {
        disposers.set(publicName, register())
      } catch (error) {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
        ctx.logger.error(`mcp-client(${config.serverName}): tool registration failed, no tools registered: ${String(error)}`)
        break
      }
    }
    invalidate()
  }

  ctx.effect(() => {
    const attach = (connection: SharedConnection | undefined): void => {
      if (attachment?.connection === connection) return
      attachment?.unsubscribe()
      attachment = connection === undefined ? undefined : {
        connection,
        unsubscribe: connection.subscribe(() => { sync() }),
      }
      sync()
    }
    attach(connections.get(config.serverId))
    const unsubscribeRegistry = connections.subscribe((serverId) => {
      if (serverId !== config.serverId) return
      attach(connections.get(config.serverId))
    })
    return () => {
      unsubscribeRegistry()
      attachment?.unsubscribe()
      attachment = undefined
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    }
  }, 'mcp-client-registrar.lifecycle')

}

/** The registrar plugin object programmatic mounts reference. */
export const McpRegistrarPlugin: Plugin<McpRegistrarConfig> = {
  name: registrarName,
  inject: registrarInject,
  Config: McpRegistrarConfigSchema as unknown as NonNullable<Plugin<McpRegistrarConfig>['Config']>,
  apply: registrarApply,
}
