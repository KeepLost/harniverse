/**
 * Body-limit recovery unit tests: classification pass-through, whole-history
 * image settlement with retry, compaction coordination, the bounded recovery
 * budget with its assistant-message reset, and cancellation. The compaction
 * engine is a stub; loader-level composition evidence lives with the bundle
 * tests.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { REQUEST_BODY_TOO_LARGE_CODE } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index.ts'

const SIGNAL = new AbortController().signal

/** One recorded compactIfNeeded call. */
interface CompactionCall {
  trigger: CompactionTrigger
  session: Session
}

/**
 * A stub engine recording triggers; `result` controls its return so the
 * retry decision's compaction leg is observable without surface surgery.
 */
class StubEngine extends CompactionEngine {
  readonly calls: CompactionCall[] = []
  result: CompactionResult | null = null
  failure: Error | undefined
  abortDuring: (() => void) | undefined

  override compactIfNeeded(agent: Agent, trigger: CompactionTrigger): Promise<CompactionResult | null> {
    this.calls.push({ trigger, session: agent.session })
    if (this.failure !== undefined) throw this.failure
    this.abortDuring?.()
    return Promise.resolve(this.result)
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.reject(new Error('compactRegion is outside these specs'))
  }

  protected override performCompactNow(): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }
}

/** Build a session carrying image-bearing user messages. */
function imageSession(images: number): Session {
  const session = Session.create(SessionId('body-limit'))
  session.append('turn/start', { turn: 1 })
  for (let index = 0; index < images; index += 1) {
    session.append('user/message', createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`image-${index}`),
          mediaType: 'image/png',
          bytes: 4,
          width: 1,
          height: 1,
        },
      }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  return session
}

