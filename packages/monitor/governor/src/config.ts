/**
 * Governor configuration: the settings.yaml `governor:` section schema and
 * the global memory-budget resolution (`auto` = 80% of the smaller of
 * physical memory and the host's own cgroup ceiling).
 * @module @deepseek-ai/dsh-governor/config
 */

import z from '@deepseek-ai/schemastery'
import type { GovernorConfig } from './types.ts'
import { readHostMemory } from './proc.ts'

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

/** Runtime configuration schema (composed or from settings.yaml). */
export const Config: z<GovernorConfig> = z.object({
  memory: z.object({
    limit: z.union(['auto', z.number()]).default('auto'),
  }).default({ limit: 'auto' }),
  sampling: z.object({
    baseMs: z.number().default(5_000),
    hotMs: z.number().default(1_000),
  }).default({ baseMs: 5_000, hotMs: 1_000 }),
  history: z.object({
    persist: z.boolean().default(false),
    resolutionMs: z.number().default(5_000),
    retentionMs: z.number().default(7 * 24 * 3600 * 1000),
  }).default({ persist: false, resolutionMs: 5_000, retentionMs: 7 * 24 * 3600 * 1000 }),
})

/** Composed default configuration (the settings layer's base entry). */
export const DEFAULT_CONFIG: GovernorConfig = {
  memory: { limit: 'auto' },
  sampling: { baseMs: 5_000, hotMs: 1_000 },
  history: { persist: false, resolutionMs: 5_000, retentionMs: 7 * 24 * 3600 * 1000 },
}

/** Share of the memory base the `auto` budget claims. */
export const AUTO_BUDGET_FRACTION = 0.8

/**
 * Resolve the global memory budget from config plus host facts.
 * @param config - effective governor config.
 * @param readMemInfo - injectable `/proc/meminfo` reader.
 * @returns the budget in bytes; a 2 GiB floor keeps enforcement meaningful
 *   when host facts are unreadable.
 */
export async function resolveGlobalLimitBytes(
  config: GovernorConfig,
  readMemInfo?: (path: string) => Promise<string>,
): Promise<number> {
  if (config.memory.limit !== 'auto') {
    return Number.isFinite(config.memory.limit) && config.memory.limit > 0 ? config.memory.limit : fallbackBudget()
  }
  const memory = await readHostMemory(readMemInfo)
  if (memory === undefined) return fallbackBudget()
  const base = memory.ownCgroupMaxBytes === undefined
    ? memory.memTotalBytes
    : Math.min(memory.memTotalBytes, memory.ownCgroupMaxBytes)
  return Math.floor(base * AUTO_BUDGET_FRACTION)
}

/** Floor budget used when host memory facts are unavailable. */
function fallbackBudget(): number {
  return Math.floor(2 * 1024 * 1024 * 1024 * AUTO_BUDGET_FRACTION)
}
