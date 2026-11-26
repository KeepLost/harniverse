/**
 * Public wire types for the MCP client bridge: probe results cross the
 * `mcpManagement` Remote boundary, so they live in this exportable types
 * module rather than the root face. Self-contained string unions and rows:
 * nothing here reaches into another package's type surface.
 * @module
 */


/** Read and write face of the credentials seam (structural: this package does not depend on the credentials package). */
export interface McpOAuthCredentialStore {
  /**
   * Read one reference's current value.
   * @param ref - Reference to resolve.
   * @returns The stored value, or `undefined` while nothing is stored.
   */
  resolve(ref: string): Promise<{ readonly value: string } | undefined>
  /**
   * Durably store one value under a reference.
   * @param ref - Reference to store under.
   * @param value - Non-empty value.
   */
  set(ref: string, value: string): Promise<void>
  /**
   * Remove one reference; removing an absent reference is a no-op.
   * @param ref - Reference to remove.
   */
  unset(ref: string): Promise<void>
}

/** Options for one probeServer call. */
export interface McpProbeOptions {
  /** Budget for the whole probe (connect + listing) in milliseconds; default 10000. */
  readonly timeoutMs?: number
  /** Maximum listing pages before returning a truncated result; default 16. */
  readonly maxPages?: number
  /** Maximum raw tool names retained in the result; default 512. */
  readonly maxToolNames?: number
  /**
   * Abort the in-flight probe; settles as a failure at the current stage after
   * bounded closure.
   */
  readonly signal?: AbortSignal
  /**
   * Credentials seam an OAuth-configured entry's probe reads its stored grant
   * through. The probe attaches that grant when one is stored and never
   * starts an authorization; without a store the probe reports the missing
   * grant as a connect failure.
   */
  readonly oauth?: McpOAuthCredentialStore
}

/** Stage a probe failure is classified under. */
export type McpProbeStage = 'connect' | 'list'

/** Server identity a probe read before listing. */
export interface McpProbeServerInfo {
  readonly name: string
  readonly version: string
}

/** A probe that reached the end of its listing. */
export interface McpProbeSuccess {
  readonly ok: true
  /** The server's reported identity; absent when the wire omitted it. */
  readonly serverInfo?: McpProbeServerInfo
  /** Raw tool names in server order, capped to McpProbeOptions.maxToolNames. */
  readonly toolNames: readonly string[]
  /** True when caps ended the listing early. */
  readonly truncated: boolean
  readonly durationMs: number
}

/** A probe that failed at a classified stage; the message renders on management surfaces. */
export interface McpProbeFailure {
  readonly ok: false
  readonly stage: McpProbeStage
  readonly message: string
  readonly durationMs: number
}

/** Outcome of closing the probe's client after the stage settled. */
export interface McpProbeCleanup {
  readonly cleanup: 'ok' | 'failed'
  /** Diagnostic for a failed closure; absent on success. */
  readonly cleanupError?: string
}

/** Stage-classified probe outcome with independently settled cleanup. */
export type McpProbeResult = (McpProbeSuccess | McpProbeFailure) & McpProbeCleanup
