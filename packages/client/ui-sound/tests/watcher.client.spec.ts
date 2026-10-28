/**
 * The notify consumer: `session/notify` folding (one occurrence per frame,
 * subagent routing from the sessions list, plan-review refinement through
 * the list row then the frame shape), non-notify frame immunity, stream
 * reopen with backoff, the carrier breaker, and disposal — everything
 * through a controllable stream and manual timers.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ApprovalRequestId, MuxFrame, RpcRequest, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { SoundWatcher } from '../src/client/watcher.ts'
import type { SoundEventOccurrence, WatcherStreamOpener } from '../src/client/watcher.ts'

/** One `session/notify` frame's payload view. */
type NotifyFrame = Extract<MuxFrame, { type: 'session/notify' }>

/** One `session/notify` question item view. */
type QuestionItem = NonNullable<NotifyFrame['questions']>[number]

/** One controllable async stream the watcher subscribes to. */
class ControlledStream<F> {
  private readonly queue: Array<RpcRequest<F>> = []
  private readonly parked: Array<{
    resolve: (result: IteratorResult<RpcRequest<F>>) => void
    reject: (error: unknown) => void
  }> = []
  private done = false

  /** The iterable face handed to the watcher. */
  readonly iterable: AsyncIterable<RpcRequest<F>> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<RpcRequest<F>>> => new Promise((resolve, reject) => {
        const frame = this.queue.shift()
        if (frame !== undefined) {
          resolve({ value: frame, done: false })
          return
        }
        if (this.done) {
          resolve({ value: undefined, done: true })
          return
        }
        this.parked.push({ resolve, reject })
      }),
      /* for-await calls return() when the loop exits early (dispose). */
      'return': async () => ({ value: undefined, done: true }),
    }),
  }

  /** Deliver one frame (wakes a parked reader or queues). */
  push(frame: F, rpcId: number = 1): void {
    const envelope = { rpcId: rpcId as unknown as RpcRequest<F>['rpcId'], payload: frame } as unknown as RpcRequest<F>
    const reader = this.parked.shift()
    if (reader !== undefined) reader.resolve({ value: envelope, done: false })
    else this.queue.push(envelope)
  }

  /** End the stream (wake parked readers with the done result). */
  end(): void {
    this.done = true
    for (const reader of this.parked.splice(0)) reader.resolve({ value: undefined, done: true })
  }

  /** Break the stream with a transport error (wake parked readers with a rejection). */
  fail(error: unknown): void {
    this.done = true
    for (const reader of this.parked.splice(0)) reader.reject(error)
  }
}

/** Manual timer bank the watcher schedules into. */
class TimerBank {
  readonly entries: Array<{ fn: () => void; ms: number }> = []

  /** The injectable schedule/cancel pair. */
  readonly api = {
    schedule: (fn: () => void, ms: number): unknown => {
      const entry = { fn, ms }
      this.entries.push(entry)
      return entry
    },
    cancel: (timer: unknown): void => {
      const index = this.entries.indexOf(timer as { fn: () => void; ms: number })
      if (index >= 0) this.entries.splice(index, 1)
    },
  }

  /** Fire every scheduled timer once. */
  flush(): void {
    for (const entry of this.entries.splice(0)) entry.fn()
  }
}

/** Brand one plain id the frame unions carry. */
const sid = (id: string): SessionId => id as SessionId

/** One mutable sessions list snapshot the tests shape per case. */
interface SessionsHarness {
  readonly face: { getSnapshot(): SessionListState }
  readonly state: SessionListState
}

/** Build the sessions face with one empty ready list. */
function sessionsHarness(): SessionsHarness {
  const state: SessionListState = {
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, selectionSeq: 0, currentAddress: undefined,
  }
  return { state, face: { getSnapshot: () => state } }
}

/** One list row carrying only the fields the watcher reads. */
function row(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  const branded = sid(id)
  return { id: branded, displayTitle: id, running: false, blank: false, updatedAt: 0, ...extra }
}

