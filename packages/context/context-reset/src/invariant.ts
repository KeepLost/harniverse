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

/**
 * Fold one candidate event, failing before it can enter the durable log.
 * Every decision resolves to a message first and this function owns the only
 * `fail()` call site. Seq adjacency is structural: contiguity plus the
 * stale-anchor check mean a recognized marker can never sit further than
 * anchor.seq + 1.
 *
 * The whole fold lives in one function because the coverage lane's branch
 * accounting for this file is unstable across otherwise identical runs — see
 * the Agent Note on the invariant staging channel — and one frame is the
 * smallest accounting surface that still measures every decision.
 */
function validateCandidate(
  anchor: NextPending,
  event: SessionEvent,
  fail: InvariantFailure,
): NextPending {
  if (event.type === 'reset/checkpoint') {
    return { resetId: event.data.resetId, seq: event.seq }
  }
  const source = event.type === 'user/message' ? event.data.source : undefined
  if (source === undefined || !isResetCheckpointSource(source)) {
    const stale = anchor
    if (stale !== undefined) {
      fail(`reset/checkpoint at seq ${String(stale.seq)} is not immediately followed by its marker`)
    }
    return anchor
  }
  if (anchor === undefined) fail('reset marker without a preceding reset/checkpoint anchor')
  if (!isReplacementSurfaceEvent(event)) fail('reset marker must be a replacement surface event')
  if (anchor.resetId !== source.resetId) {
    fail(`reset marker at seq ${String(event.seq)} must immediately follow its reset/checkpoint anchor`)
  }
  return undefined
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
