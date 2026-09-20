/**
 * Durable age-based image offload for the model-request projection.
 *
 * Mounts the `image/offload` message projection on the session store and, at
 * every agent request boundary, resolves the configured
 * `imageOffloadAfterUserTurns` age limit against the durable log: images
 * whose later-user-turn age reached the limit are settled by one appended
 * `image/offload` event, and every later model request renders the canonical
 * offload stub in their place. Original attachments stay retained for replay
 * and authorized re-reads; display surfaces that read events directly keep
 * showing the original images.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: activates the `agent/request` Events merge the listener uses.
import type {} from '@deepseek-ai/dsh-agent'
import { COMPACTION_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-compaction-settings'
import type { CompactionSettings } from '@deepseek-ai/dsh-compaction-settings'
import { parseImageOffloadSetting, resolveImageOffloadDecisions } from '@deepseek-ai/dsh-image-offload-policy'
import type { ImageOffloadSetting } from '@deepseek-ai/dsh-image-offload-policy'
import { imageOffloadProjection } from './projection.ts'

/** Cordis plugin name. */
export const name = 'compaction-image-offload'
/** The session store owns message-projection registration. */
export const inject = ['sessions']

/**
 * Read the effective age limit: the stored compaction setting when a settings
 * provider is present, `'unlimited'` otherwise.
 * @param ctx - plugin context.
 * @returns the validated setting.
 * @throws when a stored value is neither `'unlimited'` nor a positive integer.
 */
function readSetting(ctx: Context): ImageOffloadSetting {
  const stored = ctx.get('settings')?.get(COMPACTION_SETTINGS_NAMESPACE) as CompactionSettings | undefined
  const raw = stored?.imageOffloadAfterUserTurns
  return raw === undefined ? 'unlimited' : parseImageOffloadSetting(raw)
}

/**
 * Register the projection and the request-boundary decision listener.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.sessions.registerMessageProjection(imageOffloadProjection)
  ctx.on('agent/request', ({ agent }, next) => {
    const decisions = resolveImageOffloadDecisions(agent.session.events, { setting: readSetting(ctx) })
    if (decisions.length > 0) {
      agent.session.append('image/offload', { targets: decisions.map(decision => decision.target) })
    }
    return next()
  })
}
