/**
 * The host-owned registry of live shared MCP connections. One connection
 * owner registers its handle per stable server id; scoped registrars resolve
 * handles by that id and project the inventory into their own registries, so
 * every composition shares one transport and one reconnect supervisor per
 * server while keeping per-scope tool registration and member permissions.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SharedConnection } from './connection.ts'

/** Cordis service key carrying the shared-connection registry. */
export const MCP_CONNECTIONS_SERVICE = 'mcpConnections'

/** Read/subscribe face over the live shared connections of this app. */
export interface McpConnectionsService {
  /**
   * Install or replace one server's connection (owner side).
   * @param serverId - stable settings identity of the server.
   * @param connection - the live handle an owner published.
   * @returns the disposer removing the registration.
   */
  register(serverId: string, connection: SharedConnection): () => void
  /**
   * Resolve one server's live connection.
   * @param serverId - stable settings identity of the server.
   * @returns the live handle, or undefined while no owner serves it.
   */
  get(serverId: string): SharedConnection | undefined
  /**
   * Observe registry membership and handle replacement.
   * @param listener - invoked with the changed server id after every swap.
   * @returns the disposer removing the listener.
   */
  subscribe(listener: (serverId: string) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live shared MCP connections keyed by stable server id. */
    mcpConnections: McpConnectionsService
  }
}

/** Default registry implementation an owner-side provider instantiates. */
export class McpConnectionsRegistry implements McpConnectionsService {
  private readonly connections = new Map<string, SharedConnection>()
  private readonly listeners = new Set<(serverId: string) => void>()

  /** @inheritdoc */
  register(serverId: string, connection: SharedConnection): () => void {
    this.connections.set(serverId, connection)
    for (const listener of this.listeners) listener(serverId)
    return () => {
      if (this.connections.get(serverId) === connection) {
        this.connections.delete(serverId)
        for (const listener of this.listeners) listener(serverId)
      }
    }
  }

  /** @inheritdoc */
  get(serverId: string): SharedConnection | undefined {
    return this.connections.get(serverId)
  }

  /** @inheritdoc */
  subscribe(listener: (serverId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}


/**
 * Resolve the registry from a context without asserting it.
 * @param ctx - context possibly carrying the registry service.
 * @returns the registry, or undefined when no provider serves it.
 */
export function connectionsOf(ctx: Context): McpConnectionsService | undefined {
  return ctx.get(MCP_CONNECTIONS_SERVICE)
}
