/**
 * The notification event consumer: one supplementary mux subscription whose
 * `session/notify` frames — the occurrences the host detected once centrally
 * and routed to the page that adopted the session — fold into sound events.
 * The host owns detection and arbitration (one owner page per session, no
 * delivery without one); this watcher only refines each received occurrence
 * (subagent channel and plan-review classification read the local sessions
 * list) and hands it to the playback decision. Stream lifecycle machinery —
 * reopen backoff and the carrier breaker — stays here.
 */

import type { MuxFrame, RpcRequest, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SoundChannel, SoundEventKind } from '../sound-settings.ts'

/** One detected notification occurrence handed to the consumer. */
export interface SoundEventOccurrence {
  /** Which of the event kinds rang. */
  readonly kind: SoundEventKind
  /** Dedupe key shared by every frame of this occurrence. */
  readonly sourceKey: string
  /** Routing channel derived from the event's origin. */
  readonly channel: SoundChannel
  /** Session the occurrence belongs to (the quiet-current check reads it). */
  readonly sessionId: SessionId
}

/** Narrow sessions-list read face the watcher needs. */
export interface WatcherSessionsFace {
  /** Current list snapshot (rows, current selection, subagent origins). */
  getSnapshot(): SessionListState
}

/** Stream opener; undefined marks the transport as unsupported. */
export type WatcherStreamOpener<F> = () => AsyncIterable<RpcRequest<F>> | undefined

/** Constructor-injectable capabilities. */
export interface SoundWatcherDeps {
  /** Sessions list read face. */
  readonly sessions: WatcherSessionsFace
  /** Opens a fresh mux stream subscription. */
  readonly openMux: WatcherStreamOpener<MuxFrame>
  /** Receives every routed occurrence. */
  readonly onEvent: (event: SoundEventOccurrence) => void
  /** Timer injectable for tests (reopen backoff). */
  readonly schedule: (fn: () => void, ms: number) => unknown
  /** Timer canceller paired with {@link SoundWatcherDeps.schedule}. */
  readonly cancel: (timer: unknown) => void
  /** Fired once when the carrier keeps closing freshly opened streams; the watcher is already disposed when it runs. */
  readonly onCarrierLost: () => void
}

/** Reopen backoff: base delay and growth ceiling. */
const REOPEN_BASE_MS = 800
const REOPEN_MAX_MS = 30_000

/** Carrier breaker: consecutive immediate zero-event closes that retire the generation. */
const TRIP_STRIKES = 2
const IMMEDIATE_END_MS = 5_000

/** One `session/notify` frame's payload view. */
type NotifyFrame = Extract<MuxFrame, { type: 'session/notify' }>

/**
 * The frame-level occurrence consumer.
 */
export class SoundWatcher {
  private disposed = false
  private readonly timers = new Set<unknown>()

  /**
   * @param deps - sessions face, stream opener, event sink, timers.
   */
  constructor(private readonly deps: SoundWatcherDeps) {}

  /** Start the stream loop (call once per watcher). */
  start(): void {
    void this.runMuxLoop()
  }

  /** Retire on a closing carrier (owned-Host drain): reopen loops would starve its quiet close. */
  private trip(): void {
    this.dispose()
    this.deps.onCarrierLost()
  }

  /** Whether disposal already ran (a method read defeats boolean narrowing). */
  private isDisposed(): boolean {
    return this.disposed
  }

  /** Stop the loop, cancel pending timers. */
  dispose(): void {
    this.disposed = true
    for (const timer of [...this.timers]) this.deps.cancel(timer)
    this.timers.clear()
  }

  /** The mux loop: subscribe, fold notify frames, reopen with backoff after breaks. */
  private async runMuxLoop(): Promise<void> {
    let delay = REOPEN_BASE_MS
    let strikes = 0
    while (!this.disposed) {
      const stream = this.deps.openMux()
      if (stream === undefined || typeof stream[Symbol.asyncIterator] !== 'function') return
      const openedAt = Date.now()
      let envelopes = 0
      try {
        for await (const envelope of stream) {
          if (this.isDisposed()) return
          envelopes += 1
          delay = REOPEN_BASE_MS
          this.handleMux(envelope)
        }
      } catch {
        /* stream break: connection loss or transport teardown; reopen below */
      }
      strikes = this.countStrike(strikes, envelopes, openedAt)
      if (strikes >= TRIP_STRIKES) {
        this.trip()
        return
      }
      await this.wait(delay)
      if (this.isDisposed()) return
      delay = Math.min(delay * 2, REOPEN_MAX_MS)
    }
  }

  /** One immediate zero-event close is a strike; anything lived resets the count. */
  private countStrike(strikes: number, envelopes: number, openedAt: number): number {
    if (envelopes > 0 || Date.now() - openedAt >= IMMEDIATE_END_MS) return 0
    return strikes + 1
  }

  /** Fold one mux envelope into events. */
  private handleMux(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    if (frame.type !== 'session/notify') return
    const channel = this.channelOf(frame.sessionId)
    this.deps.onEvent({
      kind: frame.kind === 'question' ? this.questionKind(frame) : frame.kind,
      sourceKey: frame.sourceKey,
      channel,
      sessionId: frame.sessionId,
    })
  }

  /** Prefer the list row's settled classification; fall back to the frame shape. */
  private questionKind(frame: NotifyFrame): SoundEventKind {
    if (frame.questions === undefined) return 'question'
    const interaction = this.deps.sessions.getSnapshot().byId[frame.sessionId]?.pendingInteraction
    if (interaction === 'plan-review' || interaction === 'question') return interaction
    return frameQuestionKind(frame.questions)
  }

  /** Subagent origin of one session from the list rows. */
  private channelOf(sessionId: SessionId): SoundChannel {
    const row = this.deps.sessions.getSnapshot().byId[sessionId]
    return row !== undefined && (row.origin === 'subagent' || row.parentId !== undefined) ? 'subagent' : 'main'
  }

  /** One backoff wait; a cancelled timer simply never resumes the loop. */
  private async wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = this.deps.schedule(() => {
        this.timers.delete(timer)
        resolve()
      }, ms)
      this.timers.add(timer)
    })
  }
}

/** One `question` occurrence's question item shape. */
type QuestionItem = {
  multiSelect?: boolean
  detail?: unknown
  intent?: { kind?: string; approve?: string }
  options?: ReadonlyArray<{ label?: string }>
}

/** Frame-shape plan-review classification, mirroring SessionManager's rules. */
function frameQuestionKind(questions: ReadonlyArray<QuestionItem>): SoundEventKind {
  if (questions.length !== 1) return 'question'
  const question = questions[0] as QuestionItem
  const intent = question.intent
  if (intent === undefined) return 'question'
  if (intent.kind !== 'plan-review') return 'question'
  if (question.detail === undefined) return 'question'
  if (question.multiSelect === true) return 'question'
  const options = question.options ?? []
  if (options.length > 2) return 'question'
  return options.some(option => option.label === intent.approve) ? 'plan-review' : 'question'
}
