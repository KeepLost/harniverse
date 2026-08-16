/** Package-owned compaction log-stream invariants. @module @deepseek-ai/dsh-compaction/invariant */

import type { Context } from '@deepseek-ai/cordis'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { CompactionId } from './brand.ts'
import { isCompactCheckpointSource } from './checkpoint.ts'
import type { CompactionCheckpointSource } from './checkpoint.ts'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-compaction'

/** Cordis companion plugin name. */
export const name = 'compaction-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface CompactionTrace {
  compactionId: CompactionId
  sourceCommandId: string | undefined
  startSeq: number
  turn: number | null
  summarized: boolean
  replacementCommitted: boolean
}

interface PendingSummaryReplacement {
  kind: 'summary'
  precedingSeq: number
  compactionId: CompactionId
  sourceCommandId: string | undefined
  shadowedRange: { start: number; end: number }
  sourceEventSeqs: number[]
}

interface PendingPruneReplacement {
  kind: 'prune'
  precedingSeq: number
  shadowedRange: { start: number; end: number }
  sourceEventSeqs: number[]
}

type PendingReplacement = PendingSummaryReplacement | PendingPruneReplacement

interface SessionTrace {
  openTurn: number | null
  compaction: CompactionTrace | undefined
  pendingReplacement: PendingReplacement | undefined
}

interface SessionInvariantState {
  trace: SessionTrace
  surfaceEvents: SessionEvent[]
  surface: SurfaceManager
}

type CompactionTransition =
  | { kind: 'start'; compactionId: CompactionId; sourceCommandId: string | undefined; startSeq: number; turn: number | null }
  | {
    kind: 'summary'
    compactionId: CompactionId
    sourceCommandId: string | undefined
    startSeq: number
    summarySeq: number
    turn: number | null
    shadowedRange: { start: number; end: number }
    shadowedSeqs: number[]
  }
  | { kind: 'summary-replacement' }
  | {
    kind: 'prune'
    pruneSeq: number
    shadowedRange: { start: number; end: number }
    shadowedSeqs: number[]
  }
  | { kind: 'prune-replacement' }
  | { kind: 'end' }
  | { kind: 'end-seed' }

/** Require a durable opaque identity to be a non-empty string. */
function validateId(value: unknown, label: string, fail: InvariantFailure): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
}

/** Keep the optional initiating command identity stable across one transaction. */
function validateSourceCommandId(
  eventType: string,
  value: unknown,
  expected: string | undefined,
  fail: InvariantFailure,
): void {
  if (value !== undefined) validateId(value, `${eventType} sourceCommandId`, fail)
  if (value !== expected) {
    fail(`${eventType} sourceCommandId ${String(value)} does not match compaction/start sourceCommandId ${String(expected)}`)
  }
}

/** Validate checkpoint identity against the summary that requires it. */
function validateCheckpointSource(
  pending: PendingSummaryReplacement,
  event: SessionEvent<'user/message'>,
  fail: InvariantFailure,
): void {
  const source = event.data.source as typeof event.data.source & Partial<CompactionCheckpointSource>
  validateId(source.compactionId, 'compaction checkpoint compactionId', fail)
  if (source.sourceCommandId !== undefined) {
    validateId(source.sourceCommandId, 'compaction checkpoint sourceCommandId', fail)
  }
  if (source.compactionId !== pending.compactionId) {
    fail(`compaction checkpoint id ${source.compactionId} does not match compaction/start id ${pending.compactionId}`)
  }
  validateSourceCommandId('compaction checkpoint', source.sourceCommandId, pending.sourceCommandId, fail)
}

/** Require exact ordered provenance rather than Session's generic set inclusion. */
function validateExactSourceEventSeqs(
  eventType: string,
  actual: readonly number[] | undefined,
  expected: readonly number[],
  fail: InvariantFailure,
): void {
  if (actual === undefined
    || actual.length !== expected.length
    || actual.some((seq, index) => seq !== expected[index])) {
    fail(`${eventType} sourceEventSeqs must exactly equal [${expected.join(', ')}]`)
  }
}

/** Require the replacement operation to name the metering event's exact range. */
function validateExactRange(
  eventType: string,
  actual: { start: number; end: number },
  expected: { start: number; end: number },
  fail: InvariantFailure,
): void {
  if (actual.start !== expected.start || actual.end !== expected.end) {
    fail(`${eventType} range must exactly match the preceding ${eventType === 'compaction checkpoint' ? 'compaction/summary' : 'compaction/prune'} shadowedRange`)
  }
}

