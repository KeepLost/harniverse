/** Finding importance, ordered from informational to actionable failure. */
export type PluginDiagnosticSeverity = 'info' | 'warning' | 'error'

/** Runtime domain that owns the observed fact. */
export type PluginDiagnosticDomain =
  | 'host-loader'
  | 'standing-preset'
  | 'dynamic-cordis'
  | 'diagnostic-check'

/** One non-mutating diagnostic observation. */
export interface PluginDiagnosticFinding {
  /** Stable check that produced the finding. */
  readonly checkId: string
  /** Stable reason within the owning check. */
  readonly code: string
  readonly severity: PluginDiagnosticSeverity
  readonly domain: PluginDiagnosticDomain
  /** Human-readable observation without secrets or executable instructions. */
  readonly message: string
  /** Human-readable diagnostic address; never accepted as a mutation identity. */
  readonly path?: string
  /** Textual operator guidance; never an executable repair. */
  readonly fixHint?: string
}

/** Point-in-time result from every registered check. */
export interface PluginDiagnosticReport {
  /** Epoch milliseconds sampled after all checks settle. */
  readonly observedAt: number
  readonly checksRun: number
  readonly findings: readonly PluginDiagnosticFinding[]
}
