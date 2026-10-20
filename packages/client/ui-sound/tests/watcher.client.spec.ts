/**
 * The frame detector: turn settlements by durable reason, requested-frame
 * dedupe and open-burst replay suppression, job terminal edges, goal
 * blocked entries, subagent routing, stream reopen with backoff, and
 * disposal — everything through a controllable stream and manual timers.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ApprovalRequestId, HostFrame, MuxFrame, RpcRequest, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { SoundWatcher } from '../src/client/watcher.ts'
import type { SoundEventOccurrence } from '../src/client/watcher.ts'

/** One controllable async stream the watcher subscribes to. */
class ControlledStream<F> {
  private readonly queue: Array<RpcRequest<F>> = []
  private readonly parked: Array<(value: IteratorResult<RpcRequest<F>>) => void> = []
  private done = false

  /** The iterable face handed to the watcher. */
  readonly iterable: AsyncIterable<RpcRequest<F>> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<RpcRequest<F>>> => new Promise((resolve) => {
        const frame = this.queue.shift()
        if (frame !== undefined) {
          resolve({ value: frame, done: false })
          return
        }
        if (this.done) {
          resolve({ value: undefined, done: true })
          return
        }
        this.parked.push(resolve)
      }),
      /* for-await calls return() when the loop exits early (dispose). */
      'return': async () => ({ value: undefined, done: true }),
    }),
  }

  /** Deliver one frame (wakes a parked reader or queues). */
  push(frame: F, rpcId: number = 1): void {
    const envelope = { rpcId: rpcId as unknown as RpcRequest<F>['rpcId'], payload: frame } as unknown as RpcRequest<F>
    const reader = this.parked.shift()
    if (reader !== undefined) reader({ value: envelope, done: false })
    else this.queue.push(envelope)
  }

  /** End the stream (wake parked readers with the done result). */
  end(): void {
    this.done = true
    for (const reader of this.parked.splice(0)) reader({ value: undefined, done: true })
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

  /** Fire only timers of one delay (the burst clear is 0ms). */
  flushOf(ms: number): void {
    for (const entry of [...this.entries]) {
      if (entry.ms !== ms) continue
      this.api.cancel(entry)
      entry.fn()
    }
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

/** Register one session in the list so prune keeps its edge state. */
function listed(kit: ReturnType<typeof bench>, id: string): void {
  kit.sessions.state.ids.push(sid(id))
  kit.sessions.state.byId[sid(id)] = row(id)
}

/** Build a watcher over the given streams with manual timers. */
function bench(options: { mux?: boolean; host?: boolean } = {}) {
  const sessions = sessionsHarness()
  const mux = new ControlledStream<MuxFrame>()
  const host = new ControlledStream<HostFrame>()
  const events: SoundEventOccurrence[] = []
  const timers = new TimerBank()
  const openMux = vi.fn(options.mux === false ? () => undefined : () => mux.iterable)
  const openHost = vi.fn(options.host === false ? () => undefined : () => host.iterable)
  const carrierLost = vi.fn()
  const watcher = new SoundWatcher({
    sessions: sessions.face,
    openMux,
    openHost,
    onEvent: (event) => { events.push(event) },
    schedule: timers.api.schedule,
    cancel: timers.api.cancel,
    onCarrierLost: carrierLost,
  })
  watcher.start()
  return { watcher, sessions, mux, host, events, timers, openMux, openHost, carrierLost }
}


/** One turn/end session event literal with an unchecked reason payload. */
function turnEndFrame(sessionId: string, reason: unknown): MuxFrame {
  return {
    type: 'session/event',
    sessionId: sessionId as SessionId,
    event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason } } as never,
  }
}

/** One opaque session event literal the watcher must ignore. */
function eventFrame(sessionId: string, event: unknown): MuxFrame {
  return {
    type: 'session/event',
    sessionId: sessionId as SessionId,
    event: event as never,
  }
}

/** One jobs snapshot frame with unchecked job rows. */
function jobsFrame(sessionId: string, jobs: unknown): MuxFrame {
  return {
    type: 'session/jobs',
    sessionId: sessionId as SessionId,
    jobs: jobs as never,
  }
}

/** Drain the watcher's microtasks after a push. */
/** Drain the watcher's microtask chain after a push. */
const settle = async (): Promise<void> => {
  for (let hop = 0; hop < 8; hop += 1) await Promise.resolve()
}

