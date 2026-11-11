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
import type { McpProbeResult } from '@deepseek-ai/dsh-mcp-client/types'

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
  /** Whether a plugin registered this row for its lifetime; Settings never edits it. */
  registered: boolean
}

/** One probe outcome as the card renders it. */
export type McpProbeView =
  | { readonly phase: 'probing' }
  | {
    readonly phase: 'done'
    readonly ok: boolean
    /** Locale parameters for the summary line. */
    readonly summary: Readonly<Record<string, string>>
  }

/** The section's joined view state. */
export interface McpSectionState {
  /** Aggregate load state of the joined data. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Server rows in settings order, then registered rows; absent until first read lands. */
  rows: readonly McpServerRow[] | undefined
  /** Last failure message, shown verbatim on the error surface. */
  error?: string
  /** Whether the underlying settings scope accepts writes. */
  writable: boolean
  /** Probe outcomes by server id; absent ids carry no probe view. */
  probes: Readonly<Record<string, McpProbeView>>
}

const INITIAL: McpSectionState = { status: 'idle', rows: undefined, writable: false, probes: {} }

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
  /** List every fleet server's live state. */
  status: () => Promise<{ ok: true; value: readonly McpManagementStatusRow[] } | { ok: false; error: { message: string } }>
  /** Restart one enabled server's shared connection. */
  restart: (serverId: string) => Promise<{ ok: true; value: void } | { ok: false; error: { message: string } }>
  /** Test one server's configuration without mounting an owner. */
  probe: (serverId: string) => Promise<{ ok: true; value: McpProbeResult } | { ok: false; error: { message: string } }>
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
        registered: false,
        ...status === undefined ? {} : { status },
      }
    })
    // Plugin-registered servers join after the settings rows, read-only: they
    // exist for their plugin's lifetime and Settings never edits them.
    for (const status of statusRows ?? []) {
      if (status.source !== 'registered' || settingsRows.some(entry => entry.id === status.id)) continue
      rows.push({
        id: status.id,
        serverName: status.serverName,
        transport: status.transport,
        enabled: true,
        presets: presetSelection.get(status.serverName) ?? [],
        registered: true,
        status,
      })
    }
    this.publish({ status: 'ready', rows, writable: snapshot.writable })
  }

  /** Immediate re-join after the Host reported a fleet change. */
  fleetChanged(): void {
    void this.refresh()
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

  /**
   * Test one server's configuration through a one-shot probe and publish the
   * rendered outcome under its id.
   *
   * @param serverId - Stable id of the configured or registered server.
   */
  async probe(serverId: string): Promise<void> {
    this.publish({ probes: { ...this.store.getSnapshot().probes, [serverId]: { phase: 'probing' } } })
    const view = await this.statusFace.probe(serverId)
      .then(result => result.ok
        ? ({ phase: 'done' as const, ok: result.value.ok, summary: probeSummary(result.value) })
        : ({ phase: 'done' as const, ok: false, summary: { message: result.error.message } }))
      .catch((error: unknown) => ({
        phase: 'done' as const,
        ok: false,
        summary: { message: error instanceof Error ? error.message : String(error) },
      }))
    this.publish({ probes: { ...this.store.getSnapshot().probes, [serverId]: view } })
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

/** Locale parameters summarizing one probe outcome for the card. */
function probeSummary(result: McpProbeResult): Readonly<Record<string, string>> {
  if (!result.ok) return { stage: result.stage, message: result.message }
  return {
    ...result.serverInfo === undefined ? {} : { server: `${result.serverInfo.name} ${result.serverInfo.version}` },
    count: `${result.toolNames.length}${result.truncated ? '+' : ''}`,
    ms: String(result.durationMs),
    cleanup: result.cleanup,
    ...result.cleanupError === undefined ? {} : { cleanupError: result.cleanupError },
  }
}