/** Build a watcher over one controlled mux stream with manual timers. */
function bench(openMux?: WatcherStreamOpener<MuxFrame>) {
  const sessions = sessionsHarness()
  const mux = new ControlledStream<MuxFrame>()
  const events: SoundEventOccurrence[] = []
  const timers = new TimerBank()
  const opener = vi.fn(openMux ?? (() => mux.iterable))
  const carrierLost = vi.fn()
  const watcher = new SoundWatcher({
    sessions: sessions.face,
    openMux: opener,
    onEvent: (event) => { events.push(event) },
    schedule: timers.api.schedule,
    cancel: timers.api.cancel,
    onCarrierLost: carrierLost,
  })
  watcher.start()
  return { watcher, sessions, mux, events, timers, openMux: opener, carrierLost }
}

/** One `session/notify` frame literal (questions optional). */
function notify(
  sessionId: string,
  kind: NotifyFrame['kind'],
  sourceKey: string,
  questions?: NonNullable<NotifyFrame['questions']>,
): MuxFrame {
  return questions === undefined
    ? { type: 'session/notify', sessionId: sid(sessionId), kind, sourceKey }
    : { type: 'session/notify', sessionId: sid(sessionId), kind, sourceKey, questions }
}

/** One question item literal; `overrides` may cast invalid intents for shape tests. */
function question(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return { id: 'q', question: 'Proceed?', ...overrides }
}

/** One question list whose frame shape reads as a plan review. */
function planReviewQuestions(): NonNullable<NotifyFrame['questions']> {
  return [question({
    detail: 'The plan',
    intent: { kind: 'plan-review', approve: 'Approve' },
    options: [{ label: 'Approve' }, { label: 'Revise' }],
  })]
}

/** Drain the watcher's microtask chain after a push. */
const settle = async (): Promise<void> => {
  for (let hop = 0; hop < 24; hop += 1) await Promise.resolve()
}

describe('SoundWatcher notify folding', () => {
  it('rings each detected kind with the frame sourceKey and sessionId on the main channel', async () => {
    const kit = bench()
    kit.mux.push(notify('s1', 'approval', 'approval:s1:a1'))
    kit.mux.push(notify('s1', 'completion', 'turn:s1:1'))
    kit.mux.push(notify('s2', 'failure', 'turn:s2:2'))
    kit.mux.push(notify('s2', 'goal-blocked', 'goal:s2'))
    await settle()
    expect(kit.events).toEqual([
      { kind: 'approval', sourceKey: 'approval:s1:a1', channel: 'main', sessionId: sid('s1') },
      { kind: 'completion', sourceKey: 'turn:s1:1', channel: 'main', sessionId: sid('s1') },
      { kind: 'failure', sourceKey: 'turn:s2:2', channel: 'main', sessionId: sid('s2') },
      { kind: 'goal-blocked', sourceKey: 'goal:s2', channel: 'main', sessionId: sid('s2') },
    ])
    kit.watcher.dispose()
  })

  it('routes rows marked subagent by origin or parentId to the subagent channel', async () => {
    const kit = bench()
    kit.sessions.state.ids = [sid('s1'), sid('s2'), sid('s3')]
    kit.sessions.state.byId[sid('s1')] = row('s1', { origin: 'subagent' })
    kit.sessions.state.byId[sid('s2')] = row('s2', { parentId: sid('p') })
    kit.sessions.state.byId[sid('s3')] = row('s3')
    kit.mux.push(notify('s1', 'completion', 'turn:s1:1'))
    kit.mux.push(notify('s2', 'completion', 'turn:s2:1'))
    kit.mux.push(notify('s3', 'completion', 'turn:s3:1'))
    await settle()
    expect(kit.events.map(event => event.channel)).toEqual(['subagent', 'subagent', 'main'])
    kit.watcher.dispose()
  })
})