describe('SoundWatcher turn settlements', () => {
  it('rings completion for a completed turn and failure for an error turn', async () => {
    const kit = bench()
    kit.mux.push(turnEndFrame('s1', { kind: 'completed' }))
    await settle()
    kit.mux.push(turnEndFrame('s1', { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } }))
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['completion', 'failure'])
    kit.watcher.dispose()
  })

  it('stays silent for aborted, blocked, max-tokens, and non-turn events', async () => {
    const kit = bench()
    for (const kind of ['aborted', 'blocked', 'max-tokens'] as const) {
      kit.mux.push(turnEndFrame('s1', { kind }))
    }
    kit.mux.push(eventFrame('s1', { type: 'user/message', seq: 4, time: 4, data: { content: [], source: 'prompt' } }))
    await settle()
    expect(kit.events).toEqual([])
    kit.watcher.dispose()
  })
})

describe('SoundWatcher requested frames', () => {
  it('rings an approval once per rpcId and suppresses the open-burst replay', async () => {
    const kit = bench()
    kit.mux.push({ type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 0 })
    kit.mux.push({ type: 'approval/requested', sessionId: sid('s1'), approvalId: 'a1' as ApprovalRequestId, toolName: 'bash' }, 7)
    await settle()
    expect(kit.events).toEqual([])
    kit.mux.push({ type: 'approval/requested', sessionId: sid('s1'), approvalId: 'a1' as ApprovalRequestId, toolName: 'bash' }, 7)
    await settle()
    expect(kit.events).toEqual([])
    kit.timers.flushOf(0)
    kit.mux.push({ type: 'approval/requested', sessionId: sid('s1'), approvalId: 'a2' as ApprovalRequestId, toolName: 'bash' }, 8)
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['approval'])
    kit.watcher.dispose()
  })

  it('classifies questions by the list row first and the frame shape second', async () => {
    const kit = bench()
    kit.timers.flushOf(0)
    kit.sessions.state.ids = [sid('s1'), sid('s2'), sid('s3'), sid('s4')]
    kit.sessions.state.byId[sid('s1')] = row('s1', { pendingInteraction: 'plan-review' })
    kit.sessions.state.byId[sid('s2')] = row('s2', { pendingInteraction: 'question' })
    kit.mux.push({ type: 'question/requested', sessionId: sid('s1'), questions: [{ id: 'q', question: '?' }] }, 11)
    kit.mux.push({ type: 'question/requested', sessionId: sid('s2'), questions: [{ id: 'q', question: '?' }] }, 12)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s3'),
      questions: [{ id: 'q', question: '?', detail: 'd', intent: { kind: 'plan-review', approve: '好' }, options: [{ label: '好' }, { label: '改' }] }],
    }, 13)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s4'),
      questions: [{ id: 'q', question: '?', detail: 'd', multiSelect: true, intent: { kind: 'plan-review', approve: '好' }, options: [{ label: '好' }, { label: '改' }] }],
    }, 14)
    await settle()
    expect(kit.events.map(event => `${event.sessionId}:${event.kind}`)).toEqual(['s1:plan-review', 's2:question', 's3:plan-review', 's4:question'])
    kit.watcher.dispose()
  })

  it('re-arms a question rpcId after its resolution', async () => {
    const kit = bench()
    kit.timers.flushOf(0)
    kit.mux.push({ type: 'question/requested', sessionId: sid('s1'), questions: [{ id: 'q', question: '?' }] }, 21)
    await settle()
    kit.mux.push({ type: 'question/requested', sessionId: sid('s1'), questions: [{ id: 'q', question: '?' }] }, 21)
    await settle()
    kit.mux.push({ type: 'question/resolved', sessionId: sid('s1'), questionRpcId: 21 as unknown as RpcRequest<MuxFrame>['rpcId'], outcome: 'answered' })
    kit.mux.push({ type: 'question/requested', sessionId: sid('s1'), questions: [{ id: 'q', question: '?' }] }, 21)
    await settle()
    expect(kit.events.filter(event => event.kind === 'question')).toHaveLength(2)
    kit.watcher.dispose()
  })
})

