/**
 * Wire types for the MCP management Remote. Self-contained string unions and
 * rows: nothing here reaches into another package's type surface.
 *
 * @module @deepseek-ai/dsh-mcp-user-config/types
 */

/** Connection lifecycle states the shared supervisor reports. */
export type McpConnectionLifecycleState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'exhausted'
  | 'stopped'
  | 'disposed'

/** Connection states plus the settings-owned rest states. */
export type McpManagementState = McpConnectionLifecycleState | 'disabled'

/** One advertised tool inside a status row. */
export interface McpManagementTool {
  /** The server's own wire name (not the model-facing public name). */
  name: string
  /** The server-provided description, possibly empty. */
  description: string
}

/** One configured server's management view. */
export interface McpManagementStatusRow {
  /** Stable settings identity. */
  id: string
  /** Public server namespace used in model-facing names. */
  serverName: string
  /** Configured transport. */
  transport: 'stdio' | 'streamable-http'
  /** Enabled servers carry the live connection state; disabled ones never started. */
  state: McpManagementState
  /** Consecutive failed attempts of the current outage (0 while up). */
  failedAttempts: number
  /** The outage budget the supervisor allows. */
  maxAttempts: number
  /** The current tool inventory, in server order. */
  tools: readonly McpManagementTool[]
  /** Epoch ms of the current connection generation; absent while down. */
  connectedAtMs?: number
  /** Error name of the most recent failed attempt; absent while none occurred. */
  lastErrorKind?: string
}