describe('SoundWatcher question refinement', () => {
  it('prefers the list row settled interaction over the frame shape', async () => {
    const kit = bench()
    kit.sessions.state.ids = [sid('s1'), sid('s2')]
    kit.sessions.state.byId[sid('s1')] = row('s1', { pendingInteraction: 'plan-review' })
    kit.sessions.state.byId[sid('s2')] = row('s2', { pendingInteraction: 'question' })
    // s1's frame shape is not a plan review yet the row's classification wins;
    // s2's frame shape is a plan review yet the plain-question row wins.
    kit.mux.push(notify('s1', 'question', 'question:s1:1', [question({ multiSelect: true })]))
    kit.mux.push(notify('s2', 'question', 'question:s2:1', planReviewQuestions()))
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['plan-review', 'question'])
    kit.watcher.dispose()
  })

  it('classifies plan-review from the frame shape when the row carries no question interaction', async () => {
    const kit = bench()
    kit.sessions.state.ids = [sid('s1')]
    // An approval interaction is not a question interaction: the frame decides.
    kit.sessions.state.byId[sid('s1')] = row('s1', { pendingInteraction: 'approval' })
    kit.mux.push(notify('s1', 'question', 'question:s1:1', planReviewQuestions()))
    // An unlisted session decides through the frame shape as well.
    kit.mux.push(notify('s2', 'question', 'question:s2:1', planReviewQuestions()))
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['plan-review', 'plan-review'])
    kit.watcher.dispose()
  })

  it('classifies plain questions from every non-plan-review frame shape', async () => {
    const kit = bench()
    const shapes: Array<NonNullable<NotifyFrame['questions']>> = [
      [question(), question()],
      [question()],
      [question({ intent: { kind: 'other' } as never })],
      [question({ intent: { kind: 'plan-review', approve: 'Approve' } })],
      [question({ detail: 'd', multiSelect: true, intent: { kind: 'plan-review', approve: 'Approve' }, options: [{ label: 'Approve' }] })],
      [question({ detail: 'd', intent: { kind: 'plan-review', approve: 'Approve' }, options: [{ label: 'Approve' }, { label: 'Revise' }, { label: 'Cancel' }] })],
      [question({ detail: 'd', intent: { kind: 'plan-review', approve: 'Approve' }, options: [{ label: 'Revise' }] })],
      [question({ detail: 'd', intent: { kind: 'plan-review', approve: 'Approve' } })],
    ]
    for (const [index, questions] of shapes.entries()) {
      kit.mux.push(notify('s1', 'question', `question:s1:${index}`, questions))
    }
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(shapes.map(() => 'question'))
    kit.watcher.dispose()
  })

  it('treats a frame without questions as a plain question regardless of the row', async () => {
    const kit = bench()
    kit.sessions.state.ids = [sid('s1')]
    kit.sessions.state.byId[sid('s1')] = row('s1', { pendingInteraction: 'plan-review' })
    kit.mux.push(notify('s1', 'question', 'question:s1:1'))
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['question'])
    kit.watcher.dispose()
  })
})

describe('SoundWatcher frame zoo', () => {
  it('ignores every non-notify mux frame without ringing', async () => {
    const kit = bench()
    kit.sessions.state.ids = [sid('s1')]
    kit.sessions.state.byId[sid('s1')] = row('s1')
    kit.mux.push({ type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 0 })
    kit.mux.push({
      type: 'session/event', sessionId: sid('s1'),
      event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } as never,
    })
    kit.mux.push({ type: 'approval/requested', sessionId: sid('s1'), approvalId: 'a1' as ApprovalRequestId, toolName: 'bash' })
    kit.mux.push({ type: 'question/requested', sessionId: sid('s1'), questions: [question()] })
    kit.mux.push({ type: 'session/jobs', sessionId: sid('s1'), jobs: [] })
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'goal', value: { phase: 'blocked' }, seq: 1 })
    kit.mux.push({ type: 'stream/error', error: { code: 'GONE', message: 'x' } as never })
    await settle()
    expect(kit.events).toEqual([])
    kit.watcher.dispose()
  })
})