describe('SoundWatcher jobs and goals', () => {
  it('rings terminal job edges and stays silent for killed or mid-flight jobs', async () => {
    const kit = bench()
    listed(kit, 's1')
    kit.mux.push(jobsFrame('s1', [
      { id: 'j1', kind: 'bash', label: 'a', status: 'running', startedAt: 0 },
      { id: 'j2', kind: 'bash', label: 'b', status: 'running', startedAt: 0 },
      { id: 'j3', kind: 'bash', label: 'c', status: 'running', startedAt: 0 },
    ]))
    await settle()
    expect(kit.events).toEqual([])
    kit.mux.push(jobsFrame('s1', [
      { id: 'j1', kind: 'bash', label: 'a', status: 'completed', startedAt: 0, finishedAt: 1 },
      { id: 'j2', kind: 'bash', label: 'b', status: 'failed', startedAt: 0, finishedAt: 1, detail: 'exit 1' },
      { id: 'j3', kind: 'bash', label: 'c', status: 'killed', startedAt: 0, finishedAt: 1 },
    ]))
    await settle()
    expect(kit.events.map(event => `${event.kind}:${event.sourceKey}`)).toEqual(['completion:job:s1:j1', 'failure:job:s1:j2'])
    kit.mux.push(jobsFrame('s1', [
      { id: 'j1', kind: 'bash', label: 'a', status: 'completed', startedAt: 0, finishedAt: 1 },
    ]))
    await settle()
    expect(kit.events).toHaveLength(2)
    kit.watcher.dispose()
  })

  it('routes subagent jobs to the subagent channel', async () => {
    const kit = bench()
    listed(kit, 's1')
    kit.mux.push(jobsFrame('s1', [{ id: 'j1', kind: 'subagent', label: 'delegation', status: 'running', startedAt: 0 }]))
    await settle()
    kit.mux.push(jobsFrame('s1', [{ id: 'j1', kind: 'subagent', label: 'delegation', status: 'completed', startedAt: 0, finishedAt: 1 }]))
    await settle()
    expect(kit.events[0]?.channel).toBe('subagent')
    kit.watcher.dispose()
  })

  it('rings only the entry into a blocked goal', async () => {
    const kit = bench()
    listed(kit, 's1')
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'goal', value: { phase: 'active' }, seq: 1 })
    await settle()
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'goal', value: { phase: 'blocked' }, seq: 2 })
    await settle()
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'goal', value: { phase: 'blocked' }, seq: 3 })
    await settle()
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'title', value: { text: 'x' }, seq: 4 })
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'goal', value: null, seq: 5 })
    await settle()
    expect(kit.events.filter(event => event.kind === 'goal-blocked')).toHaveLength(1)
    kit.watcher.dispose()
  })
})

describe('SoundWatcher routing and host stream', () => {
  it('routes sessions marked subagent in the list to the subagent channel', async () => {
    const kit = bench()
    kit.sessions.state.ids = [sid('s1'), sid('s2')]
    kit.sessions.state.byId[sid('s1')] = row('s1', { origin: 'subagent' })
    kit.sessions.state.byId[sid('s2')] = row('s2', { parentId: sid('p') })
    kit.timers.flushOf(0)
    kit.mux.push({ type: 'approval/requested', sessionId: sid('s1'), approvalId: 'a1' as ApprovalRequestId, toolName: 'bash' }, 31)
    kit.mux.push({ type: 'approval/requested', sessionId: sid('s2'), approvalId: 'a2' as ApprovalRequestId, toolName: 'bash' }, 32)
    await settle()
    expect(kit.events.every(event => event.channel === 'subagent')).toBe(true)
    kit.watcher.dispose()
  })

  it('rings host agent errors and ignores every other host frame', async () => {
    const kit = bench()
    kit.host.push({ type: 'host/agent-error', sessionId: sid('s1'), message: 'boom' })
    await settle()
    kit.host.push({ type: 'host/session-status', sessionId: sid('s1'), running: false })
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['failure'])
    kit.watcher.dispose()
  })
})

