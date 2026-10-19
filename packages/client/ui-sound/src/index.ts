/**
 * Host registration for browser sound-notification preferences: one settings
 * namespace (`ui-sound`) whose section carries the master switch, the
 * per-event sound values, and their volumes.
 * @module @deepseek-ai/dsh-client-ui-sound
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SOUND_SETTINGS_NAMESPACE, SoundSettingsSchema } from './sound-settings.ts'

/**
 * Register the durable sound section when a settings provider exists.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(SOUND_SETTINGS_NAMESPACE),
      SoundSettingsSchema,
    )
  })
}
