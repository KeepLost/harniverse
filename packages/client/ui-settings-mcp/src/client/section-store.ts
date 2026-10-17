/**
 * The MCP management section's controller: one snapshot store joining the
 * `mcp` settings scope (the durable server rows), the mcpManagement Remote
 * (live connection status), and per-preset capability selection (which
 * compositions expose each server). Writes ride the settings scope; the
 * restart rides the Remote.
 *
 * @module
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { McpManagementStatusRow } from '@deepseek-ai/dsh-mcp-user-config/types'

/** One server row the page renders: the settings entry joined with live state. */
export interface McpServerRow {
  /** Stable settings identity. */
  id: string
  /** Public tool namespace. */
  serverName: string
  /** Configured transport. */
  transport: 'stdio' | 'streamable-http'
  /** Whether the settings row is enabled. */
  enabled: boolean
  /** Live connection state from the management Remote; absent before load. */
  status?: McpManagementStatusRow
  /** Preset ids whose current composition selects this server. */
  presets: readonly string[]
}

/** The section's joined view state. */
export interface McpSectionState {
  /** Aggregate load state of the joined data. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Server rows in settings order; absent until first read lands. */
  rows: readonly McpServerRow[] | undefined
  /** Last failure message, shown verbatim on the error surface. */
  error?: string
  /** Whether the underlying settings scope accepts writes. */
  writable: boolean
}

const INITIAL: McpSectionState = { status: 'idle', rows: undefined, writable: false }

/** How the joined status view is refreshed while the page is open. */
const STATUS_POLL_MS = 5_000

/** The `mcp` settings section's server array as the wire resolves it. */
export interface McpSettingsServers {
  /** Server rows in settings order; secret values ride only as slots. */
  servers?: ReadonlyArray<{
    id: string
    serverName: string
    enabled?: boolean
    transport: 'stdio' | 'streamable-http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    url?: string
    headers?: Record<string, string>
    toolCallTimeoutMs?: number
    maxInstructionBytes?: number
    failOnStartupError?: boolean
  }>
}

/** Face the controller reads live fleet state through. */
export interface McpStatusFace {
  /** List every configured server's live state. */
  status: () => Promise<{ ok: true; value: readonly McpManagementStatusRow[] } | { ok: false; error: { message: string } }>
  /** Restart one enabled server's shared connection. */
  restart: (serverId: string) => Promise<{ ok: true; value: void } | { ok: false; error: { message: string } }>
}

/** Face the controller reads per-preset exposure through. */
export interface PresetExposureFace {
  /** List every preset id the roster currently supplies. */
  presetIds: () => Promise<readonly string[]>
  /**
   * Read one preset's capability selection for MCP servers.
   * @param presetId - the preset whose composition is read.
   * @returns serverName keys selected by that composition (empty when the
   *   catalog is unreadable or the preset composes no MCP row).
   */
  selectedServerNames: (presetId: string) => Promise<readonly string[]>
}

/**
 * Controller owning the section's joined state.
 */
export class McpSectionController {
  /** Snapshot store publishing the joined section state. */
  readonly store: SnapshotStore<McpSectionState> = createSnapshotStore(INITIAL)
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private unsubscribeScope: (() => void) | undefined
  private disposed = false

  /**
   * @param scope - the bound `mcp` settings scope.
   * @param statusFace - the mcpManagement Remote face.
   * @param exposure - the per-preset exposure face.
   */
  constructor(
    private readonly scope: SettingsScope<McpSettingsServers>,
    private readonly statusFace: McpStatusFace,
    private readonly exposure: PresetExposureFace,
  ) {}

  /**
   * Start the joined read loop: an immediate read, the slow status poll, and
   * a subscription to the settings scope (the scope itself reloads on Host
   * pushes, so every accepted write — from this page or any other — re-joins
   * the view). Safe to call repeatedly; idempotent with {@link stop}.
   */
  start(): void {
    if (this.disposed || this.pollTimer !== undefined) return
    void this.refresh()
    this.pollTimer = setInterval(() => { void this.refresh() }, STATUS_POLL_MS)
    this.unsubscribeScope = this.scope.subscribe(() => { void this.refresh() })
  }

  /** Stop the read loop and accept no further publishes. */
  stop(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    this.unsubscribeScope?.()
    this.unsubscribeScope = undefined
    this.disposed = true
  }

  /** One full joined refresh: settings scope, live status, preset exposure. */
  async refresh(): Promise<void> {
    this.publish({ status: this.store.getSnapshot().rows === undefined ? 'loading' : 'ready' })
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready') {
      this.publish({
        status: snapshot.status === 'unavailable' ? 'error' : 'loading',
        writable: snapshot.writable,
      })
      return
    }
    const settingsRows = snapshot.value?.servers ?? []
    const [statusRows, presetSelection] = await Promise.all([
      this.statusFace.status().then(result => result.ok ? result.value : undefined).catch(() => undefined),
      this.readPresetExposure().catch(() => new Map<string, readonly string[]>()),
    ])
    const byId = new Map((statusRows ?? []).map(row => [row.id, row]))
    const rows: McpServerRow[] = settingsRows.map((entry) => {
      const status = byId.get(entry.id)
      return {
        id: entry.id,
        serverName: entry.serverName,
        transport: entry.transport,
        enabled: entry.enabled !== false,
        presets: presetSelection.get(entry.serverName) ?? [],
        ...status === undefined ? {} : { status },
      }
    })
    this.publish({ status: 'ready', rows, writable: snapshot.writable })
  }

  /**
   * Write the complete server array through the settings scope.
   *
   * @param servers - Full replacement server list.
   */
  async writeServers(servers: ReadonlyArray<NonNullable<McpSettingsServers['servers']>[number]>): Promise<void> {
    await this.scope.set('servers', servers.map(server => ({ ...server })))
    await this.refresh()
  }

  /**
   * Restart one enabled server's shared connection.
   *
   * @param serverId - Hex server id whose shared connection restarts.
   * @returns Failure message, or undefined on success.
   */
  async restart(serverId: string): Promise<string | undefined> {
    const result = await this.statusFace.restart(serverId)
    await this.refresh()
    return result.ok ? undefined : result.error.message
  }

  /** Current writable state for disabling controls. */
  get writable(): boolean {
    return this.store.getSnapshot().writable
  }

  /** Fold partial state into the next published snapshot. */
  private publish(patch: Partial<McpSectionState>): void {
    if (this.disposed) return
    const previous = this.store.getSnapshot()
    this.store.set({ ...previous, ...patch })
  }

  /** Join per-preset selections into serverName → preset ids. */
  private async readPresetExposure(): Promise<Map<string, readonly string[]>> {
    const joined = new Map<string, readonly string[]>()
    for (const presetId of await this.exposure.presetIds()) {
      for (const serverName of await this.exposure.selectedServerNames(presetId)) {
        joined.set(serverName, [...joined.get(serverName) ?? [], presetId])
      }
    }
    return joined
  }
}
