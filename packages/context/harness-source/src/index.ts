/**
 * Checkout-root prompt context for the Harniverse implementation location.
 *
 * @module @deepseek-ai/dsh-harness-source
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'harness-source'

/** The system-prompt service whose contexts plane this plugin extends. */
export const inject = ['systemPrompt']

/** Prompt-context name the checkout-root paragraph registers under. */
export const HARNESS_SOURCE_CONTEXT = 'harness:source'

/** This checkout's root, from this package's source or built entry (four hops up from src/ or lib/). */
export const HARNESS_SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * Register the `harness:source` prompt context at order −99, immediately
 * before `app:web-surface` (−98) in compositions that mount both: a single
 * paragraph naming this checkout's root, stating that the checkout location
 * and the current working directory are separate values, and scoping the
 * checkout to inspecting or extending Harniverse itself. The DSH relationship
 * and third-party disclaimer live in the fixed order −100 harness identity
 * opener of `dsh-system-prompt`, not here.
 * @param ctx - plugin context carrying the systemPrompt service.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.context({
    name: HARNESS_SOURCE_CONTEXT,
    order: -99,
    text: `The Harniverse implementation checkout is at ${HARNESS_SOURCE_ROOT}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend Harniverse itself.`,
  })
}
