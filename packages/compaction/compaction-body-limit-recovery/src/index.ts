/**
 * Request-body size-limit (HTTP 413) recovery on the agent loop's
 * request-error extension point: when a provider rejects the request envelope
 * at a transport size limit — image-heavy sessions accumulate there even with
 * per-image compression — settle EVERY retained image occurrence into the
 * durable offload stubs, compact the surface, and retry the rejected request
 * from the reduced history. An identical retry cannot succeed, so recovery
 * shrinks the request first; the images stay retained for replay and
 * authorized re-reads.
 *
 * ponytail: this is the temporary measure for 413 body limits. The upgrade
 * path is request-size budgeting that keeps images out of envelopes near the
 * limit before they leave (age limits already exist under the `compaction`
 * settings namespace); remove this package when that lands.
 * @module @deepseek-ai/dsh-compaction-body-limit-recovery
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { REQUEST_BODY_TOO_LARGE_CODE, isRequestBodyTooLargeError } from '@deepseek-ai/dsh-llm'
import { resolveImageOffloadDecisions } from '@deepseek-ai/dsh-image-offload-policy'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'

/** Cordis plugin name. */
export const name = 'compaction-body-limit-recovery'

/** No injected services: compaction is read optionally at recovery time. */
export type Config = Readonly<Record<string, never>>

/**
 * Recoveries allowed per session between successful responses. Bounded so a
 * non-image envelope (a single giant tool result, for example) surfaces its
 * original error instead of looping.
 */
const MAX_RECOVERIES = 3

/**
 * Register the body-limit recovery listener. Non-body-limit failures pass
 * through untouched; a recovery that cannot shrink anything (no images, no
 * compactable range) preserves the original error the same way.
 * @param ctx - plugin context carrying the agent loop's request-error event.
 */
export function apply(ctx: Context): void {
  const recoveries = new WeakMap<object, number>()

  // A successful response proves the reduced envelope fits; a fresh sequence
  // may recover again later in the same session.
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type === 'assistant/message') recoveries.delete(session)
  })

  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (failure.code !== REQUEST_BODY_TOO_LARGE_CODE && !isRequestBodyTooLargeError(failure.message)) return next()
    if (signal.aborted) return next()
    const used = recoveries.get(agent.session) ?? 0
    if (used >= MAX_RECOVERIES) return next()

    // Settle every retained image occurrence regardless of age: pressure
    // takes the oldest still-active occurrences, and an unbounded demand
    // takes them all. Settled occurrences render the truthful offload stub.
    const generation = agent.session.surface.replaceGeneration
    const decisions = resolveImageOffloadDecisions(agent.session.events, {
      setting: 'unlimited',
      pressureCount: Number.POSITIVE_INFINITY,
    })
    if (decisions.length > 0) {
      agent.session.append('image/offload', { targets: decisions.map(decision => decision.target) })
    }

    // Compact the text surface. A failed compaction still leaves the image
    // reduction durable — the retry decision below reads every landed
    // reduction, not this call's outcome.
    let compacted = false
    const compaction = ctx.get('compaction')
    if (compaction !== undefined) {
      try {
        compacted = await compaction.compactIfNeeded(agent, 'context-overflow', signal) !== null
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`body-limit recovery: compaction failed (${message}); retrying from whatever reduction landed`)
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
    if (signal.aborted) return next()
    // A compaction that threw mid-flight may still have appended events; that
    // partial reduction is durable retry proof even without a returned result.
    const reduced = decisions.length > 0 || compacted || agent.session.surface.replaceGeneration > generation
    if (!reduced) return next()
    recoveries.set(agent.session, used + 1)
    ctx.logger.warn(
      'body-limit recovery: request rejected at the transport size limit; '
      + `settled ${decisions.length} image occurrence(s) and compacted the surface; retrying`,
    )
    return { kind: 'retry' }
  })
}
