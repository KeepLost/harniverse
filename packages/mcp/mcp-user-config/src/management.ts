/**
 * Management face over the shared MCP connections: per-server status (derived
 * connection state plus the current tool inventory) and one authorized
 * restart per stable server id. The provider instantiates this service in the
 * host/base scope; both Remote methods require `harniverse.administer`, the
 * same authority settings writes carry.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RECONNECT_DEFAULTS } from '@deepseek-ai/dsh-mcp-client'
import type { McpConnectionsService } from '@deepseek-ai/dsh-mcp-client'
import type { UserMcpServerConfig } from './index.ts'
import type { McpManagementStatusRow } from './types.ts'

/** Host faces the management service reads and drives. */
export interface McpManagementDeps {
  /** Live shared connections keyed by stable server id. */
  readonly registry: McpConnectionsService
  /** Current validated settings snapshot, re-read on every call. */
  readonly entries: () => readonly UserMcpServerConfig[]
  /**
   * Dispose and remount one server's owner with unchanged configuration.
   * @param serverId - stable settings identity of the enabled server.
   * @returns settlement after the old owner disposed and the remount started.
   */
  readonly restartOwner: (serverId: string) => Promise<void>
}

/**
 * Authorized Remote over the shared MCP connection fleet.
 */
export class McpManagementService extends TypertRemoteService {
  constructor(ctx: Context, private readonly deps: McpManagementDeps) {
    super(ctx, 'mcpManagement')
  }

  /**
   * List every configured server with its derived state and tool inventory.
   * @returns one row per settings entry, disabled entries included.
   */
  @Remote({ exportName: 'status', requiredCapability: 'harniverse.administer' })
  status(): readonly McpManagementStatusRow[] {
    const rows: McpManagementStatusRow[] = []
    for (const entry of this.deps.entries()) {
      const handle = this.deps.registry.get(entry.id)
      if (handle === undefined) {
        const row: McpManagementStatusRow = {
          id: entry.id,
          serverName: entry.serverName,
          transport: entry.transport,
          state: entry.enabled ? 'stopped' : 'disabled',
          failedAttempts: 0,
          maxAttempts: entry.reconnect.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts,
          tools: [],
        }
        rows.push(row)
        continue
      }
      const snapshot = handle.status()
      const row: McpManagementStatusRow = {
        id: entry.id,
        serverName: entry.serverName,
        transport: entry.transport,
        state: snapshot.state,
        failedAttempts: snapshot.failedAttempts,
        maxAttempts: snapshot.maxAttempts,
        tools: handle.toolDescriptors().map(descriptor => ({ name: descriptor.rawName, description: descriptor.description })),
        ...snapshot.connectedAtMs === undefined ? {} : { connectedAtMs: snapshot.connectedAtMs },
        ...snapshot.lastErrorKind === undefined ? {} : { lastErrorKind: snapshot.lastErrorKind },
      }
      rows.push(row)
    }
    return rows
  }

  /**
   * Restart one enabled server's shared connection in place. Validation owns
   * the fleet step that performs the restart, so a settings change between
   * read and restart is judged against the state that actually runs.
   * @param serverId - stable settings identity of the server to restart.
   * @returns settlement after the replacement owner started connecting.
   */
  @Remote({ exportName: 'restart', requiredCapability: 'harniverse.administer' })
  async restart(serverId: string): Promise<void> {
    await this.deps.restartOwner(serverId)
  }
}
