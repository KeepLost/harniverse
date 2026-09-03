/** Root-owned settings contract for shared compaction policy overrides. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace read by compaction providers at decision boundaries. */
export const COMPACTION_SETTINGS_NAMESPACE = settingsNamespace('compaction')

/** Optional user overrides shared by every Agent Profile. */
export interface CompactionSettings {
  /** Automatic pressure threshold as a context-window ratio. */
  thresholdRatio?: number
}

/** Stored compaction settings schema. */
export const Config: z<CompactionSettings> = z.object({
  thresholdRatio: z.number().min(0.17).max(1).step(0.01),
})

/** Cordis plugin name. */
export const name = 'compaction-settings'
/** The namespace is registered only while a settings provider is available. */
export const inject = ['settings']

/** Register the process-wide compaction settings namespace. */
export function apply(ctx: Context, config: CompactionSettings = {}): void {
  ctx.settings.register(COMPACTION_SETTINGS_NAMESPACE, Config, {
    applies: 'live',
    base: config,
  })
}
