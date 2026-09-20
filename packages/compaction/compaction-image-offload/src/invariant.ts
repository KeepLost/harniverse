/** Package-owned durable image-offload invariants. @module @deepseek-ai/dsh-compaction-image-offload/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { imageCarrier } from './project-message.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-compaction-image-offload'

/** Cordis companion plugin name. */
export const name = 'compaction-image-offload-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Whether a runtime value is a non-negative safe integer index or seq. */
function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate one durable offload decision against the log it was appended to.
 *
 * The structural facts — payload shape, earlier-seq references, image-bearing
 * event kinds, image-index bounds — are replayable from the log alone, so the
 * companion re-asserts them for loaded and newly appended events. Whether a
 * target is still a current surface node is deliberately NOT checked: a later
 * compaction replacement may legitimately shadow it.
 */
function validateOffload(event: SessionEvent, events: readonly SessionEvent[], fail: InvariantFailure): void {
  if (event.type !== 'image/offload') return
  const { targets } = event.data
  if (!Array.isArray(targets) || targets.length === 0) {
    fail('image/offload data must carry a nonempty targets array')
    return
  }
  const seen = new Set<string>()
  for (const target of targets) {
    const { messageSeq, imageIndex } = target as { messageSeq?: unknown; imageIndex?: unknown }
    if (!isIndex(messageSeq) || !isIndex(imageIndex)) {
      fail('image/offload targets must carry non-negative safe-integer messageSeq and imageIndex')
      continue
    }
    const key = `${messageSeq}:${imageIndex}`
    if (seen.has(key)) fail(`image/offload duplicate target ${key}`)
    seen.add(key)
    if (messageSeq >= event.seq) {
      fail(`image/offload target seq ${messageSeq} must reference an earlier event`)
      continue
    }
    const source = events[messageSeq]
    if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
      fail(`image/offload target seq ${messageSeq} must reference a user/message or tool/result event`)
      continue
    }
    const images = imageCarrier(source)?.filter(block => block.type === 'image').length ?? 0
    if (imageIndex >= images) fail(`image/offload image index ${imageIndex} does not exist on event ${messageSeq}`)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, events: readonly SessionEvent[], fail: InvariantFailure): void {
  validateOffload(event, events, fail)
}

/** Install validation for loaded and newly appended offload decisions. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, session.events, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(event, session.events, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the image-offload invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
