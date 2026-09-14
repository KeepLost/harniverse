/**
 * Pure types for the resource governor: sample shapes, quota state, breach
 * records, and overview views. No runtime code lives here.
 * @module dsh-governor/types
 */

/** Enforcement/metering capability tier the host resolved at boot. */
export type GovernorTier = 'cgroup' | 'rlimit' | 'observe'

/** Why one metered command was killed by enforcement. */
export type GovernorBreachKind = 'memory-limit' | 'session-quota'

/** One per-command sample produced by a metering tick. */
export interface ResourceSample {
  /** Tick timestamp, epoch milliseconds. */
  readonly t: number
  /** CPU used since the previous sample, in kernel clock ticks (100/s). */
  readonly cpuTicks: number
  /** Whole-tree resident memory in bytes (statm RSS sum). */
  readonly rssBytes: number
  /** Whole-tree proportional-set memory in bytes, when readable. */
  readonly pssBytes?: number
  /** Kernel block-layer disk bytes read/written since the previous sample. */
  readonly readBytes: number
  readonly writeBytes: number
  /** Open file-descriptor count for the tree (whole-process granularity). */
  readonly fdCount: number
  /** TCP bytes sent/received since the previous sample, when attributable. */
  readonly netTxBytes?: number
  readonly netRxBytes?: number
}

/** Final facts of one settled metered command. */
export interface CommandRecord {
  readonly sessionId: string
  readonly commandId: string
  readonly kind: 'shell' | 'terminal' | 'other'
  /** First-seen timestamp, epoch milliseconds. */
  readonly startedAt: number
  /** Settled timestamp, epoch milliseconds, while the record is live-settling. */
  readonly exitedAt?: number
  /** Recent samples, oldest first, bounded (the live ring). */
  readonly samples: readonly ResourceSample[]
  /** Peak whole-tree RSS observed, in bytes. */
  readonly peakRssBytes: number
  /** Cumulative CPU ticks over the observed life. */
  readonly totalCpuTicks: number
  /** Cumulative kernel disk bytes over the observed life. */
  readonly totalReadBytes: number
  readonly totalWriteBytes: number
  /** Breach that enforcement recorded for this command, if any. */
  readonly breach?: GovernorBreachRecord
}

/** One enforcement kill, kept for the tool-result merge and the board. */
export interface GovernorBreachRecord {
  readonly kind: GovernorBreachKind
  readonly sessionId: string
  readonly commandId: string
  /** Peak RSS observed at breach time, when known. */
  readonly peakBytes?: number
  /** The budget that was exceeded, when known. */
  readonly limitBytes?: number
  readonly at: number
}

/** Effective quota state of one session. */
export interface SessionQuotaState {
  readonly sessionId: string
  /** Explicit quota in bytes, when the session has one (isolation leaf). */
  readonly quotaBytes?: number
  /** The budget enforcement currently applies to this session's commands. */
  readonly effectiveLimitBytes: number
  /** True while the session rides the shared pool (no explicit quota). */
  readonly shared: boolean
}

/** One session row of the board overview. */
export interface SessionResourceRow {
  readonly sessionId: string
  /** Summed current RSS of the session's live metered commands, in bytes. */
  readonly rssBytes: number
  /** CPU ticks consumed by its commands over the last sample interval. */
  readonly cpuTicks: number
  /** Live metered command count. */
  readonly commands: number
  readonly quota: SessionQuotaState
  /** Settled breaches for this session, newest first, bounded. */
  readonly breaches: readonly GovernorBreachRecord[]
}

/** Host-level view the board renders. */
export interface GovernorOverview {
  readonly tier: GovernorTier
  /** Resolved global memory budget in bytes. */
  readonly globalLimitBytes: number
  /** Summed current RSS across ALL live metered commands. */
  readonly liveRssBytes: number
  readonly sessions: readonly SessionResourceRow[]
  /** Host filesystem free bytes for the sentinel path, when readable. */
  readonly hostFreeBytes?: number
  /** Host network counters delta over the last interval, when readable. */
  readonly hostNetRxBytes?: number
  readonly hostNetTxBytes?: number
  /** Metered sample tick, epoch milliseconds. */
  readonly t: number
}

/** Durable quota override row (the authoritative copy of one decided quota). */
export interface QuotaOverrideRecord {
  readonly sessionId: string
  /** Explicit memory quota in bytes; the row exists only for explicit quotas. */
  readonly memoryBytes: number
  readonly updatedAt: number
  /** Why the override exists (tool negotiation, board action, resume clamp). */
  readonly reason: string
}

/** Durable history row (written only when persistence is opted in). */
export interface HistoryRow {
  readonly sessionId: string
  readonly commandId: string
  readonly t: number
  readonly cpuTicks: number
  readonly rssBytes: number
  readonly readBytes: number
  readonly writeBytes: number
}

/** Public read-only shape of one tracked command. */
export interface CommandView {
  readonly sessionId: string
  readonly commandId: string
  readonly kind: 'shell' | 'terminal' | 'other'
  readonly startedAt: number
  readonly exitedAt?: number
  readonly samples: readonly ResourceSample[]
  readonly peakRssBytes: number
  readonly totalCpuTicks: number
  readonly totalReadBytes: number
  readonly totalWriteBytes: number
  readonly breach?: GovernorBreachRecord
}

/** Injectable filesystem internals for /proc readers (tests substitute fakes). */
export interface ProcInternals {
  readFile: (path: string) => Promise<string>
  readDir: (path: string) => Promise<string[]>
  readLink: (path: string) => Promise<string>
  statfs: (path: string) => Promise<{ bavail: number; bsize: number }>
}

/** Injectable knobs for the metering engine (tests substitute fakes). */
export interface SamplerOptions {
  readonly internals?: ProcInternals
  readonly now?: () => number
  readonly execSs?: (args: string[]) => string
  readonly sentinelPath?: string
  /** Session → effective limit resolver the watchdog math consults. */
  readonly effectiveLimitBytes: (sessionId: string) => number
  readonly globalLimitBytes: () => number
}

/** Global memory budget settings. */
export interface GovernorMemoryConfig {
  /** `'auto'` or an explicit byte budget. */
  limit: 'auto' | number
}

/** Sampling cadence settings. */
export interface GovernorSamplingConfig {
  /** Base cadence in milliseconds while no command is near a limit. */
  baseMs: number
  /** Tightened cadence while any session rides above 70% of its budget. */
  hotMs: number
}

/** Opt-in history persistence settings. */
export interface GovernorHistoryConfig {
  /** Opt-in persistence of history rows. */
  persist: boolean
  /** Minimum spacing between persisted rows per command. */
  resolutionMs: number
  /** Age at which persisted rows are swept. */
  retentionMs: number
}

/** Effective governor settings after schema defaults. */
export interface GovernorConfig {
  /** Global memory budget. */
  memory: GovernorMemoryConfig
  /** Sampling cadence. */
  sampling: GovernorSamplingConfig
  /** Opt-in history persistence. */
  history: GovernorHistoryConfig
}
