import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NotificationBackend, {
  NotificationCoordinator,
  type NotificationEnvelope,
} from '../src/index.ts'

class CaptureBackend extends NotificationBackend {
  readonly events: NotificationEnvelope[] = []
  shutdown = vi.fn(async () => {})

  protected enqueue(event: NotificationEnvelope): void {
    this.events.push(event)
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const backendFiber = await ctx.plugin(CaptureBackend)
  let coordinator!: NotificationCoordinator
  const coordinatorFiber = await ctx.plugin({
    name: 'notification-capture',
    inject: ['sessions', 'notification'],
    apply(inner: Context) {
      coordinator = new NotificationCoordinator(inner, inner.notification)
    },
  })
  return {
    ctx,
    backend: ctx.notification as CaptureBackend,
    coordinator,
    coordinatorFiber,
    backendFiber,
  }
}

function session(ctx: Context, id = 'projection', parentSession?: string): Session {
  return ctx.sessions.create(SessionId(id), {
    meta: parentSession === undefined ? {} : { parentSession: SessionId(parentSession) },
  })
}

describe('NotificationCoordinator projection', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('projects durable turn, approval, and tool metadata in append order', async () => {
    const { ctx, backend } = await setup()
    const current = session(ctx, 'child', 'parent')
    const callId = CallId('call-1')
    const approvalId = ApprovalRequestId('approval-1')

    current.append('turn/start', { turn: 3 })
    current.append('approval/asked', {
      id: approvalId,
      toolName: 'bash',
      callId,
      reason: 'needs host access',
    })
    current.append('approval/decided', { id: approvalId, outcome: 'allowed-once' })
    current.append('tool/call', {
      turn: 3,
      step: 2,
      callId,
      name: 'bash',
      arguments: '{"command":"secret"}',
    })
    current.append('tool/result', {
      turn: 3,
      step: 2,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'private output' }],
        isError: true,
      }),
      error: { name: 'CommandError', code: 'EXIT_1' },
    }, { surfaceOp: 'append' })
    current.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    expect(backend.events.map(event => event.type)).toEqual([
      'approval.requested',
      'approval.decided',
      'tool.called',
      'tool.settled',
      'session.turn-settled',
    ])
    expect(backend.events).toMatchObject([
      {
        eventId: 'child:1',
        subject: { sessionId: 'child', parentSessionId: 'parent' },
        data: {
          approvalId: 'approval-1', toolName: 'bash', callId: 'call-1',
          turn: 3, seq: 1,
        },
      },
      { eventId: 'child:2', data: { approvalId: 'approval-1', outcome: 'allowed-once', turn: 3, seq: 2 } },
      { eventId: 'child:3', data: { callId: 'call-1', toolName: 'bash', turn: 3, step: 2, seq: 3 } },
      {
        eventId: 'child:4',
        data: {
          callId: 'call-1', toolName: 'bash', turn: 3, step: 2, seq: 4,
          ok: false, error: { name: 'CommandError', code: 'EXIT_1' },
        },
      },
      { eventId: 'child:5', data: { turn: 3, seq: 5, reason: { kind: 'completed' } } },
    ])
    expect(JSON.stringify(backend.events)).not.toContain('secret')
    expect(JSON.stringify(backend.events)).not.toContain('private output')
    expect(JSON.stringify(backend.events)).not.toContain('needs host access')
  })

  it('correlates a tool result by backscanning a call captured before mount', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const current = session(ctx, 'backscan')
    const callId = CallId('call-before')
    current.append('turn/start', { turn: 1 })
    current.append('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: '{}' })
    const backendFiber = await ctx.plugin(CaptureBackend)
    const coordinatorFiber = await ctx.plugin({
      name: 'late-notification-capture',
      inject: ['sessions', 'notification'],
      apply(inner: Context) {
        new NotificationCoordinator(inner, inner.notification)
      },
    })

    current.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [], isError: false }),
    }, { surfaceOp: 'append' })

    expect((ctx.notification as CaptureBackend).events).toMatchObject([{
      type: 'tool.settled',
      data: { callId: 'call-before', toolName: 'write', ok: true },
    }])
    await coordinatorFiber.dispose()
    await backendFiber.dispose()
  })

  it('projects operational status, detach, and explicit close as distinct events', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T13:00:00.000Z'))
    const { ctx, backend } = await setup()
    const current = session(ctx, 'ops', 'root')
    const agent = { id: 'ops', session: current } as Agent

    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('session/disposed', current)
    ctx.emit('session/closed', { sessionId: SessionId('ops'), parentSessionId: SessionId('root') })

    expect(backend.events.map(event => event.type)).toEqual([
      'agent.status-changed',
      'session.detached',
      'session.closed',
    ])
    expect(backend.events.map(event => event.occurredAt)).toEqual([
      '2026-08-15T13:00:00.000Z',
      '2026-08-15T13:00:00.000Z',
      '2026-08-15T13:00:00.000Z',
    ])
    expect(new Set(backend.events.map(event => event.eventId)).size).toBe(3)
  })

  it('represents interruption as a turn reason rather than another event type', async () => {
    const { ctx, backend } = await setup()
    const current = session(ctx, 'aborted')
    current.append('turn/start', { turn: 1 })
    current.append('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'private detail' } },
    })

    expect(backend.events).toMatchObject([{
      type: 'session.turn-settled',
      data: { reason: { kind: 'aborted', cause: 'hook' } },
    }])
    expect(JSON.stringify(backend.events)).not.toContain('private detail')
  })

  it('projects every stable turn reason without human-readable error detail', async () => {
    const { ctx, backend } = await setup()
    const reasons: TurnEndReason[] = [
      { kind: 'blocked' },
      { kind: 'error', error: { code: 'FAILED', message: 'private error detail' } },
      { kind: 'max-tokens' },
      { kind: 'interrupted' },
      { kind: 'provider-extension', detail: 'private extension detail' } as unknown as TurnEndReason,
    ]
    reasons.forEach((reason, turn) => {
      const current = session(ctx, `reason-${turn}`)
      current.append('turn/start', { turn })
      current.append('turn/end', { turn, reason })
    })

    expect(backend.events.map(event => event.data)).toMatchObject([
      { reason: { kind: 'blocked' } },
      { reason: { kind: 'error', error: { code: 'FAILED' } } },
      { reason: { kind: 'max-tokens' } },
      { reason: { kind: 'interrupted' } },
      { reason: { kind: 'unknown' } },
    ])
    expect(JSON.stringify(backend.events)).not.toContain('private')
  })

  it('projects compaction settlements with outcome metadata but no summary or error text', async () => {
    const { ctx, backend } = await setup()
    const current = session(ctx, 'compaction')

    const firstId = CompactionId('compact-1')
    const secondId = CompactionId('compact-2')
    const commandId = CommandId('command-1')
    current.append('compaction/start', { compactionId: firstId, turn: 4 })
    current.append('compaction/summary', {
      compactionId: firstId,
      summary: [{ type: 'text', text: 'private summary content' }],
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 2,
      provider: 'private-provider',
      model: 'private-model',
    })
    current.append('compaction/end', { compactionId: firstId, turn: 4 })
    current.append('compaction/start', { compactionId: secondId, turn: null, sourceCommandId: commandId })
    current.append('compaction/end', {
      compactionId: secondId,
      turn: null,
      sourceCommandId: commandId,
      error: 'private error text',
    })

    expect(backend.events.map(event => event.type)).toEqual(['compaction.settled', 'compaction.settled'])
    expect(backend.events.map(event => event.eventId)).toEqual(['compaction:2', 'compaction:4'])
    expect(backend.events.map(event => event.data)).toEqual([
      { compactionId: 'compact-1', turn: 4, seq: 2, ok: true },
      { compactionId: 'compact-2', turn: null, seq: 4, ok: false, sourceCommandId: 'command-1' },
    ])
    const serialized = JSON.stringify(backend.events)
    expect(serialized).not.toContain('private summary content')
    expect(serialized).not.toContain('private error text')
    expect(serialized).not.toContain('private-provider')
    expect(serialized).not.toContain('private-model')
  })

  it('projects a compaction end already present when a coordinator resumes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = session(ctx, 'source')
    const compactionId = CompactionId('resumed-1')
    source.append('compaction/start', { compactionId, turn: null })
    source.append('compaction/end', { compactionId, turn: null })
    ctx.sessions.create(SessionId('resumed'), { seed: source.events })
    const backendFiber = await ctx.plugin(CaptureBackend)
    const coordinatorFiber = await ctx.plugin({
      name: 'resumed-notification-capture',
      inject: ['sessions', 'notification'],
      apply(inner: Context) {
        new NotificationCoordinator(inner, inner.notification)
      },
    })

    expect((ctx.notification as CaptureBackend).events).toMatchObject([{
      eventId: 'resumed:1',
      type: 'compaction.settled',
      data: { compactionId: 'resumed-1', turn: null, seq: 1, ok: true },
    }])
    await coordinatorFiber.dispose()
    await backendFiber.dispose()
  })

  it('projects seeded compaction settlements when a resumed session is created after mount', async () => {
    const { ctx, backend } = await setup()
    const source = session(ctx, 'late-source')
    const compactionId = CompactionId('late-resumed-1')
    source.append('compaction/start', { compactionId, turn: null })
    source.append('compaction/end', { compactionId, turn: null })
    backend.events.length = 0

    ctx.sessions.create(SessionId('late-resumed'), { seed: source.events })

    expect(backend.events).toMatchObject([{
      eventId: 'late-resumed:1',
      type: 'compaction.settled',
      data: { compactionId: 'late-resumed-1', turn: null, seq: 1, ok: true },
    }])
  })

  it('does not re-emit inherited parent compactions as child settlements after a fork resumes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = session(ctx, 'fork-source')
    const inheritedId = CompactionId('inherited-compaction')
    source.append('compaction/start', { compactionId: inheritedId, turn: null })
    source.append('compaction/end', { compactionId: inheritedId, turn: null })
    const seedLength = source.events.length
    const childId = CompactionId('child-compaction')
    source.append('compaction/start', { compactionId: childId, turn: null })
    source.append('compaction/end', { compactionId: childId, turn: null })
    ctx.sessions.create(SessionId('fork-child'), {
      seed: source.events,
      meta: { parentSession: SessionId('fork-source'), seedLength },
    })

    await ctx.plugin(CaptureBackend)
    await ctx.plugin({
      name: 'fork-notification-capture',
      inject: ['sessions', 'notification'],
      apply(inner: Context) {
        new NotificationCoordinator(inner, inner.notification)
      },
    })

    const childEvents = (ctx.notification as CaptureBackend).events
      .filter(event => event.subject.sessionId === 'fork-child')
    expect(childEvents).toMatchObject([{
      eventId: 'fork-child:3',
      type: 'compaction.settled',
      data: { compactionId: 'child-compaction', seq: 3 },
    }])
    expect(childEvents).toHaveLength(1)
  })

  it('contains malformed source correlation and backend shutdown failures', async () => {
    const { ctx, backend, coordinatorFiber } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const current = session(ctx, 'malformed')
    const callId = CallId('missing-call')
    current.append('turn/start', { turn: 1 })
    current.append('tool/call', { turn: 1, step: 1, callId: CallId('other-call'), name: 'read', arguments: '{}' })
    current.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    current.append('approval/asked', { id: ApprovalRequestId('outside-turn'), toolName: 'bash' })
    current.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [], isError: false }),
    }, { surfaceOp: 'append' })
    backend.shutdown.mockRejectedValueOnce(new Error('shutdown failed'))

    await coordinatorFiber.dispose()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capture step failed'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('backend shutdown failed'))
  })

  it('removes listeners before awaiting backend shutdown', async () => {
    const { ctx, backend, coordinatorFiber } = await setup()
    const current = session(ctx, 'dispose')
    let resolveShutdown!: () => void
    backend.shutdown.mockImplementation(() => new Promise<void>((resolve) => { resolveShutdown = resolve }))

    const disposal = coordinatorFiber.dispose()
    await vi.waitFor(() => { expect(backend.shutdown).toHaveBeenCalledTimes(1) })
    current.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(backend.events).toEqual([])
    resolveShutdown()
    await disposal
  })
})
