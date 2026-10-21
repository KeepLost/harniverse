/**
 * The notification event detector: one supplementary mux subscription plus
 * the host stream, folded into six event kinds. Turn settlements read the
 * durable `turn/end` reason (aborted / max-tokens / interrupted turns stay
 * silent), requested approvals and questions ring once per rpcId, the mux
 * open-burst replay of still-pending requests never rings, jobs ring on the
 * running→terminal edge, and the goal projection rings only on the entry
 * into `blocked`. Subagent origin comes from the sessions list rows and the
 * job's own kind. The watcher only detects; playback decisions live in the
 * engine and the settings section.
 */

import type { HostFrame, JobView, MuxFrame, RpcRequest, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SoundChannel, SoundEventKind } from '../sound-settings.ts'

/** One detected notification occurrence handed to the consumer. */
export interface SoundEventOccurrence {
  /** Which of the six event kinds rang. */
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
  /** Opens a fresh host stream subscription. */
  readonly openHost: WatcherStreamOpener<HostFrame>
  /** Receives every detected occurrence. */
  readonly onEvent: (event: SoundEventOccurrence) => void
  /** Timer injectable for tests (reopen backoff and the burst window). */
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

/** The open-burst window: requested replays arriving with the open are muted. */
const BURST_CLEAR_MS = 0

/**
 * The frame-level event detector.
 */
export class SoundWatcher {
  private disposed = false
  private readonly seenRpcIds = new Set<string>()
  private readonly prevJobStatus = new Map<string, JobView['status']>()
  private readonly prevGoalPhase = new Map<SessionId, string>()
  private readonly timers = new Set<unknown>()
  private burstOpen = false
  private burstTimer: unknown

  /**
   * @param deps - sessions face, stream openers, event sink, timers.
   */
  constructor(private readonly deps: SoundWatcherDeps) {}