/** Append one fresh image message so a recovery round has something to settle. */
function addImage(session: Session, id: string): void {
  session.append('user/message', createUserMessage({
    content: [{
      type: 'image',
      attachment: { attachmentId: AttachmentId(id), mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
    }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** One stub agent over the given session. */
function stubAgent(session: Session): Agent {
  return { session, options: {} } as Agent
}

interface Harness {
  ctx: Context
  engine: StubEngine
  readonly recover: (
    session: Session,
    failure: { code?: string; message?: string; status?: number },
    next?: () => Promise<RequestErrorAction>,
  ) => Promise<RequestErrorAction>
}

async function boot(): Promise<Harness> {
  const ctx = new Context()
  const engine = new StubEngine(ctx)
  void engine
  apply(ctx)
  return {
    ctx,
    engine,
    recover: (session, failure, next) => agentEvents(ctx, stubAgent(session)).waterfall(
      'agent/request-error',
      {
        turn: 1,
        step: 1,
        provider: 'test',
        failure: {
          message: failure.message ?? '413: Failed to buffer the request body: length limit exceeded',
          code: failure.code ?? REQUEST_BODY_TOO_LARGE_CODE,
          ...failure.status === undefined ? {} : { status: failure.status },
        },
        retryPolicy: undefined,
        signal: SIGNAL,
      },
      next ?? (() => Promise.resolve(undefined)),
    ),
  }
}

describe('classification', () => {
  it('passes non-body-limit failures through untouched', async () => {
    const { engine, recover } = await boot()
    const session = imageSession(2)
    const next = vi.fn(async () => Promise.resolve(undefined))
    await expect(recover(session, { code: 'RATE_LIMIT', message: '429 slow down' }, next)).resolves.toBeUndefined()
    expect(next).toHaveBeenCalledTimes(1)
    expect(session.events.some(event => event.type === 'image/offload')).toBe(false)
    expect(engine.calls).toHaveLength(0)
  })

  it('recognizes the provider wording without a classified code', async () => {
    const { recover } = await boot()
    const session = imageSession(1)
    await expect(recover(session, { code: 'PI_AI_ERROR', message: '413 Failed to buffer the request body: length limit exceeded' }))
      .resolves.toMatchObject({ kind: 'retry' })
  })

  it('passes through when the signal already aborted', async () => {
    const ctx = new Context()
    apply(ctx)
    const session = imageSession(1)
    const controller = new AbortController()
    controller.abort()
    const action = await agentEvents(ctx, stubAgent(session)).waterfall(
      'agent/request-error',
      {
        turn: 1,
        step: 1,
        provider: 'test',
        failure: { message: 'too large', code: REQUEST_BODY_TOO_LARGE_CODE },
        retryPolicy: undefined,
        signal: controller.signal,
      },
      () => Promise.resolve(undefined),
    )
    expect(action).toBeUndefined()
    expect(session.events.some(event => event.type === 'image/offload')).toBe(false)
  })
})

describe('recovery', () => {
  it('settles every retained image and retries the request', async () => {
    const { recover } = await boot()
    const session = imageSession(3)
    await expect(recover(session, {})).resolves.toMatchObject({ kind: 'retry' })
    const offloads = session.events.filter(event => event.type === 'image/offload')
    expect(offloads).toHaveLength(1)
    expect(offloads[0]?.data.targets.map(target => target.imageIndex)).toEqual([0, 0, 0])
    expect(session.events.findLast(event => event.type === 'user/message')?.seq).toBeTruthy()
  })

  it('forwards the context-overflow trigger and signal to the engine', async () => {
    const { engine, recover } = await boot()
    const session = imageSession(1)
    await recover(session, {})
    expect(engine.calls.map(call => call.trigger)).toEqual(['context-overflow'])
  })

  it('retries on a durable compaction reduction alone', async () => {
    const { engine, recover } = await boot()
    const session = imageSession(0)
    engine.result = {
      compactionId: 'stub' as never,
      startSeq: 1,
      summarySeq: 2,
      endSeq: 3,
      summary: [],
      shadowedSeqs: [1],
      shadowedRange: { start: 1, end: 1 },
      shadowedTokenCount: 10,
    }
    await expect(recover(session, {})).resolves.toMatchObject({ kind: 'retry' })
  })

  it('retries when compaction fails but images settled', async () => {
    const { engine, recover } = await boot()
    const session = imageSession(1)
    engine.failure = new Error('summarizer offline')
    await expect(recover(session, {})).resolves.toMatchObject({ kind: 'retry' })
  })

  it('preserves the original error when nothing could shrink', async () => {
    const { engine, recover } = await boot()
    const session = imageSession(0)
    await expect(recover(session, {})).resolves.toBeUndefined()
    expect(engine.calls).toHaveLength(1)
  })

  it('skips compaction entirely on a host without an engine', async () => {
    const ctx = new Context()
    apply(ctx)
    const session = imageSession(1)
    const action = await agentEvents(ctx, stubAgent(session)).waterfall(
      'agent/request-error',
      {
        turn: 1,
        step: 1,
        provider: 'test',
        failure: { message: '413 too large', code: REQUEST_BODY_TOO_LARGE_CODE },
        retryPolicy: undefined,
        signal: SIGNAL,
      },
      () => Promise.resolve(undefined),
    )
    expect(action).toMatchObject({ kind: 'retry' })
  })

  it('renders a non-Error compaction failure without crashing', async () => {
    const { engine, recover } = await boot()
    const session = imageSession(1)
    engine.failure = 'summarizer exploded' as unknown as Error
    await expect(recover(session, {})).resolves.toMatchObject({ kind: 'retry' })
  })

  it('preserves the original error when cancellation lands during compaction', async () => {
    const { ctx, engine } = await boot()
    const session = imageSession(1)
    const controller = new AbortController()
    engine.abortDuring = () => { controller.abort() }
    const action = await agentEvents(ctx, stubAgent(session)).waterfall(
      'agent/request-error',
      {
        turn: 1,
        step: 1,
        provider: 'test',
        failure: { message: '413 too large', code: REQUEST_BODY_TOO_LARGE_CODE },
        retryPolicy: undefined,
        signal: controller.signal,
      },
      () => Promise.resolve(undefined),
    )
    expect(action).toBeUndefined()
  })
})

describe('the recovery budget', () => {
  it('stops after three recoveries without an intervening response', async () => {
    const { recover } = await boot()
    const session = imageSession(0)
    for (let round = 0; round < 3; round += 1) {
      addImage(session, `budget-${round}`)
      await expect(recover(session, {})).resolves.toMatchObject({ kind: 'retry' })
    }
    // Still shrinkable, but the budget is spent: the original error stands.
    addImage(session, 'budget-3')
    await expect(recover(session, {})).resolves.toBeUndefined()
    expect(session.events.filter(event => event.type === 'image/offload')).toHaveLength(3)
  })

  it('resets after a successful assistant response', async () => {
    const { ctx, recover } = await boot()
    const session = imageSession(0)
    for (let round = 0; round < 3; round += 1) {
      addImage(session, `reset-${round}`)
      await expect(recover(session, {})).resolves.toMatchObject({ kind: 'retry' })
    }
    const assistant = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    ctx.emit('session/event', session, session.events[0] as never)
    ctx.emit('session/event', session, assistant)
    addImage(session, 'reset-3')
    await expect(recover(session, {})).resolves.toMatchObject({ kind: 'retry' })
  })
})
