/**
 * Root-owned settings contract for the Windows shell backend: the
 * `shell-backend` namespace (`$DSH_HOME/settings.yaml`, restart-applied)
 * selecting PowerShell (platform default) or Git Bash as the shell family the
 * host composes on Windows. The app boot bridge reads the resolved preference
 * once per start and publishes it as `$DSH_SHELL_BACKEND`, which the shell
 * rows' `disabled` expressions consume; off win32 the preference is inert.
 * @module @deepseek-ai/dsh-shell-backend-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ShellBackendPreference } from '@deepseek-ai/dsh-shell'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace read once per start; changes apply on restart. */
export const SHELL_BACKEND_SETTINGS_NAMESPACE = settingsNamespace('shell-backend')

/** Stored shell-backend settings; every field is optional over the schema defaults. */
export interface ShellBackendSettings {
  /** Shell family the host composes on Windows; inert elsewhere. */
  backend?: ShellBackendPreference
}

/** Stored shell-backend settings schema. */
export const Config: z<ShellBackendSettings> = z.object({
  backend: z.union([z.const('platform-default'), z.const('git-bash')]),
})

/** Resolved defaults applied under the user layer. */
const BASE: ShellBackendSettings = { backend: 'platform-default' }

/** Cordis plugin name. */
export const name = 'shell-backend-settings'
/** The settings provider owns persistence and hot reload; consumers re-read per start. */
export const inject = ['settings']

/**
 * Register the process-wide shell-backend namespace. The composition itself
 * reads the resolved preference only through the boot bridge
 * (`$DSH_SHELL_BACKEND`), so a committed change applies on the next start
 * (the namespace declares `applies: 'restart'`).
 * @param ctx - host context carrying the settings provider.
 * @param config - composition `base` layer over the schema defaults.
 */
export function apply(ctx: Context, config: ShellBackendSettings = {}): void {
  ctx.settings.register(SHELL_BACKEND_SETTINGS_NAMESPACE, Config, {
    applies: 'restart',
    base: { ...BASE, ...config },
  })
}
