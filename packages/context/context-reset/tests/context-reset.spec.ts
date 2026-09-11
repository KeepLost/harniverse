import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ContextResetError,
  ContextResetService,
  isResetCheckpointSource,
  ResetId,
  resetCheckpointContent,
  resetCheckpointSource,
} from '@deepseek-ai/dsh-context-reset'

const SIGNAL = new AbortController().signal

/** Seed one closed three-node surface exchange and return the raw session. */
function seededSession(name = 'context-reset'): Session {
  const session = Session.create(SessionId(name))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'first answer' }],
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'second prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session
}

interface AgentScript {
  readonly status?: Agent['status']
  /** When set, `runMaintenance` throws before admitting the task. */
  readonly busy?: boolean
  /** Maintenance signal forwarded to admitted tasks. */
  readonly maintenanceSignal?: AbortSignal
  /** Resolves `whenIdle` only when released; omit for immediate resolution. */
  readonly idleGate?: Promise<void>
}

/** A minimal agent stub exercising the service's idle-maintenance contract. */
function fakeAgent(session: Session, script: AgentScript = {}): Agent {
  return {
    id: session.id,
    session,
    options: {},
    status: script.status ?? 'idle',
    whenIdle: () => script.idleGate ?? Promise.resolve(),
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (script.busy === true) throw new Error('agent already has active work')
      return task(script.maintenanceSignal ?? new AbortController().signal)
    },
  } as unknown as Agent
}

interface Harness {
  readonly ctx: Context
  readonly service: ContextResetService
  readonly flush: MockInstance<(session: Session) => Promise<boolean>>
}

/** Service over a real session store with an observable flush barrier. */
function harness(flushMode: 'resolve' | 'reject' = 'resolve'): Harness {
  const ctx = new Context()
  void new SessionStore(ctx)
  const service = new ContextResetService(ctx)
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(() => {
    if (flushMode === 'reject') return Promise.reject(new Error('flush failed'))
    return Promise.resolve(true)
  })
  return { ctx, service, flush }
}

/** Surface intent of one appended event, when present. */
function surfaceIntentOf(event: SessionEvent): unknown {
  return (event as SessionEvent & { surfaceOp?: unknown }).surfaceOp
}

