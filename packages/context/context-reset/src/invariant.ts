/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-context-reset`.
 * @module @deepseek-ai/dsh-context-reset/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ResetId } from './brand.ts'
import type { ResetCheckpointSource } from './checkpoint.ts'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-context-reset'

/** Cordis companion plugin name. */
export const name = 'context-reset-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Fail unless the marker carries the anchor issued for this reset. */
function requireAnchor(anchor: PendingReset | undefined, fail: InvariantFailure): asserts anchor is PendingReset {
  if (anchor === undefined) fail('reset marker without a preceding reset/checkpoint anchor')
}

/** Fail unless the marker event rewinds the surface (a full-history replacement). */
function requireReplacement(event: SessionEvent<'user/message'>, fail: InvariantFailure): void {
  if (!isReplacementSurfaceEvent(event)) {
    fail('reset marker must be a replacement surface event')
  }
}

/**
 * Fail unless the marker speaks for the pending anchor. Seq adjacency is
 * structural: contiguity plus the stale-pending guard mean a recognized
 * marker can never sit further than anchor.seq + 1.
 */
function requireAnchorIdentity(
  anchor: PendingReset,
  source: ResetCheckpointSource,
  seq: number,
  fail: InvariantFailure,
): void {
  if (anchor.resetId !== source.resetId) {
    fail(`reset marker at seq ${String(seq)} must immediately follow its reset/checkpoint anchor`)
  }
}

/** Fail when a pending anchor is not followed immediately by its marker. */
function requirePendingMarker(stale: PendingReset | undefined, fail: InvariantFailure): void {
  if (stale !== undefined) {
    fail(`reset/checkpoint at seq ${String(stale.seq)} is not immediately followed by its marker`)
  }
}

/** Local reset-marker shape guard (inline: the invariant bundle shares no runtime module with the service entry). */
function isResetCheckpointSource(source: unknown): source is ResetCheckpointSource {
  /* v8 ignore next 2 -- the session envelope guarantees an object source with a string kind before events reach listeners */
  if (typeof source !== 'object' || source === null) return false
  const candidate = source as { kind?: unknown; plugin?: unknown; resetId?: unknown }
  return candidate.kind === 'plugin' && candidate.plugin === 'reset' && typeof candidate.resetId === 'string'
}

/** One durable anchor awaiting its immediately following marker. */
interface PendingReset {
  readonly resetId: ResetId
  readonly seq: number
}

/** The pending-anchor state a validated candidate event leaves behind. */
type NextPending = PendingReset | undefined

/** Fold one candidate event, failing before it can enter the durable log. */
function validateCandidate(
  anchor: NextPending,
  event: SessionEvent,
  fail: InvariantFailure,
): NextPending {
  if (event.type === 'reset/checkpoint') {
    return { resetId: event.data.resetId, seq: event.seq }
  }
  if (event.type === 'user/message' && isResetCheckpointSource(event.data.source)) {
    requireAnchor(anchor, fail)
    requireReplacement(event, fail)
    requireAnchorIdentity(anchor, event.data.source, event.seq, fail)
    return undefined
  }
  requirePendingMarker(anchor, fail)
  return anchor
}

/**
 * Assert the durable correlation between `reset/checkpoint` anchors and the
 * replacement `user/message` markers that must follow them immediately.
 * Validation runs on `internal/dispatch`, before the candidate joins the log,
 * so a violation rejects the append instead of reaching observe-only
 * publication where listener throws are contained.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure): void => {
  const pending = new WeakMap<Session, PendingReset>()
  const staged = new WeakMap<SessionEvent, { session: Session; next: NextPending }>()

  const seed = (session: Session): void => {
    let anchor: NextPending
    for (const event of session.events) anchor = validateCandidate(anchor, event, fail)
    if (anchor === undefined) pending.delete(session)
    else pending.set(session, anchor)
  }

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    staged.set(event, { session, next: validateCandidate(pending.get(session), event, fail) })
  }, { global: true })
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching reset-marker validation')
    }
    staged.delete(event)
    if (candidate.next === undefined) pending.delete(session)
    else pending.set(session, candidate.next)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
