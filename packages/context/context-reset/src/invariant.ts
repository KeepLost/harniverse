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
function requirePendingMarker(
  session: Session,
  pending: WeakMap<Session, PendingReset>,
  fail: InvariantFailure,
): void {
  const stale = pending.get(session)
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

/**
 * Assert the durable correlation between `reset/checkpoint` anchors and the
 * replacement `user/message` markers that must follow them immediately.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  const pending = new WeakMap<Session, PendingReset>()

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'reset/checkpoint') {
      pending.set(session, { resetId: event.data.resetId, seq: event.seq })
      return
    }
    if (event.type === 'user/message' && isResetCheckpointSource(event.data.source)) {
      const anchor = pending.get(session)
      pending.delete(session)
      requireAnchor(anchor, fail)
      requireReplacement(event, fail)
      requireAnchorIdentity(anchor, event.data.source, event.seq, fail)
      return
    }
    requirePendingMarker(session, pending, fail)
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
