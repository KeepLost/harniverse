/** Package-owned session-event invariants for image offload. @module @deepseek-ai/dsh-image-offload-policy/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-image-offload-policy'

/** Cordis companion plugin name. */
export const name = 'image-offload-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Count image blocks of one surface event, 0 for events that carry none. */
function imageCountOf(event: SessionEvent): number {
  const blocks: readonly ContentBlock[] = event.type === 'user/message'
    ? event.data.content
    : event.type === 'tool/result'
      ? event.data.message.content[0].content
      : []
  let count = 0
  for (const block of blocks) {
    if (block.type === 'image') count += 1
  }
  return count
}

/**
 * Validate one `image/offload` event against the log before it: every target
 * must name an earlier surface event that exists and carries enough image
 * blocks, and must not repeat a target an earlier offload already settled.
 */
function validateEvent(prior: SessionEvent[], event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'image/offload') return
  const settled = new Set<string>()
  const key = (messageSeq: number, imageIndex: number): string => `${messageSeq}#${imageIndex}`
  for (const priorEvent of prior) {
    if (priorEvent.type !== 'image/offload') continue
    for (const target of priorEvent.data.targets) settled.add(key(target.messageSeq, target.imageIndex))
  }
  const seen = new Set<string>()
  for (const target of event.data.targets) {
    const carrier = prior.find(candidate => candidate.seq === target.messageSeq)
    if (carrier === undefined) {
      fail(`image/offload targets seq ${target.messageSeq}, which no earlier event carries`)
      continue
    }
    if (target.imageIndex < 0 || target.imageIndex >= imageCountOf(carrier)) {
      fail(`image/offload target (${target.messageSeq}, ${target.imageIndex}) names no image block of its carrier event`)
    }
    const identity = key(target.messageSeq, target.imageIndex)
    if (seen.has(identity)) fail(`image/offload repeats target (${target.messageSeq}, ${target.imageIndex}) in one event`)
    seen.add(identity)
    if (settled.has(identity)) fail(`image/offload re-settles target (${target.messageSeq}, ${target.imageIndex}) an earlier offload already recorded`)
  }
}

/** Install validation for loaded and newly appended offload events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    const prior: SessionEvent[] = []
    for (const event of session.events) {
      validateEvent(prior, event, fail)
      prior.push(event)
    }
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = (args as [Session, SessionEvent])
    validateEvent(session.events.filter(candidate => candidate.seq < event.seq), event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