/** Validate shared summary/prune shadow metadata at its durable boundary. */
function validateShadowMetadata(
  eventType: 'compaction/summary' | 'compaction/prune',
  data: {
    shadowedRange: { start: number; end: number }
    shadowedSeqs: number[]
    shadowedTokenCount: number
  },
  surfaceNodes: readonly number[],
  fail: InvariantFailure,
): void {
  const seqs = data.shadowedSeqs
  if (!Array.isArray(seqs) || seqs.length === 0) fail(`${eventType} shadowedSeqs must be non-empty`)
  if (seqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) {
    fail(`${eventType} shadowedSeqs must contain non-negative safe integers`)
  }
  const { start, end } = data.shadowedRange
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < 0) {
    fail(`${eventType} shadowedRange endpoints must be non-negative safe integers`)
  }
  if (seqs[0] !== start || seqs.at(-1) !== end) {
    fail(`${eventType} shadowedRange must match the first and last shadowedSeqs`)
  }
  if (!Number.isSafeInteger(data.shadowedTokenCount) || data.shadowedTokenCount < 0) {
    fail(`${eventType} shadowedTokenCount must be a non-negative safe integer`)
  }
  const startIndex = surfaceNodes.indexOf(start)
  const endIndex = surfaceNodes.indexOf(end)
  const expected = startIndex < 0 || endIndex < startIndex
    ? []
    : surfaceNodes.slice(startIndex, endIndex + 1)
  if (expected.length !== seqs.length || expected.some((seq, index) => seq !== seqs[index])) {
    fail(`${eventType} shadowedSeqs must exactly match the current surface range`)
  }
}

/** Validate and discharge an immediately pending summary/prune replacement. */
function validatePendingReplacement(
  pending: PendingReplacement,
  event: SessionEvent,
  fail: InvariantFailure,
): CompactionTransition {
  const predecessor = pending.kind === 'summary' ? 'compaction/summary' : 'compaction/prune'
  if (event.seq !== pending.precedingSeq + 1) {
    fail(`${predecessor} replacement must have seq ${pending.precedingSeq + 1}`)
  }
  if (pending.kind === 'summary') {
    if (event.type !== 'user/message' || !isCompactCheckpointSource(event.data.source)) {
      fail('compaction/summary must be immediately followed by its compact checkpoint user/message replacement')
    }
    if (!isReplacementSurfaceEvent(event)) {
      fail('compaction/summary must be immediately followed by its compact checkpoint user/message replacement')
    }
    validateCheckpointSource(pending, event, fail)
    validateExactRange('compaction checkpoint', event.surfaceOp, pending.shadowedRange, fail)
    validateExactSourceEventSeqs('compaction checkpoint', event.sourceEventSeqs, pending.sourceEventSeqs, fail)
    return { kind: 'summary-replacement' }
  }
  if (event.type !== 'tool/result' || !isReplacementSurfaceEvent(event)) {
    fail('compaction/prune must be immediately followed by its tool/result replacement')
  }
  validateExactRange('compaction prune replacement', event.surfaceOp, pending.shadowedRange, fail)
  validateExactSourceEventSeqs('compaction prune replacement', event.sourceEventSeqs, pending.sourceEventSeqs, fail)
  return { kind: 'prune-replacement' }
}

/** Compaction starts still unmatched when a later seed boundary made them stale. */
function inheritedOrphanStartSeqs(
  events: readonly SessionEvent[],
): ReadonlySet<number> {
  const stale = new Set<number>()
  let openStartSeq: number | undefined
  for (const event of events) {
    if (event.type === 'compaction/start') {
      openStartSeq = event.seq
    } else if (event.type === 'compaction/end') {
      openStartSeq = undefined
    } else if (event.type === 'session/end-seed') {
      if (openStartSeq !== undefined) stale.add(openStartSeq)
      openStartSeq = undefined
    }
  }
  return stale
}

/** Keep every live compaction bracket on one side of each turn boundary. */
function validateTurnBoundary(
  trace: SessionTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  if (
    (event.type !== 'turn/start' && event.type !== 'turn/end')
    || trace.compaction === undefined
  ) return
  const owner = trace.compaction.turn === null
    ? 'standalone compaction'
    : `compaction for turn ${trace.compaction.turn}`
  fail(`${event.type} cannot cross an open ${owner}`)
}

/** Advance the committed turn cursor after its boundary has been accepted. */
function applyTurnBoundary(trace: SessionTrace, event: SessionEvent): boolean {
  if (event.type === 'turn/start') {
    trace.openTurn = event.data.turn
    return true
  }
  if (event.type === 'turn/end') {
    trace.openTurn = null
    return true
  }
  return false
}

