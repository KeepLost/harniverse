/**
 * NotifyDetector unit folds: turn settlements read the durable reason,
 * pending requests ring once per rpcId until they resolve, job terminal
 * edges ring from running/stopping only (killed stays silent), the goal
 * projection rings on the blocked entry alone, and disposed sessions drop
 * their edge state.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { NotifyDetector, type NotifyOccurrence } from '../src/notify-detector.ts'

const sid = (s: string): SessionId => s as SessionId

const turnEnd = (reason: { kind: string }): SessionEvent =>
  ({ type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason } }) as unknown as SessionEvent

function detector(): { sink: ReturnType<typeof vi.fn>; d: NotifyDetector } {
  const sink = vi.fn<(occurrence: NotifyOccurrence) => void>()
  return { sink, d: new NotifyDetector(sink) }
}

describe('turn settlements', () => {
  it('rings completion and failure from the durable reason and stays silent otherwise', () => {
    const { sink, d } = detector()
    d.sessionEvent(sid('s1'), turnEnd({ kind: 'completed' }))
    d.sessionEvent(sid('s1'), turnEnd({ kind: 'error' }))
    d.sessionEvent(sid('s1'), turnEnd({ kind: 'aborted' }))
    d.sessionEvent(sid('s1'), turnEnd({ kind: 'max-tokens' }))
    d.sessionEvent(sid('s1'), { type: 'turn/start', seq: 2, time: 1, data: { turn: 1 } } as unknown as SessionEvent)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenNthCalledWith(1, { kind: 'completion', sessionId: sid('s1'), sourceKey: 'session:s1' })
    expect(sink).toHaveBeenNthCalledWith(2, { kind: 'failure', sessionId: sid('s1'), sourceKey: 'session:s1:failure' })
  })
})

describe('pending requests', () => {
  it('rings once per rpcId and again after the resolution', () => {
    const { sink, d } = detector()
    const questions = [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }]
    d.approvalRequested(sid('s1'), 'r1')
    d.approvalRequested(sid('s1'), 'r1')
    d.questionRequested(sid('s1'), 'r2', questions)
    d.questionRequested(sid('s1'), 'r2', questions)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenNthCalledWith(1, { kind: 'approval', sessionId: sid('s1'), sourceKey: 'pending:s1:approval' })
    expect(sink).toHaveBeenNthCalledWith(2, { kind: 'question', sessionId: sid('s1'), sourceKey: 'pending:s1:question', questions })
    d.pendingResolved('approval', 'r1')
    d.pendingResolved('question', 'r2')
    d.approvalRequested(sid('s1'), 'r1')
    d.questionRequested(sid('s1'), 'r2', questions)
    expect(sink).toHaveBeenCalledTimes(4)
  })
})

describe('job terminal edges', () => {
  it('rings running→completed/failed, stays silent on killed and cold terminals', () => {
    const { sink, d } = detector()
    d.jobsSnapshot(sid('s1'), [{ id: 'j1', status: 'completed' }])
    expect(sink).not.toHaveBeenCalled()
    d.jobsSnapshot(sid('s1'), [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'stopping' }])
    expect(sink).not.toHaveBeenCalled()
    d.jobsSnapshot(sid('s1'), [
      { id: 'j1', status: 'completed' },
      { id: 'j2', status: 'failed' },
      { id: 'j3', status: 'running' },
    ])
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenNthCalledWith(1, { kind: 'completion', sessionId: sid('s1'), sourceKey: 'job:s1:j1' })
    expect(sink).toHaveBeenNthCalledWith(2, { kind: 'failure', sessionId: sid('s1'), sourceKey: 'job:s1:j2' })
    d.jobsSnapshot(sid('s1'), [{ id: 'j3', status: 'killed' }])
    expect(sink).toHaveBeenCalledTimes(2)
  })

  it('forgets a session\'s job state when the session is disposed and drops vanished jobs', () => {
    const { sink, d } = detector()
    d.jobsSnapshot(sid('s1'), [{ id: 'j1', status: 'running' }])
    d.jobsSnapshot(sid('s2'), [{ id: 'j2', status: 'running' }])
    d.sessionDisposed(sid('s1'))
    d.jobsSnapshot(sid('s1'), [{ id: 'j1', status: 'completed' }])
    expect(sink).not.toHaveBeenCalled()
    d.jobsSnapshot(sid('s2'), [{ id: 'j2', status: 'running' }])
    d.jobsSnapshot(sid('s2'), [])
    d.jobsSnapshot(sid('s2'), [{ id: 'j2', status: 'running' }])
    d.jobsSnapshot(sid('s2'), [{ id: 'j2', status: 'completed' }])
    expect(sink).toHaveBeenCalledTimes(1)
  })
})

describe('goal projection', () => {
  it('rings only the entry into blocked', () => {
    const { sink, d } = detector()
    d.goalProjection(sid('s1'), { phase: 'running' })
    d.goalProjection(sid('s1'), { phase: 'blocked' })
    d.goalProjection(sid('s1'), { phase: 'blocked' })
    d.goalProjection(sid('s1'), { phase: 'running' })
    d.goalProjection(sid('s1'), { phase: 'blocked' })
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenNthCalledWith(1, { kind: 'goal-blocked', sessionId: sid('s1'), sourceKey: 'goal:s1' })
    d.goalProjection(sid('s1'), 'not-an-object')
    d.goalProjection(sid('s1'), { phase: 42 })
    expect(sink).toHaveBeenCalledTimes(2)
  })
})

describe('agent errors', () => {
  it('rings failure with the session-scoped key', () => {
    const { sink, d } = detector()
    d.agentError(sid('s1'))
    expect(sink).toHaveBeenCalledWith({ kind: 'failure', sessionId: sid('s1'), sourceKey: 'session:s1:failure' })
  })
})