  /** Start both stream loops (call once per watcher). */
  start(): void {
    void this.runMuxLoop()
    void this.runHostLoop()
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

  /** Stop both loops, cancel pending timers, and drop all frame state. */
  dispose(): void {
    this.disposed = true
    for (const timer of [...this.timers]) this.deps.cancel(timer)
    this.timers.clear()
    if (this.burstTimer !== undefined) this.deps.cancel(this.burstTimer)
  }

  /** The mux loop: subscribe, fold frames, reopen with backoff after breaks. */
  private async runMuxLoop(): Promise<void> {
    let delay = REOPEN_BASE_MS
    let strikes = 0
    while (!this.disposed) {
      const stream = this.deps.openMux()
      if (stream === undefined || typeof stream[Symbol.asyncIterator] !== 'function') return
      const openedAt = Date.now()
      let envelopes = 0
      this.beginBurst()
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

  /** The host loop: agent-error frames only, same backoff shape. */
  private async runHostLoop(): Promise<void> {
    let delay = REOPEN_BASE_MS
    let strikes = 0
    while (!this.disposed) {
      const stream = this.deps.openHost()
      if (stream === undefined || typeof stream[Symbol.asyncIterator] !== 'function') return
      const openedAt = Date.now()
      let envelopes = 0
      try {
        for await (const envelope of stream) {
          if (this.isDisposed()) return
          envelopes += 1
          delay = REOPEN_BASE_MS
          this.handleHost(envelope)
        }
      } catch {
        /* stream break: reopen below */
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
    if (frame.type === 'stream/error') return
    const sessionId: SessionId = frame.sessionId
    if (frame.type === 'session/subscribed' || frame.type === 'session/queue') return
    if (frame.type === 'approval/resolved' || frame.type === 'question/resolved') {
      this.burstOpen = false
      if (frame.type === 'question/resolved') this.seenRpcIds.delete(String(frame.questionRpcId))
      return
    }
    if (frame.type === 'approval/requested' || frame.type === 'question/requested') {
      const rpcId = String(envelope.rpcId)
      if (this.seenRpcIds.has(rpcId) || this.burstOpen) return
      this.seenRpcIds.add(rpcId)
      const channel = this.channelOf(sessionId)
      if (frame.type === 'approval/requested') {
        this.deps.onEvent({ kind: 'approval', sourceKey: `pending:${sessionId}:approval`, channel, sessionId })
        return
      }
      const kind = this.questionKind(sessionId, frame.questions)
      this.deps.onEvent({ kind, sourceKey: `pending:${sessionId}:${kind}`, channel, sessionId })
      return
    }
    this.burstOpen = false
    this.pruneDisposed()
    if (frame.type === 'session/jobs') {
      this.handleJobs(sessionId, frame.jobs)
      return
    }
    if (frame.type === 'session/event') {
      if (frame.event.type !== 'turn/end') return
      const reason = frame.event.data.reason
      const channel = this.channelOf(sessionId)
      if (reason.kind === 'completed') {
        this.deps.onEvent({ kind: 'completion', sourceKey: `session:${sessionId}`, channel, sessionId })
      } else if (reason.kind === 'error') {
        this.deps.onEvent({ kind: 'failure', sourceKey: `session:${sessionId}:failure`, channel, sessionId })
      }
      return
    }
    if (frame.type === 'session/projection') {
      if (frame.key !== 'goal') return
      const phase = phaseOf(frame.value)
      const previous = this.prevGoalPhase.get(sessionId)
      this.prevGoalPhase.set(sessionId, phase ?? '')
      if (phase === 'blocked' && previous !== 'blocked') {
        this.deps.onEvent({ kind: 'goal-blocked', sourceKey: `goal:${sessionId}`, channel: this.channelOf(sessionId), sessionId })
      }
    }
  }

  /** Fold one host envelope (agent errors without a turn position). */
  private handleHost(envelope: RpcRequest<HostFrame>): void {
    const frame = envelope.payload
    if (frame.type !== 'host/agent-error') return
    this.deps.onEvent({
      kind: 'failure',
      sourceKey: `session:${frame.sessionId}:failure`,
      channel: this.channelOf(frame.sessionId),
      sessionId: frame.sessionId,
    })
  }

  /** Ring job terminal transitions; killed jobs and mid-flight states stay silent. */
  private handleJobs(sessionId: SessionId, jobs: readonly JobView[]): void {
    const seen = new Set<string>()
    for (const job of jobs) {
      const key = `${sessionId}:${job.id}`
      seen.add(key)
      const previous = this.prevJobStatus.get(key)
      const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'killed'
      if ((previous === 'running' || previous === 'stopping') && terminal) {
        const channel: SoundChannel = job.kind === 'subagent' || this.channelOf(sessionId) === 'subagent' ? 'subagent' : 'main'
        if (job.status === 'failed') {
          this.deps.onEvent({ kind: 'failure', sourceKey: `job:${key}`, channel, sessionId })
        } else if (job.status !== 'killed') {
          this.deps.onEvent({ kind: 'completion', sourceKey: `job:${key}`, channel, sessionId })
        }
      }
      this.prevJobStatus.set(key, job.status)
    }
    for (const key of this.prevJobStatus.keys()) {
      if (key.startsWith(`${sessionId}:`) && !seen.has(key)) this.prevJobStatus.delete(key)
    }
  }

  /** Prefer the list row's settled classification; fall back to the frame shape. */
  private questionKind(sessionId: SessionId, questions: ReadonlyArray<QuestionItem>): SoundEventKind {
    const interaction = this.deps.sessions.getSnapshot().byId[sessionId]?.pendingInteraction
    if (interaction === 'plan-review' || interaction === 'question') return interaction
    return frameQuestionKind(questions)
  }

  /** Subagent origin of one session from the list rows. */
  private channelOf(sessionId: SessionId): SoundChannel {
    const row = this.deps.sessions.getSnapshot().byId[sessionId]
    return row !== undefined && (row.origin === 'subagent' || row.parentId !== undefined) ? 'subagent' : 'main'
  }

  /** Suppress requested-frame replay until the open burst clears. */
  private beginBurst(): void {
    this.burstOpen = true
    if (this.burstTimer !== undefined) this.deps.cancel(this.burstTimer)
    this.burstTimer = this.deps.schedule(() => {
      this.burstTimer = undefined
      this.burstOpen = false
    }, BURST_CLEAR_MS)
  }

  /** Drop frame state of sessions that left the list (bounded memory). */
  private pruneDisposed(): void {
    const active = new Set(this.deps.sessions.getSnapshot().ids)
    for (const sessionId of this.prevGoalPhase.keys()) {
      if (!active.has(sessionId)) this.prevGoalPhase.delete(sessionId)
    }
    for (const key of this.prevJobStatus.keys()) {
      const jobSession = key.slice(0, key.indexOf(':')) as SessionId
      if (!active.has(jobSession)) this.prevJobStatus.delete(key)
    }
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

/** One `question/requested` frame's question item shape. */
type QuestionItem = {
  multiSelect?: boolean
  detail?: unknown
  intent?: { kind?: string; approve?: string }
  options?: ReadonlyArray<{ label?: string }>
}

/** Read the goal phase off one projection value. */
function phaseOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const phase = (value as { phase?: unknown }).phase
  return typeof phase === 'string' ? phase : undefined
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