/** Require a numbered bracket inside its exact turn, or a standalone bracket between turns. */
function validateOwner(
  owner: number | null,
  openTurn: number | null,
  eventType: 'compaction/start' | 'compaction/summary' | 'compaction/end',
  fail: InvariantFailure,
): void {
  if (owner === null) {
    if (openTurn !== null) fail(`${eventType} is standalone but turn ${openTurn} is open`)
    return
  }
  if (openTurn === null) fail(`${eventType} for turn ${owner} appended outside any open turn`)
  if (owner !== openTurn) fail(`${eventType} names turn ${owner} but open turn is ${openTurn}`)
}

/** Validate one compaction event without advancing committed trace state. */
function validateCompactionEvent(
  trace: SessionTrace,
  event: SessionEvent,
  surfaceNodes: () => readonly number[],
  fail: InvariantFailure,
): CompactionTransition | undefined {
  if (event.type === 'session/end-seed') return { kind: 'end-seed' }
  if (event.type === 'user/message' && isCompactCheckpointSource(event.data.source)) {
    fail('compaction checkpoint has no matching pending compaction/summary')
  }
  if (event.type === 'compaction/prune') {
    validateShadowMetadata(event.type, event.data, surfaceNodes(), fail)
    return {
      kind: 'prune',
      pruneSeq: event.seq,
      shadowedRange: { ...event.data.shadowedRange },
      shadowedSeqs: [...event.data.shadowedSeqs],
    }
  }
  if (event.type !== 'compaction/start' && event.type !== 'compaction/summary' && event.type !== 'compaction/end') {
    return undefined
  }
  const open = trace.compaction
  if (event.type === 'compaction/start') {
    validateId(event.data.compactionId, 'compaction/start compactionId', fail)
    if (event.data.sourceCommandId !== undefined) {
      validateId(event.data.sourceCommandId, 'compaction/start sourceCommandId', fail)
    }
    if (open !== undefined) {
      const owner = open.turn === null ? 'standalone compaction' : `turn ${open.turn}`
      fail(`compaction/start while ${owner} is still compacting`)
    }
    validateOwner(event.data.turn, trace.openTurn, event.type, fail)
    return {
      kind: 'start',
      compactionId: event.data.compactionId,
      sourceCommandId: event.data.sourceCommandId,
      startSeq: event.seq,
      turn: event.data.turn,
    }
  }
  if (event.type === 'compaction/summary') {
    validateId(event.data.compactionId, 'compaction/summary compactionId', fail)
    if (event.data.sourceCommandId !== undefined) {
      validateId(event.data.sourceCommandId, 'compaction/summary sourceCommandId', fail)
    }
    if (open === undefined) fail('compaction/summary has no matching compaction/start')
    if (event.data.compactionId !== open.compactionId) {
      fail(`compaction/summary id ${event.data.compactionId} does not match compaction/start id ${open.compactionId}`)
    }
    validateSourceCommandId('compaction/summary', event.data.sourceCommandId, open.sourceCommandId, fail)
    validateOwner(open.turn, trace.openTurn, event.type, fail)
    if (open.summarized) fail('compaction/summary repeated within one compaction')
    validateShadowMetadata(event.type, event.data, surfaceNodes(), fail)
    return {
      kind: 'summary',
      compactionId: open.compactionId,
      sourceCommandId: open.sourceCommandId,
      startSeq: open.startSeq,
      summarySeq: event.seq,
      turn: open.turn,
      shadowedRange: { ...event.data.shadowedRange },
      shadowedSeqs: [...event.data.shadowedSeqs],
    }
  }
  validateId(event.data.compactionId, 'compaction/end compactionId', fail)
  if (event.data.sourceCommandId !== undefined) {
    validateId(event.data.sourceCommandId, 'compaction/end sourceCommandId', fail)
  }
  if (open === undefined) fail('compaction/end has no matching compaction/start')
  if (event.data.compactionId !== open.compactionId) {
    fail(`compaction/end id ${event.data.compactionId} does not match compaction/start id ${open.compactionId}`)
  }
  validateSourceCommandId('compaction/end', event.data.sourceCommandId, open.sourceCommandId, fail)
  if (event.data.turn !== open.turn) {
    fail(`compaction/end owner ${String(event.data.turn)} does not match compaction/start owner ${String(open.turn)}`)
  }
  validateOwner(open.turn, trace.openTurn, event.type, fail)
  if (event.data.error === undefined && !open.replacementCommitted) {
    fail('successful compaction/end requires one compaction/summary replacement to commit')
  }
  return { kind: 'end' }
}

