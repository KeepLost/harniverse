/**
 * Root-owned settings contract for the execution world: the `exec-world`
 * namespace (`$DSH_HOME/settings.yaml`, restart-applied) selecting the
 * host-local capability family (default) or the VM family the host composes.
 * The app boot bridge reads the resolved preference once per start, probes the
 * VM provider when `vm` is preferred, and publishes `$DSH_EXEC_WORLD`, which
 * the capability-provider rows' `disabled` expressions consume; a `vm`
 * preference on a host without a healthy provider degrades to `local`.
 * @module @deepseek-ai/dsh-exec-world-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ExecWorldPreference } from '@deepseek-ai/dsh-vm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace read once per start; changes apply on restart. */
export const EXEC_WORLD_SETTINGS_NAMESPACE = settingsNamespace('exec-world')

/** Stored exec-world settings; every field is optional over the schema defaults. */
export interface ExecWorldSettings {
  /** Capability family the host composes; `vm` degrades to `local` without a healthy provider. */
  world?: ExecWorldPreference
}

/** Stored exec-world settings schema. */
export const Config: z<ExecWorldSettings> = z.object({
  world: z.union([z.const('local'), z.const('vm')]),
})

/** Resolved defaults applied under the user layer. */
const BASE: ExecWorldSettings = { world: 'local' }

/** Cordis plugin name. */
export const name = 'exec-world-settings'

/** The settings provider owns persistence and hot reload; consumers re-read per start. */
export const inject = ['settings']

/**
 * Register the process-wide exec-world namespace. The composition itself
 * reads the resolved preference only through the boot bridge
 * (`$DSH_EXEC_WORLD`), so a committed change applies on the next start
 * (the namespace declares `applies: 'restart'`).
 * @param ctx - host context carrying the settings provider.
 * @param config - composition `base` layer over the schema defaults.
 */
export function apply(ctx: Context, config: ExecWorldSettings = {}): void {
  ctx.settings.register(EXEC_WORLD_SETTINGS_NAMESPACE, Config, {
    applies: 'restart',
    base: { ...BASE, ...config },
  })
}
