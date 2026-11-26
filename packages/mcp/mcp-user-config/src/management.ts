/**
 * Management face over the shared MCP connections: per-server status (derived
 * connection state plus the current tool inventory), one authorized restart
 * per stable server id, the passive probe, and the explicit OAuth
 * authorization the settings page drives. The provider instantiates this
 * service in the host/base scope; every Remote method requires
 * `harniverse.administer`, the same authority settings writes carry.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RECONNECT_DEFAULTS } from '@deepseek-ai/dsh-mcp-client'
import type { McpConnectionsService, McpOAuthAuthorizationState } from '@deepseek-ai/dsh-mcp-client'
import type { McpProbeResult } from '@deepseek-ai/dsh-mcp-client/types'
import { McpAuthorizationCoordinator } from './authorization.ts'
import type { McpFleetEntry } from './index.ts'
import type { McpAuthorizationStart, McpManagementStatusRow } from './types.ts'

/** Host faces the management service reads and drives. */
export interface McpManagementDeps {
  /** Live shared connections keyed by stable server id. */
  readonly registry: McpConnectionsService
  /** Current fleet entries (configured and registered), re-read on every call. */
  readonly entries: () => readonly McpFleetEntry[]
  /**
   * Dispose and remount one server's owner with unchanged configuration.
   * @param serverId - stable settings identity of the enabled server.
   * @returns settlement after the old owner disposed and the remount started.
   */
  readonly restartOwner: (serverId: string) => Promise<void>
  /**
   * Probe one configured entry without mounting an owner: connect, read the
   * server identity, list tool names, close.
   * @param serverId - stable settings identity of the server to test.
   * @returns the stage-classified probe outcome and independent cleanup result.
   */
  readonly probeEntry: (serverId: string) => Promise<McpProbeResult>
}

/**
 * Authorized Remote over the shared MCP connection fleet.
 */
export class McpManagementService extends TypertRemoteService {
  /** Per-connection change listeners retained for resubscription and disposal. */
  private readonly handleListeners = new Map<string, () => void>()
  /** The explicit OAuth authorization attempts of the fleet. */
  private readonly authorization: McpAuthorizationCoordinator

  constructor(ctx: Context, private readonly deps: McpManagementDeps) {
    super(ctx, 'mcpManagement')
    this.authorization = new McpAuthorizationCoordinator(ctx, {
      registry: deps.registry,
      entries: deps.entries,
      changed: () => { this.emitFleetChanged() },
    })
    // Registry events cover membership and owner replacement (settings
    // remounts, restarts, registrations); each live handle's own change feed
    // covers state transitions inside one connection. Both funnel into the
    // one fleet-changed notification, and disposal removes every listener.
    ctx.effect(() => {
      const unsubscribeRegistry = this.deps.registry.subscribe((serverId) => {
        this.subscribeHandle(serverId)
        this.authorization.retire(serverId)
        this.emitFleetChanged()
      })
      for (const { entry } of this.deps.entries()) this.subscribeHandle(entry.id)
      return () => {
        unsubscribeRegistry()
        this.authorization.dispose()
        for (const dispose of this.handleListeners.values()) dispose()
        this.handleListeners.clear()
      }
    }, 'mcpManagement.fleet-watch')
  }

  /** Follow one server id's current handle, or stop following its removal. */
  private subscribeHandle(serverId: string): void {
    const handle = this.deps.registry.get(serverId)
    if (handle === undefined) {
      this.handleListeners.get(serverId)?.()
      this.handleListeners.delete(serverId)
      return
    }
    if (this.handleListeners.has(serverId)) return
    const notify = (): void => { this.emitFleetChanged() }
    this.handleListeners.set(serverId, handle.subscribe(notify))
  }

  /** Emit `mcpManagement/fleet-changed` without letting one broken listener veto the change. */
  private emitFleetChanged(): void {
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch('emit', ['mcpManagement/fleet-changed']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(error: unknown): void {
    this.ctx.logger.warn('mcpManagement: a fleet-changed listener failed')
    this.ctx.logger.warn(error)
  }

  /**
    * List every fleet server with its derived state and tool inventory.
    * @returns one row per configured settings entry (disabled included) and
    * per live plugin registration (`source: 'registered'`).
    */
  @Remote({ exportName: 'status', requiredCapability: 'harniverse.administer' })
  status(): readonly McpManagementStatusRow[] {
    const rows: McpManagementStatusRow[] = []
    for (const { entry, registered } of this.deps.entries()) {
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
          ...registered ? { source: 'registered' as const } : {},
        }
        rows.push(row)
        continue
      }
      const snapshot = handle.status()
      const attempt = this.authorization.attemptOf(entry.id)
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
        ...this.wireAuthorization(snapshot.authorization),
        ...attempt === undefined ? {} : { attempt },
        ...registered ? { source: 'registered' as const } : {},
      }
      rows.push(row)
    }
    return rows
  }

  /** The authorization field of one row; it stays absent for a server without OAuth. */
  private wireAuthorization(state: McpOAuthAuthorizationState | undefined): Pick<McpManagementStatusRow, 'authorization'> {
    if (state === undefined) return {}
    if (state.state === 'authorized') {
      return { authorization: { state: 'authorized', ...state.expiresAtMs === undefined ? {} : { expiresAtMs: state.expiresAtMs } } }
    }
    return { authorization: { state: 'waiting-authorization', reason: state.reason } }
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

  /**
   * Test one server's configuration without mounting an owner: connect, read
   * the identity, list tool names, close. Nothing registers and no namespace
   * is reserved, so a settings surface can trial a disabled entry before
   * enabling it.
   * @param serverId - stable settings identity of the server to test.
   * @returns the stage-classified outcome and independent cleanup result.
   */
  @Remote({ exportName: 'probe', requiredCapability: 'harniverse.administer' })
  async probe(serverId: string): Promise<McpProbeResult> {
    return this.deps.probeEntry(serverId)
  }

  /**
   * Start the explicit OAuth authorization of one enabled OAuth-configured
   * server, or join the attempt already pending for it. Nothing happens in a
   * browser until the caller opens the returned authorization page.
   * @param serverId - Stable settings identity of the server to authorize.
   * @param redirectOrigin - Origin the caller's browser is served from; omission uses the web listener's own loopback origin.
   * @returns The attempt and the authorization page the user opens.
   * @throws when the server is unknown, lacks OAuth, lacks a live connection, or the redirect origin is not a serving authority.
   */
  @Remote({ exportName: 'startAuthorization', requiredCapability: 'harniverse.administer' })
  async startAuthorization(serverId: string, redirectOrigin?: string): Promise<McpAuthorizationStart> {
    return this.authorization.start(serverId, redirectOrigin)
  }

  /**
   * Cancel the pending authorization attempt of one server; an unknown or
   * already settled attempt is ignored.
   * @param serverId - Stable settings identity of the server.
   */
  @Remote({ exportName: 'cancelAuthorization', requiredCapability: 'harniverse.administer' })
  async cancelAuthorization(serverId: string): Promise<void> {
    await this.authorization.cancel(serverId)
  }

  /**
   * Delete the stored OAuth grant of one server. Its connection waits for a
   * new authorization afterwards.
   * @param serverId - Stable settings identity of the server.
   * @throws when the server is unknown, lacks OAuth, or lacks a live connection.
   */
  @Remote({ exportName: 'signOut', requiredCapability: 'harniverse.administer' })
  async signOut(serverId: string): Promise<void> {
    await this.authorization.signOut(serverId)
  }
}