describe('SoundWatcher frame zoo', () => {
  it('ignores control, resolved, queue, and stream-error frames without ringing', async () => {
    const kit = bench()
    listed(kit, 's1')
    kit.timers.flushOf(0)
    kit.mux.push({ type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 0 })
    kit.mux.push({ type: 'session/queue', sessionId: sid('s1'), items: [] } as never)
    kit.mux.push({ type: 'approval/resolved', sessionId: sid('s1'), approvalId: 'a1' as ApprovalRequestId, outcome: 'allow' as never })
    kit.mux.push({ type: 'question/resolved', sessionId: sid('s1'), questionRpcId: 5 as unknown as RpcRequest<MuxFrame>['rpcId'], outcome: 'answered' })
    kit.mux.push({ type: 'stream/error', error: { code: 'GONE', message: 'x' } } as never)
    await settle()
    expect(kit.events).toEqual([])
  })

  it('classifies multi-question and wide-option frames as plain questions', async () => {
    const kit = bench()
    listed(kit, 's1')
    kit.timers.flushOf(0)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s1'),
      questions: [
        { id: 'q1', question: 'a' },
        { id: 'q2', question: 'b' },
      ],
    }, 41)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s1'),
      questions: [{
        id: 'q3', question: 'c', detail: 'd', intent: { kind: 'plan-review', approve: '好' },
        options: [{ label: '好' }, { label: '改' }, { label: '否' }],
      }],
    }, 42)
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['question', 'question'])
  })

  it('falls back to the frame shape when the row carries no settled interaction', async () => {
    const kit = bench()
    listed(kit, 's1')
    kit.timers.flushOf(0)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s1'),
      questions: [{ id: 'q', question: '?', detail: 'd', intent: { kind: 'plan-review', approve: '好' }, options: [{ label: '好' }, { label: '改' }] }],
    }, 43)
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['plan-review'])
  })

  it('rings a main-channel job from an unmarked session', async () => {
    const kit = bench()
    listed(kit, 's1')
    kit.mux.push(jobsFrame('s1', [{ id: 'j1', kind: 'bash', label: 'a', status: 'running', startedAt: 0 }]))
    await settle()
    kit.mux.push(jobsFrame('s1', [{ id: 'j1', kind: 'bash', label: 'a', status: 'stopping', startedAt: 0 }]))
    await settle()
    kit.mux.push(jobsFrame('s1', [{ id: 'j1', kind: 'bash', label: 'a', status: 'completed', startedAt: 0, finishedAt: 1 }]))
    await settle()
    const completion = kit.events.find(event => event.kind === 'completion')
    expect(completion?.channel).toBe('main')
  })

  it('ignores malformed goal values and unmappable plan-review frames', async () => {
    const kit = bench()
    listed(kit, 's1')
    kit.timers.flushOf(0)
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'goal', value: { phase: 123 }, seq: 1 })
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s1'),
      questions: [{ id: 'q', question: '?' }],
    }, 49)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s1'),
      questions: [{ id: 'q', question: '?', intent: { kind: 'other' } as never }],
    }, 50)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s1'),
      questions: [{ id: 'q', question: '?', intent: { kind: 'plan-review', approve: '好' } }],
    }, 51)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s1'),
      questions: [{ id: 'q', question: '?', detail: 'd', intent: { kind: 'plan-review', approve: '不在' }, options: [{ label: '好' }, { label: '改' }] }],
    }, 52)
    kit.mux.push({
      type: 'question/requested', sessionId: sid('s1'),
      questions: [{ id: 'q', question: '?', detail: 'd', intent: { kind: 'plan-review', approve: '好' } }],
    }, 53)
    kit.mux.push({ type: 'compaction/progress', sessionId: sid('s1'), compactionId: 'c1', phase: 'reasoning', text: 'x' } as never)
    await settle()
    expect(kit.events.filter(event => event.kind === 'question')).toHaveLength(5)
    expect(kit.events.every(event => event.kind === 'question')).toBe(true)
  })

  it('stops the host loop when the host opener is unsupported', async () => {
    const kit = bench({ host: false })
    kit.mux.push(turnEndFrame('s1', { kind: 'completed' }))
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['completion'])
    kit.watcher.dispose()
  })

  it('cancels a still-pending burst timer when the stream reopens inside the window', async () => {
    const kit = bench()
    kit.mux.end()
    await settle()
    kit.timers.flushOf(800)
    await settle()
    expect(kit.openMux).toHaveBeenCalledTimes(2)
    kit.watcher.dispose()
  })

  it('prunes the edge state of sessions that left the list', async () => {
    const kit = bench()
    listed(kit, 's1')
    listed(kit, 's2')
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'goal', value: { phase: 'active' }, seq: 1 })
    kit.mux.push(jobsFrame('s1', [{ id: 'j1', kind: 'bash', label: 'a', status: 'running', startedAt: 0 }]))
    await settle()
    const index = kit.sessions.state.ids.indexOf('s1' as SessionId)
    if (index >= 0) kit.sessions.state.ids.splice(index, 1)
    Reflect.deleteProperty(kit.sessions.state.byId, sid('s1'))
    // A frame for the surviving session runs the prune pass; s1's goal phase
    // and job edge are dropped, so its later frames start from fresh state.
    kit.mux.push({ type: 'session/projection', sessionId: sid('s2'), key: 'goal', value: { phase: 'active' }, seq: 2 })
    await settle()
    kit.mux.push({ type: 'session/projection', sessionId: sid('s1'), key: 'goal', value: { phase: 'blocked' }, seq: 3 })
    await settle()
    expect(kit.events.map(event => event.kind)).toEqual(['goal-blocked'])
  })
})