describe('SoundWatcher lifecycle', () => {
  it('does not subscribe when the opener reports an unsupported transport', async () => {
    const kit = bench(() => undefined)
    expect(kit.openMux).toHaveBeenCalledTimes(1)
    await settle()
    expect(kit.events).toEqual([])
    expect(kit.timers.entries).toEqual([])
    kit.watcher.dispose()
  })

  it('exits the loop when the opener returns a non-stream value', async () => {
    const kit = bench(() => ({}) as unknown as AsyncIterable<RpcRequest<MuxFrame>>)
    expect(kit.openMux).toHaveBeenCalledTimes(1)
    await settle()
    expect(kit.timers.entries).toEqual([])
    kit.watcher.dispose()
  })

  it('reopens a broken stream after the backoff wait', async () => {
    const kit = bench()
    kit.mux.push(notify('s1', 'completion', 'turn:s1:1'))
    await settle()
    kit.mux.end()
    await settle()
    expect(kit.timers.entries.map(entry => entry.ms)).toEqual([800])
    kit.timers.flush()
    await settle()
    expect(kit.openMux).toHaveBeenCalledTimes(2)
    expect(kit.carrierLost).not.toHaveBeenCalled()
    kit.watcher.dispose()
  })

  it('resets the reopen delay when a reopened stream delivers an envelope', async () => {
    const sessions = sessionsHarness()
    const timers = new TimerBank()
    const events: SoundEventOccurrence[] = []
    // One fresh stream per generation: the reopened loop parks on the second
    // stream and can still receive an envelope before its close.
    const streams = [new ControlledStream<MuxFrame>(), new ControlledStream<MuxFrame>()]
    let opens = 0
    const watcher = new SoundWatcher({
      sessions: sessions.face,
      openMux: () => {
        const stream = streams[opens]
        opens += 1
        return stream!.iterable
      },
      onEvent: (event) => { events.push(event) },
      schedule: timers.api.schedule,
      cancel: timers.api.cancel,
      onCarrierLost: () => {},
    })
    watcher.start()
    await settle()
    streams[0]!.end()
    await settle()
    timers.flush()
    await settle()
    streams[1]!.push(notify('s1', 'completion', 'turn:s1:1'))
    await settle()
    streams[1]!.end()
    await settle()
    expect(events.map(event => event.kind)).toEqual(['completion'])
    // One delivered envelope drops the next wait back to the base delay.
    expect(timers.entries.map(entry => entry.ms)).toEqual([800])
    watcher.dispose()
  })

  it('treats a stream error as a break and reopens', async () => {
    const kit = bench()
    kit.mux.fail(new Error('connection reset'))
    await settle()
    expect(kit.timers.entries.map(entry => entry.ms)).toEqual([800])
    kit.timers.flush()
    await settle()
    expect(kit.openMux).toHaveBeenCalledTimes(2)
    kit.watcher.dispose()
  })

  it('doubles the reopen backoff up to the 30s ceiling', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const sessions = sessionsHarness()
      const timers = new TimerBank()
      // Every stream lives past the immediate window (system time jumps 6s
      // before the close), so the breaker never trips and only the delay grows.
      const watcher = new SoundWatcher({
        sessions: sessions.face,
        openMux: () => {
          const stream = new ControlledStream<MuxFrame>()
          queueMicrotask(() => {
            vi.setSystemTime(Date.now() + 6_000)
            stream.end()
          })
          return stream.iterable
        },
        onEvent: () => {},
        schedule: timers.api.schedule,
        cancel: timers.api.cancel,
        onCarrierLost: () => {},
      })
      watcher.start()
      await settle()
      const delays: number[] = [timers.entries[0]!.ms]
      for (let round = 0; round < 7; round += 1) {
        timers.flush()
        await settle()
        delays.push(timers.entries[0]!.ms)
      }
      expect(delays).toEqual([800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000, 30_000])
      watcher.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops for good after disposal and cancels pending timers', async () => {
    const kit = bench()
    kit.mux.end()
    await settle()
    expect(kit.timers.entries.length).toBeGreaterThan(0)
    // Dispose while the reopen wait is pending: the timer is cancelled and
    // the waiting loop never resumes.
    kit.watcher.dispose()
    expect(kit.timers.entries).toEqual([])
    kit.timers.flush()
    await settle()
    expect(kit.openMux).toHaveBeenCalledTimes(1)
  })

  it('does not reopen when disposal lands after the wait resolved', async () => {
    const kit = bench()
    kit.mux.end()
    await settle()
    // Resolve the reopen wait, then dispose before the loop resumes: the
    // loop observes the disposed flag right after its wait.
    kit.timers.flush()
    kit.watcher.dispose()
    await settle()
    kit.timers.flush()
    await settle()
    expect(kit.openMux).toHaveBeenCalledTimes(1)
  })

  it('drops frames delivered after disposal through parked readers', async () => {
    const kit = bench()
    await settle()
    kit.watcher.dispose()
    kit.mux.push(notify('s1', 'completion', 'turn:s1:1'))
    await settle()
    expect(kit.events).toEqual([])
  })

  it('retires the generation after two consecutive immediate zero-envelope closes', async () => {
    const kit = bench()
    await settle()
    kit.mux.end()
    await settle()
    // First close strikes; the reopen finds the drained stream and the second strike trips.
    kit.timers.flush()
    await settle()
    expect(kit.openMux).toHaveBeenCalledTimes(2)
    expect(kit.carrierLost).toHaveBeenCalledTimes(1)
    kit.timers.flush()
    await settle()
    expect(kit.openMux).toHaveBeenCalledTimes(2)
  })

  it('resets the strike count when a reopen delivers envelopes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const sessions = sessionsHarness()
      const timers = new TimerBank()
      const carrierLost = vi.fn()
      const opens: Array<'mute' | 'immediate'> = ['immediate', 'mute', 'immediate', 'immediate']
      let muxOpens = 0
      const watcher = new SoundWatcher({
        sessions: sessions.face,
        openMux: () => {
          const kind = opens[muxOpens]
          muxOpens += 1
          const stream = new ControlledStream<MuxFrame>()
          if (kind === 'mute') stream.push({ type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 0 })
          stream.end()
          return stream.iterable
        },
        onEvent: () => {},
        schedule: timers.api.schedule,
        cancel: timers.api.cancel,
        onCarrierLost: carrierLost,
      })
      watcher.start()
      await settle()
      // immediate(1) -> reopen; the mute envelope's close resets the count.
      for (let wave = 0; wave < 3; wave += 1) {
        timers.flush()
        await settle()
      }
      expect(muxOpens).toBe(4)
      expect(carrierLost).toHaveBeenCalledTimes(1)
      timers.flush()
      await settle()
      expect(muxOpens).toBe(4)
      watcher.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the strike count when a stream stayed open past the immediate window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const sessions = sessionsHarness()
      const timers = new TimerBank()
      const carrierLost = vi.fn()
      let muxOpens = 0
      const watcher = new SoundWatcher({
        sessions: sessions.face,
        openMux: () => {
          muxOpens += 1
          const stream = new ControlledStream<MuxFrame>()
          if (muxOpens === 2) queueMicrotask(() => {
            vi.setSystemTime(Date.now() + 6_000)
            stream.end()
          })
          else stream.end()
          return stream.iterable
        },
        onEvent: () => {},
        schedule: timers.api.schedule,
        cancel: timers.api.cancel,
        onCarrierLost: carrierLost,
      })
      watcher.start()
      await settle()
      // Opens: immediate(1), six-second quiet close (reset), immediate(1), immediate(2 -> trip).
      timers.flush()
      await settle()
      timers.flush()
      await settle()
      timers.flush()
      await settle()
      expect(muxOpens).toBe(4)
      expect(carrierLost).toHaveBeenCalledTimes(1)
      watcher.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
