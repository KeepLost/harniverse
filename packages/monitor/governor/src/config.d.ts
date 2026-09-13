/**
 * Governor configuration: the settings.yaml `governor:` section schema and
 * the global memory-budget resolution (`auto` = 80% of the smaller of
 * physical memory and the host's own cgroup ceiling).
 * @module @deepseek-ai/dsh-governor/config
 */
import z from '@deepseek-ai/schemastery'
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
/** Runtime configuration schema (composed or from settings.yaml). */
export declare const Config: z<GovernorConfig>
/** Composed default configuration (the settings layer's base entry). */
export declare const DEFAULT_CONFIG: GovernorConfig
/** Share of the memory base the `auto` budget claims. */
export declare const AUTO_BUDGET_FRACTION = 0.8
/**
 * Resolve the global memory budget from config plus host facts.
 * @param config - effective governor config.
 * @param readMemInfo - injectable `/proc/meminfo` reader.
 * @returns the budget in bytes; a 2 GiB floor keeps enforcement meaningful
 *   when host facts are unreadable.
 */
export declare function resolveGlobalLimitBytes(config: GovernorConfig, readMemInfo?: (path: string) => Promise<string>): Promise<number>
//# sourceMappingURL=config.d.ts.map