describe('context-reset checkpoint leaf', () => {
  it('builds correlated provenance and recognizes only reset checkpoints', () => {
    const resetId = ResetId('leaf-test')
    expect(resetCheckpointSource(resetId)).toStrictEqual({
      kind: 'plugin',
      plugin: 'reset',
      resetId,
    })
    expect(Object.isFrozen(resetCheckpointSource(resetId))).toBe(true)
    expect(resetCheckpointSource(resetId, 'cmd-1' as never)).toStrictEqual({
      kind: 'plugin',
      plugin: 'reset',
      resetId,
      sourceCommandId: 'cmd-1',
    })
    expect(isResetCheckpointSource(resetCheckpointSource(resetId))).toBe(true)
    expect(isResetCheckpointSource({ kind: 'user' } as never)).toBe(false)
    expect(isResetCheckpointSource({ kind: 'plugin', plugin: 'compact' } as never)).toBe(false)
  })

  it('pins one verbatim marker content block', () => {
    const content = resetCheckpointContent()
    expect(content).toHaveLength(1)
    expect(content).toHaveLength(1)
    const block = content[0] as { type: string; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toMatch(/^This is an automatically generated context reset\./u)
    expect(block.text).toMatch(/without acknowledging this marker\.$/u)
  })
})

describe('contextReset.resetNow', () => {
  it('replaces the whole surface with one durable checkpoint marker', async () => {
    const test = harness()
    const session = seededSession()
    const agent = fakeAgent(session)
    const result = await test.service.resetNow(agent, SIGNAL)
    if (result === null) throw new Error('expected a reset result')
    expect(result.resetId).toBeTypeOf('string')
    expect(result.checkpointSeq).toBe(3)
    expect(result.markerSeq).toBe(4)
    expect(result.shadowedSeqs).toEqual([0, 1, 2])
    expect(session.surface.nodes).toEqual([4])
    expect(session.events).toHaveLength(5)
    const marker = session.events[4]!
    if (marker.type !== 'user/message') throw new Error('expected a user/message marker')
    expect(surfaceIntentOf(marker)).toEqual({ op: 'replace', start: 0, end: 2 })
    expect((marker as SessionEvent & { sourceEventSeqs?: number[] }).sourceEventSeqs).toEqual([3, 0, 1, 2])
    expect(marker.data.source).toStrictEqual({ kind: 'plugin', plugin: 'reset', resetId: result.resetId })
    const derived = session.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]!.role).toBe('user')
    expect(derived[0]!.content).toEqual(resetCheckpointContent())
    expect(test.flush).toHaveBeenCalledWith(session)
    expect(test.flush).toHaveBeenCalledTimes(1)
  })

  it('correlates a manual command identity', async () => {
    const test = harness()
    const session = seededSession('context-reset-command')
    const result = await test.service.resetNow(fakeAgent(session), SIGNAL, 'cmd-9' as never)
    expect(result?.sourceCommandId).toBe('cmd-9')
    const marker = session.events[4]!
    if (marker.type !== 'user/message') throw new Error('expected a user/message marker')
    expect(marker.data.source).toStrictEqual({
      kind: 'plugin',
      plugin: 'reset',
      resetId: result?.resetId,
      sourceCommandId: 'cmd-9',
    })
  })

  it('returns null without appending or flushing on an empty surface', async () => {
    const test = harness()
    const session = Session.create(SessionId('context-reset-empty'))
    const result = await test.service.resetNow(fakeAgent(session), SIGNAL)
    expect(result).toBeNull()
    expect(session.events).toEqual([])
    expect(test.flush).not.toHaveBeenCalled()
  })

  it('waits out a running agent before claiming the idle phase', async () => {
    const test = harness()
    const session = seededSession('context-reset-running')
    let idle = false
    const agent = {
      id: session.id,
      session,
      options: {},
      status: 'running',
      whenIdle: (): Promise<void> => new Promise<void>((resolve) => {
        setTimeout(() => {
          idle = true
          ;(agent as unknown as { status: string }).status = 'idle'
          resolve()
        }, 0)
      }),
      runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
    } as unknown as Agent
    const result = await test.service.resetNow(agent, SIGNAL)
    expect(idle).toBe(true)
    expect(result?.markerSeq).toBe(4)
  })

  it('preserves the abort reason when waiting for a running agent is cancelled', async () => {
    const test = harness()
    const controller = new AbortController()
    const abort = new Error('operator cancelled')
    const agent = fakeAgent(seededSession('context-reset-abort-wait'), {
      status: 'running',
      idleGate: new Promise<void>(() => {}),
    })
    const operation = test.service.resetNow(agent, controller.signal)
    await Promise.resolve()
    controller.abort(abort)
    await expect(operation).rejects.toBe(abort)
  })

  it('rejects an already-aborted request with its exact reason', () => {
    const test = harness()
    const controller = new AbortController()
    const abort = new Error('aborted before start')
    controller.abort(abort)
    expect(() => test.service.resetNow(fakeAgent(seededSession()), controller.signal)).toThrow(abort)
  })

  it('classifies a rejected idle-maintenance claim as busy', async () => {
    const test = harness()
    const session = seededSession('context-reset-busy')
    const agent = fakeAgent(session, { busy: true })
    const error = await test.service.resetNow(agent, SIGNAL).then(
      () => { throw new Error('expected a rejection') },
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ContextResetError)
    expect((error as ContextResetError).code).toBe('busy')
    expect(session.events).toHaveLength(3)
  })

  it('classifies an agent-side cancellation as cancelled', async () => {
    const test = harness()
    const maintenance = new AbortController()
    const cancel = new Error('agent cancelled maintenance')
    maintenance.abort(cancel)
    const session = seededSession('context-reset-cancelled')
    const agent = fakeAgent(session, { maintenanceSignal: maintenance.signal })
    const error = await test.service.resetNow(agent, SIGNAL).then(
      () => { throw new Error('expected a rejection') },
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ContextResetError)
    expect((error as ContextResetError).code).toBe('cancelled')
  })

  it('preserves the caller abort reason when the request is cancelled mid-task', async () => {
    const test = harness()
    const controller = new AbortController()
    const abort = new Error('operator cancelled mid-task')
    const session = seededSession('context-reset-mid-abort')
    const agent = fakeAgent(session, {
      maintenanceSignal: new AbortController().signal,
    })
    test.flush.mockImplementation(() => {
      controller.abort(abort)
      return Promise.reject(new Error('flush failed after abort'))
    })
    await expect(test.service.resetNow(agent, controller.signal)).rejects.toBe(abort)
  })

  it('classifies a rejected marker append as commit without touching the surface', async () => {
    const test = harness()
    const session = seededSession('context-reset-commit')
    vi.spyOn(session, 'append').mockImplementation(() => {
      throw new Error('surface validation rejected the marker')
    })
    const error = await test.service.resetNow(fakeAgent(session), SIGNAL).then(
      () => { throw new Error('expected a rejection') },
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ContextResetError)
    expect((error as ContextResetError).code).toBe('commit')
    expect(session.surface.nodes).toEqual([0, 1, 2])
  })

  it('classifies a rejected durability flush as persistence after the marker lands', async () => {
    const test = harness('reject')
    const session = seededSession('context-reset-persistence')
    const error = await test.service.resetNow(fakeAgent(session), SIGNAL).then(
      () => { throw new Error('expected a rejection') },
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ContextResetError)
    expect((error as ContextResetError).code).toBe('persistence')
    expect(session.surface.nodes).toEqual([4])
  })

  it('drains an in-flight reset before the owning plugin settles disposal', async () => {
    const ctx = new Context()
    void new SessionStore(ctx)
    const fiber = await ctx.plugin(ContextResetService)
    const service = ctx.get('contextReset')
    if (service === undefined) throw new Error('service did not start')
    const session = seededSession('context-reset-drain')
    const started = Promise.withResolvers<undefined>()
    const allowFlush = Promise.withResolvers<undefined>()
    const flushed = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(() => {
      started.resolve(undefined)
      return allowFlush.promise.then(() => {
        flushed.resolve(undefined)
        return true
      })
    })

    const operation = service.resetNow(fakeAgent(session), SIGNAL)
    await started.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    let disposed = false
    const disposal = fiber.dispose()
    void disposal.then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disposed).toBe(false)

    allowFlush.resolve(undefined)
    await flushed.promise
    await expect(operation).resolves.toMatchObject({ markerSeq: 4 })
    await disposal
    expect(disposed).toBe(true)
  })
})