/** Apply one committed compaction transition. */
function applyCompactionTransition(
  trace: SessionTrace,
  transition: CompactionTransition,
): void {
  if (transition.kind === 'start') {
    trace.compaction = {
      compactionId: transition.compactionId,
      sourceCommandId: transition.sourceCommandId,
      startSeq: transition.startSeq,
      turn: transition.turn,
      summarized: false,
      replacementCommitted: false,
    }
    return
  }
  if (transition.kind === 'summary') {
    trace.compaction = {
      compactionId: transition.compactionId,
      sourceCommandId: transition.sourceCommandId,
      startSeq: transition.startSeq,
      turn: transition.turn,
      summarized: true,
      replacementCommitted: false,
    }
    trace.pendingReplacement = {
      kind: 'summary',
      precedingSeq: transition.summarySeq,
      compactionId: transition.compactionId,
      sourceCommandId: transition.sourceCommandId,
      shadowedRange: transition.shadowedRange,
      sourceEventSeqs: [transition.startSeq, transition.summarySeq, ...transition.shadowedSeqs],
    }
    return
  }
  if (transition.kind === 'summary-replacement') {
    /* v8 ignore next -- a staged summary replacement always retains its open trace. */
    if (trace.compaction === undefined) throw new Error('compaction summary replacement lost its open trace')
    trace.compaction.replacementCommitted = true
    trace.pendingReplacement = undefined
    return
  }
  if (transition.kind === 'prune') {
    trace.pendingReplacement = {
      kind: 'prune',
      precedingSeq: transition.pruneSeq,
      shadowedRange: transition.shadowedRange,
      sourceEventSeqs: transition.shadowedSeqs,
    }
    return
  }
  if (transition.kind === 'prune-replacement') {
    trace.pendingReplacement = undefined
    return
  }
  trace.compaction = undefined
}

/** Install compaction start/summary/end checks. */
// Event owners keep precommit staging local so their vocabularies never move into a central helper.
/* jscpd:ignore-start */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, SessionInvariantState>()
  const staged = new WeakMap<SessionEvent, { session: Session; transition: CompactionTransition }>()
  const seed = (session: Session): SessionInvariantState => {
    const trace: SessionTrace = { openTurn: null, compaction: undefined, pendingReplacement: undefined }
    const surfaceEvents: SessionEvent[] = []
    const state: SessionInvariantState = { trace, surfaceEvents, surface: new SurfaceManager(surfaceEvents) }
    states.set(session, state)
    const staleOrphanStartSeqs = inheritedOrphanStartSeqs(session.events)
    for (const event of session.events) {
      // Constructor-seed repair boundaries can precede the end-seed marker
      // that proves an inherited orphan stale. Replay that inherited prefix
      // without letting the soon-to-be-cleared bracket veto its repair.
      if (trace.pendingReplacement !== undefined) {
        const transition = validatePendingReplacement(trace.pendingReplacement, event, fail)
        applyCompactionTransition(trace, transition)
      } else {
        if (
          trace.compaction === undefined
          || !staleOrphanStartSeqs.has(trace.compaction.startSeq)
        ) {
          validateTurnBoundary(trace, event, fail)
        }
        const transition = validateCompactionEvent(
          trace,
          event,
          () => state.surface.nodes,
          fail,
        )
        if (transition !== undefined) applyCompactionTransition(trace, transition)
      }
      applyTurnBoundary(trace, event)
      surfaceEvents.push(event)
    }
    return state
  }
  const stateFor = (session: Session): SessionInvariantState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    const state = stateFor(session)
    const trace = state.trace
    state.surfaceEvents.push(event)
    validateTurnBoundary(trace, event, fail)
    if (applyTurnBoundary(trace, event)) return
    const candidate = staged.get(event)
    if (candidate === undefined || candidate.session !== session) {
      const checkpoint = event.type === 'user/message' && isCompactCheckpointSource(event.data.source)
      if (trace.pendingReplacement !== undefined
        || checkpoint
        || event.type === 'session/end-seed'
        || event.type === 'compaction/start'
        || event.type === 'compaction/summary'
        || event.type === 'compaction/end'
        || event.type === 'compaction/prune') {
        return fail('compaction event published without pre-commit validation')
      }
      return
    }
    staged.delete(event)
    applyCompactionTransition(trace, candidate.transition)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const state = stateFor(session)
    const trace = state.trace
    const transition = trace.pendingReplacement === undefined
      ? validateCompactionEvent(trace, event, () => state.surface.nodes, fail)
      : validatePendingReplacement(trace.pendingReplacement, event, fail)
    if (trace.pendingReplacement === undefined) validateTurnBoundary(trace, event, fail)
    if (transition !== undefined) staged.set(event, { session, transition })
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the compact invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