describe('SoundWatcher lifecycle', () => {
  it('does not subscribe when an opener reports an unsupported transport', async () => {
    const kit = bench({ mux: false })
    expect(kit.openMux).toHaveBeenCalledTimes(1)
    kit.host.push({ type: 'host/agent-error', sessionId: sid('s1'), message: 'boom' })
    await settle()
    expect(kit.events).toHaveLength(1)
    kit.watcher.dispose()
  })

  it('reopens a broken stream after the backoff wait', async () => {
    const kit = bench()
    kit.mux.push({ type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 0 })
    await settle()
    kit.mux.end()
    await settle()
    expect(kit.timers.entries.length).toBeGreaterThan(0)
    kit.timers.flush()
    await settle()
    expect(kit.openMux).toHaveBeenCalledTimes(2)
    kit.watcher.dispose()
  })

  it('reopens a broken host stream after the backoff wait', async () => {
    const kit = bench()
    kit.host.push({ type: 'host/agent-error', sessionId: sid('s1'), message: 'boom' })
    await settle()
    kit.host.end()
    await settle()
    expect(kit.timers.entries.length).toBeGreaterThan(0)
    kit.timers.flush()
    await settle()
    expect(kit.openHost).toHaveBeenCalledTimes(2)
    kit.watcher.dispose()
  })

  it('stops for good after disposal and cancels pending timers', async () => {
    const kit = bench()
    kit.mux.end()
    kit.host.end()
    await settle()
    expect(kit.timers.entries.length).toBeGreaterThan(0)
    // Resolve the reopen wait, then dispose before the loop resumes: both
    // loops observe the disposed flag after their wait.
    kit.timers.flush()
    kit.watcher.dispose()
    await settle()
    const muxOpens = kit.openMux.mock.calls.length
    const hostOpens = kit.openHost.mock.calls.length
    kit.timers.flush()
    await settle()
    expect(kit.openMux.mock.calls.length).toBe(muxOpens)
    expect(kit.openHost.mock.calls.length).toBe(hostOpens)
  })

  it('drops frames delivered after disposal through parked readers', async () => {
    const kit = bench()
    await settle()
    kit.watcher.dispose()
    kit.mux.push({ type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 0 })
    kit.host.push({ type: 'host/session-status', sessionId: sid('s1'), running: true })
    await settle()
    expect(kit.events).toEqual([])
  })
  it('retires the generation after consecutive immediate zero-event closes', async () => {
    const kit = bench()
    await settle()
    kit.mux.end()
    await settle()
    // First close strikes; the reopen finds the drained stream and the second strike trips.
    kit.timers.flush()
    await settle()
    const muxOpensAtTrip = kit.openMux.mock.calls.length
    expect(muxOpensAtTrip).toBe(2)
    expect(kit.carrierLost).toHaveBeenCalledTimes(1)
    kit.timers.flush()
    await settle()
    expect(kit.openMux.mock.calls.length).toBe(muxOpensAtTrip)
    // The healthy host loop is disposed with the generation and never reopens either.
    kit.host.end()
    kit.timers.flush()
    await settle()
    expect(kit.openHost.mock.calls.length).toBe(1)
  })

  it('resets the strike count when a reopen delivers envelopes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const sessions = sessionsHarness()
      const timers = new TimerBank()
      const carrierLost = vi.fn()
      const opens: Array<'mute' | 'immediate'> = ['immediate', 'mute', 'immediate', 'immediate']
      let muxOpens = 0
      let hostOpens = 0
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
        openHost: () => {
          hostOpens += 1
          return new ControlledStream<HostFrame>().iterable
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
      expect(hostOpens).toBe(1)
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
        openHost: () => new ControlledStream<HostFrame>().iterable,
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
  it('retires from the host loop the same way', async () => {
    const kit = bench()
    await settle()
    kit.host.end()
    await settle()
    kit.timers.flush()
    await settle()
    const hostOpensAtTrip = kit.openHost.mock.calls.length
    expect(hostOpensAtTrip).toBe(2)
    expect(kit.carrierLost).toHaveBeenCalledTimes(1)
    kit.timers.flush()
    await settle()
    expect(kit.openHost.mock.calls.length).toBe(hostOpensAtTrip)
    kit.mux.end()
    kit.timers.flush()
    await settle()
    expect(kit.openMux.mock.calls.length).toBe(1)
  })
})
