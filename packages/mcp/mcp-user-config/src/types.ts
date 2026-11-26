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
  | 'waiting-authorization'
  | 'exhausted'
  | 'stopped'
  | 'disposed'

/** Why an OAuth-configured server waits for an explicit authorization. */
export type McpAuthorizationReason =
  | 'missing'
  | 'expired'
  | 'binding'
  | 'rejected'
  | 'scope'

/** Authorization state of an OAuth-configured server. */
export type McpManagementAuthorization =
  | {
    /** A usable grant is stored. */
    state: 'authorized'
    /** Epoch ms after which the stored access token is refreshed; absent for a token without a lifetime. */
    expiresAtMs?: number
  }
  | {
    /** No usable grant exists until the user authorizes the server. */
    state: 'waiting-authorization'
    /** Why the server waits. */
    reason: McpAuthorizationReason
  }

/** Phases of one explicit authorization attempt. */
export type McpOAuthAttemptPhase =
  | 'starting'
  | 'waiting-browser'
  | 'exchanging'
  | 'committing'
  | 'authorized'
  | 'cancelled'
  | 'failed'

/** The latest authorization attempt of one server. */
export interface McpManagementAttempt {
  /** Identity of the attempt; a new attempt after a settled one carries a new id. */
  id: string
  /** `starting` through `committing` while the attempt can still complete, then one terminal phase. */
  phase: McpOAuthAttemptPhase
  /** Deadline the attempt fails at, as epoch ms. */
  expiresAtMs: number
}

/** Answer of `mcpManagement.startAuthorization`: the attempt and the page the user opens. */
export interface McpAuthorizationStart {
  readonly attempt: McpManagementAttempt
  /** Authorization page the user's browser opens; it carries the attempt's one-time state. */
  readonly authorizationUrl: string
}

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
  /** Authorization state of an OAuth-configured server with a live connection; absent for every other server. */
  authorization?: McpManagementAuthorization
  /** The latest explicit authorization attempt; absent until the first one starts. */
  attempt?: McpManagementAttempt
  /**
   * Provenance of the fleet entry; absent means configured in the `mcp`
   * settings namespace, `registered` means a plugin contributed it for its
   * lifetime and Settings never edits it.
   */
  source?: 'registered'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The MCP connection fleet changed: a server's connection state moved, an
     * owner mounted or unmounted, or a settings/registration change re-shaped
     * the fleet. This payload-free notification fires after each change
     * commits; consumers re-read `mcpManagement.status()` for the new rows.
     * Observer failures are contained and cannot veto the change.
     * @mode emit
     */
    'mcpManagement/fleet-changed'(): void
  }
}
