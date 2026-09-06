import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, createToolResultMessage, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId, compactCheckpointSource, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(CompactionInvariant)
  return ctx
}

const TEST_COMPACTION_ID = CompactionId('test-compaction')
const NEXT_COMPACTION_ID = CompactionId('next-test-compaction')
const TEST_COMMAND_ID = CommandId('test-command')
const NEXT_COMMAND_ID = CommandId('next-test-command')
const TEST_CALL_ID = CallId('test-call')

const summary = (overrides: Record<string, unknown> = {}) => ({
  compactionId: TEST_COMPACTION_ID,
  summary: [{ type: 'text' as const, text: 'short' }],
  shadowedRange: { start: 2, end: 4 },
  shadowedSeqs: [2, 3, 4],
  shadowedTokenCount: 12,
  provider: 'mock',
  model: 'mock',
  ...overrides,
})

function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function appendCheckpoint(
  session: Session,
  startSeq: number,
  summarySeq: number,
  shadowedSeqs: number[],
  sourceCommandId?: CommandId,
): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'checkpoint' }],
    source: compactCheckpointSource(TEST_COMPACTION_ID, sourceCommandId),
  }), {
    surfaceOp: { op: 'replace', start: shadowedSeqs[0]!, end: shadowedSeqs.at(-1)! },
    sourceEventSeqs: [startSeq, summarySeq, ...shadowedSeqs],
  })
}

function appendToolResult(session: Session, text: string): number {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: TEST_CALL_ID,
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
}

function appendPruneReplacement(session: Session, originalSeq: number, text = 'short'): void {
  const original = session.events[originalSeq]
  if (original?.type !== 'tool/result') throw new Error('expected original tool result')
  const result = original.data.message.content[0]
  session.append('tool/result', {
    ...original.data,
    message: freezeMessage({
      ...original.data.message,
      content: [{
        ...result,
        content: [{ type: 'text', text }],
      }],
    }),
  }, {
    surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq },
    sourceEventSeqs: [originalSeq],
  })
}

function startTurn(session: ReturnType<Context['sessions']['create']>, turn = 1): void {
  session.append('turn/start', { turn })
}

describe('compaction invariants', () => {
  it('accepts successful and failed compaction lifecycles', async () => {
    const ctx = await setup()
    const success = ctx.sessions.create()
    const shadowedSeqs = [appendUser(success, 'one'), appendUser(success, 'two')]
    startTurn(success)
    const start = success.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const summarized = success.append('compaction/summary', summary({
      shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[1] },
      shadowedSeqs,
    }))
    appendCheckpoint(success, start.seq, summarized.seq, shadowedSeqs)
    success.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1 })

    const failed = ctx.sessions.create()
    startTurn(failed, 2)
    failed.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 2 })
    failed.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 2, error: 'provider failed' })
  })

  it('accepts standalone successful and failed compaction lifecycles between turns', async () => {
    const ctx = await setup()
    const success = ctx.sessions.create()
    const shadowedSeqs = [appendUser(success, 'one')]
    const start = success.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    const summarized = success.append('compaction/summary', summary({
      shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[0] },
      shadowedSeqs,
    }))
    appendCheckpoint(success, start.seq, summarized.seq, shadowedSeqs)
    success.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null })

    const failed = ctx.sessions.create()
    failed.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    failed.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null, error: 'provider failed' })
  })

  it('accepts a compaction surface span whose sequence values descend', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    appendUser(session, 'zero')
    appendUser(session, 'one')
    appendUser(session, 'two')
    const prior = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior replacement' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] })
    const start = session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const summarized = session.append('compaction/summary', summary({
      shadowedRange: { start: prior.seq, end: 3 },
      shadowedSeqs: [prior.seq, 3],
    }))
    appendCheckpoint(session, start.seq, summarized.seq, [prior.seq, 3])
    session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1 })

    expect(session.surface.nodes).toEqual([summarized.seq + 1])
  })

  it('rejects shadow provenance containing active events outside the declared range', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const outside = appendUser(session, 'outside')
    const first = appendUser(session, 'first')
    const last = appendUser(session, 'last')
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })

    expect(() => session.append('compaction/summary', summary({
      shadowedRange: { start: first, end: last },
      shadowedSeqs: [first, outside, last],
    }))).toThrow(/shadowedSeqs must exactly match the current surface range/)
  })

  it('replays complete summary and prune replacement pairs', async () => {
    const source = Session.create(SessionId('complete-compaction-source'))
    const summarizedOriginal = appendUser(source, 'summarized original')
    const start = source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    const summarized = source.append('compaction/summary', summary({
      shadowedRange: { start: summarizedOriginal, end: summarizedOriginal },
      shadowedSeqs: [summarizedOriginal],
    }))
    appendCheckpoint(source, start.seq, summarized.seq, [summarizedOriginal])
    source.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null })
    const prunedOriginal = appendToolResult(source, 'long result')
    source.append('compaction/prune', {
      shadowedRange: { start: prunedOriginal, end: prunedOriginal },
      shadowedSeqs: [prunedOriginal],
      shadowedTokenCount: 3,
    })
    appendPruneReplacement(source, prunedOriginal)

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('complete-compaction-replay'), { seed: source.events })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(CompactionInvariant).then(() => undefined)).resolves.toBeUndefined()
  })

  it('rejects an interrupted summary replacement while replaying', async () => {
    const source = Session.create(SessionId('interrupted-summary-source'))
    const original = appendUser(source, 'original')
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    source.append('compaction/summary', summary({
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
    }))
    appendUser(source, 'interruption')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('interrupted-summary-replay'), { seed: source.events })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(CompactionInvariant).then(() => undefined))
      .rejects.toThrow(/compaction\/summary must be immediately followed/)
  })

  it('clears an inherited open compaction trace at end-seed during replay', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = Session.create(SessionId('stale-compaction-source'))
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    const replayed = ctx.sessions.create(SessionId('stale-compaction-replay'), {
      seed: source.events,
    })
    expect(replayed.events.map(event => event.type))
      .toEqual(['compaction/start', 'session/end-seed'])

    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CompactionInvariant)

    expect(() => {
      replayed.append('compaction/start', { compactionId: NEXT_COMPACTION_ID, turn: null })
      replayed.append('compaction/end', { compactionId: NEXT_COMPACTION_ID, turn: null, error: 'new attempt failed' })
    }).not.toThrow()
  })

  it('allows repair turn boundaries after end-seed clears a seeded numbered orphan', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = Session.create(SessionId('stale-numbered-compaction-source'))
    startTurn(source)
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const replayed = ctx.sessions.create(SessionId('stale-numbered-compaction-replay'), {
      seed: source.events,
    })
    expect(replayed.events.map(event => event.type))
      .toEqual(['turn/start', 'compaction/start', 'session/end-seed'])

    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CompactionInvariant)

    expect(() => replayed.append(
      'turn/end',
      { turn: 1, reason: { kind: 'interrupted' } },
    )).not.toThrow()
  })

  it('accepts inherited repair boundaries before the end-seed that clears a standalone orphan', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = Session.create(SessionId('stale-repaired-compaction-source'))
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    startTurn(source)
    source.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    const replayed = ctx.sessions.create(SessionId('stale-repaired-compaction-replay'), {
      seed: source.events,
    })
    expect(replayed.events.map(event => event.type)).toEqual([
      'compaction/start',
      'turn/start',
      'turn/end',
      'session/end-seed',
    ])

    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(CompactionInvariant).then(() => undefined)).resolves.toBeUndefined()

    expect(() => {
      startTurn(replayed, 2)
      replayed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('rejects a closed standalone bracket that contains a turn before end-seed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = Session.create(SessionId('closed-nested-compaction-source'))
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    startTurn(source)
    source.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    source.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null, error: 'failed after crossing turn' })
    const replayed = ctx.sessions.create(SessionId('closed-nested-compaction-replay'), {
      seed: source.events,
    })
    expect(replayed.events.at(-1)?.type).toBe('session/end-seed')

    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(CompactionInvariant).then(() => undefined))
      .rejects.toThrow(/turn\/start cannot cross an open standalone compaction/)
  })

  it('rebuilds an open trace when the companion loads after the session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CompactionInvariant)
    expect(() => session.append('compaction/end', {
      compactionId: TEST_COMPACTION_ID,
      turn: 1,
      error: 'resume failed',
    })).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('adopts a bare session and ignores unrelated committed events', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('bare-compaction-session'))
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: 0, time: 0,
        data: { turn: 1 },
      })
      ctx.emit('session/event', session, {
        type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 },
      })
      ctx.emit('session/event', session, {
        type: 'compaction/start', seq: 2, time: 2,
        data: { compactionId: TEST_COMPACTION_ID, turn: 1 },
      })
    }).not.toThrow()
  })

  it('rejects compaction outside or for a different open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 }))
      .toThrow(/outside any open turn/)
    startTurn(session)
    expect(() => session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 2 }))
      .toThrow(/but open turn is 1/)
  })

  it('rejects a standalone bracket while a turn is open and a numbered bracket between turns', async () => {
    const ctx = await setup()
    const open = ctx.sessions.create()
    startTurn(open)
    expect(() => open.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null }))
      .toThrow(/standalone but turn 1 is open/)

    const idle = ctx.sessions.create()
    expect(() => idle.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 }))
      .toThrow(/outside any open turn/)
  })

  it('attributes a nested standalone start to the standalone owner', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    expect(() => session.append('compaction/start', { compactionId: NEXT_COMPACTION_ID, turn: null }))
      .toThrow(/standalone compaction is still compacting/)
  })

  it('rejects an unenclosed compaction event when replaying an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(CompactionInvariant).then(() => undefined)).rejects.toThrow(/outside any open turn/)
  })

  it('rejects turn boundaries that cross live standalone or numbered compaction brackets', async () => {
    const ctx = await setup()
    const standalone = ctx.sessions.create()
    standalone.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    expect(() => { startTurn(standalone) })
      .toThrow(/turn\/start cannot cross an open standalone compaction/)
    standalone.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null, error: 'cancelled' })
    expect(() => {
      startTurn(standalone)
      standalone.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()

    const numbered = ctx.sessions.create()
    startTurn(numbered)
    numbered.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    expect(() => numbered.append(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
    )).toThrow(/turn\/end cannot cross an open compaction for turn 1/)
    numbered.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1, error: 'cancelled' })
    expect(() => numbered.append(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
    )).not.toThrow()
  })

  it('requires the summary replacement to be the immediately following event', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = appendUser(session, 'original')
    startTurn(session)
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    session.append('compaction/summary', summary({
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
    }))

    expect(() => session.append('request/context', {
      provider: 'mock',
      model: 'mock',
    })).toThrow(/compaction\/summary must be immediately followed/)
  })

  it.each([
    ['range', [0, 1, 2, 3], { start: 1, end: 1 }, /range must exactly match/],
    ['missing provenance', [1, 2], { start: 0, end: 0 }, /sourceEventSeqs must exactly equal/],
    ['extraneous provenance', [0, 1, 2, 3], { start: 0, end: 0 }, /sourceEventSeqs must exactly equal/],
    ['out-of-order provenance', [1, 0, 2], { start: 0, end: 0 }, /sourceEventSeqs must exactly equal/],
  ])('rejects a summary replacement with the wrong %s', async (_name, provenance, range, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const originals = [appendUser(session, 'one'), appendUser(session, 'two')]
    startTurn(session)
    const start = session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const summarized = session.append('compaction/summary', summary({
      shadowedRange: { start: originals[0], end: originals[0] },
      shadowedSeqs: [originals[0]],
    }))
    let sourceEventSeqs = provenance.map((seq) => {
      if (seq === 0) return start.seq
      if (seq === 1) return summarized.seq
      if (seq === 2) return originals[0]!
      if (seq === 3) return originals[1]!
      return seq
    })
    const surfaceOp = range.start === 0
      ? { op: 'replace' as const, start: originals[0]!, end: originals[0]! }
      : { op: 'replace' as const, start: originals[1]!, end: originals[1]! }
    if (range.start !== 0) sourceEventSeqs = [start.seq, summarized.seq, ...originals]

    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(TEST_COMPACTION_ID),
    }), { surfaceOp, sourceEventSeqs })).toThrow(message)
  })

  it.each([
    ['compaction id', compactCheckpointSource(NEXT_COMPACTION_ID), /checkpoint id .* does not match/],
    ['source command id', compactCheckpointSource(TEST_COMPACTION_ID, NEXT_COMMAND_ID), /checkpoint sourceCommandId .* does not match/],
  ])('rejects a summary replacement with the wrong checkpoint %s', async (_name, source, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = appendUser(session, 'original')
    startTurn(session)
    const start = session.append('compaction/start', {
      compactionId: TEST_COMPACTION_ID,
      sourceCommandId: TEST_COMMAND_ID,
      turn: 1,
    })
    const summarized = session.append('compaction/summary', summary({
      sourceCommandId: TEST_COMMAND_ID,
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
    }))

    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source,
    }), {
      surfaceOp: { op: 'replace', start: original, end: original },
      sourceEventSeqs: [start.seq, summarized.seq, original],
    })).toThrow(message)
  })

  it.each([
    ['successful', undefined],
    ['failed', 'commit failed'],
  ])('does not allow a %s end to abandon a pending summary replacement', async (_name, error) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = appendUser(session, 'original')
    startTurn(session)
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    session.append('compaction/summary', summary({
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
    }))

    expect(() => session.append('compaction/end', {
      compactionId: TEST_COMPACTION_ID,
      turn: 1,
      ...error === undefined ? {} : { error },
    })).toThrow(/compaction\/summary must be immediately followed/)
  })

  it('does not commit a staged replacement when a later precommit listener vetoes it', async () => {
    const ctx = await setup()
    let veto = true
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
      const [, event] = args as [Session, SessionEvent]
      if (eventName === 'session/event'
        && event?.type === 'user/message'
        && isCompactCheckpointSource(event.data.source)
        && veto) {
        veto = false
        throw new Error('later precommit veto')
      }
    }, { global: true })
    const session = ctx.sessions.create()
    const original = appendUser(session, 'original')
    startTurn(session)
    const start = session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const summarized = session.append('compaction/summary', summary({
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
    }))
    expect(() => { appendCheckpoint(session, start.seq, summarized.seq, [original]) })
      .toThrow(/later precommit veto/)

    expect(() => {
      appendCheckpoint(session, start.seq, summarized.seq, [original])
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    }).not.toThrow()
  })

  it('accepts a prune followed immediately by its exact tool-result replacement', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = appendToolResult(session, 'long result')
    session.append('compaction/prune', {
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
      shadowedTokenCount: 3,
    })

    expect(() => { appendPruneReplacement(session, original) }).not.toThrow()
  })

  it('requires the prune replacement to be the immediately following event', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = appendToolResult(session, 'long result')
    session.append('compaction/prune', {
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
      shadowedTokenCount: 3,
    })

    expect(() => appendUser(session, 'interruption'))
      .toThrow(/compaction\/prune must be immediately followed/)
  })

  it.each([
    ['range', true, false, /range must exactly match/],
    ['provenance', false, true, /sourceEventSeqs must exactly equal/],
  ])('rejects a prune replacement with the wrong %s', async (_name, wrongRange, wrongProvenance, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = appendToolResult(session, 'long result')
    const other = appendToolResult(session, 'other result')
    session.append('compaction/prune', {
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
      shadowedTokenCount: 3,
    })
    const target = wrongRange ? other : original
    const targetEvent = session.events[target]
    if (targetEvent?.type !== 'tool/result') throw new Error('expected target tool result')
    const targetResult = targetEvent.data.message.content[0]

    expect(() => session.append('tool/result', {
      ...targetEvent.data,
      message: freezeMessage({
        ...targetEvent.data.message,
        content: [{
          ...targetResult,
          content: [{ type: 'text', text: 'short' }],
        }],
      }),
    }, {
      surfaceOp: { op: 'replace', start: target, end: target },
      sourceEventSeqs: wrongProvenance ? [original, other] : [target],
    })).toThrow(message)
  })

  it.each([
    ['empty shadow set', { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [], shadowedTokenCount: 0 }, /shadowedSeqs must be non-empty/],
    ['invalid shadow seq', { shadowedRange: { start: -1, end: -1 }, shadowedSeqs: [-1], shadowedTokenCount: 0 }, /non-negative safe integers/],
    ['wrong endpoints', { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 3], shadowedTokenCount: 0 }, /shadowedRange must match/],
    ['invalid token count', { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: -1 }, /non-negative safe integer/],
  ])('rejects prune metadata with %s', async (_name, data, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => session.append('compaction/prune', data)).toThrow(message)
  })

  it('rejects invalid shadow ranges before matching the current surface', async () => {
    const ctx = await setup()
    const invalidEndpoints = ctx.sessions.create()
    invalidEndpoints.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    expect(() => invalidEndpoints.append('compaction/summary', summary({
      shadowedRange: { start: -1, end: 0 },
      shadowedSeqs: [0],
    }))).toThrow(/shadowedRange endpoints must be non-negative safe integers/)

    const missingSurface = ctx.sessions.create()
    missingSurface.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    expect(() => missingSurface.append('compaction/summary', summary({
      shadowedRange: { start: 2, end: 2 },
      shadowedSeqs: [2],
    }))).toThrow(/shadowedSeqs must exactly match the current surface range/)
  })

  it('rejects a checkpoint without a replacement surface operation', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = appendUser(session, 'original')
    startTurn(session)
    const start = session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const summarized = session.append('compaction/summary', summary({
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
    }))

    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(TEST_COMPACTION_ID),
    }), {
      surfaceOp: 'append',
      sourceEventSeqs: [start.seq, summarized.seq, original],
    })).toThrow(/compaction\/summary must be immediately followed/)
  })

  it('rejects a pending replacement with a non-adjacent replay sequence', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = appendUser(session, 'original')
    startTurn(session)
    const start = session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const summarized = session.append('compaction/summary', summary({
      shadowedRange: { start: original, end: original },
      shadowedSeqs: [original],
    }))
    const checkpoint: SessionEvent = {
      type: 'user/message',
      seq: summarized.seq + 2,
      time: 0,
      data: {
        ...createUserMessage({
          content: [{ type: 'text', text: 'checkpoint' }],
          source: compactCheckpointSource(TEST_COMPACTION_ID),
        }),
      },
      surfaceOp: { op: 'replace', start: original, end: original },
      sourceEventSeqs: [start.seq, summarized.seq, original],
    }

    expect(() => {
      ctx.emit('internal/dispatch', 'emit', 'session/event', [session, checkpoint], null)
    })
      .toThrow(/replacement must have seq/)
  })

  it('rejects a replacement checkpoint for another compaction transaction', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    startTurn(session)
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    session.append('compaction/summary', summary({
      shadowedRange: { start: original.seq, end: original.seq },
      shadowedSeqs: [original.seq],
    }))

    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(NEXT_COMPACTION_ID),
    }), {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq],
    })).toThrow(/compaction checkpoint id .* does not match compaction\/start id/)
  })

  it('requires checkpoint provenance to name an open transaction', async () => {
    const ctx = await setup()
    const withoutStart = ctx.sessions.create()
    const original = withoutStart.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => withoutStart.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(TEST_COMPACTION_ID),
    }), {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq],
    })).toThrow(/no matching pending compaction\/summary/)

    const emptyCommand = ctx.sessions.create()
    const replaced = emptyCommand.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    startTurn(emptyCommand)
    const start = emptyCommand.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const summarized = emptyCommand.append('compaction/summary', summary({
      shadowedRange: { start: replaced.seq, end: replaced.seq },
      shadowedSeqs: [replaced.seq],
    }))
    expect(() => emptyCommand.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(TEST_COMPACTION_ID, CommandId('')),
    }), {
      surfaceOp: { op: 'replace', start: replaced.seq, end: replaced.seq },
      sourceEventSeqs: [start.seq, summarized.seq, replaced.seq],
    })).toThrow(/checkpoint sourceCommandId must be a non-empty string/)
  })

  it.each([
    ['empty start id', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: CompactionId(''), turn: 1 })
    }, /compaction\/start compactionId must be a non-empty string/],
    ['empty start source command id', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: CommandId(''),
        turn: 1,
      })
    }, /compaction\/start sourceCommandId must be a non-empty string/],
    ['summary without start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/summary', summary())
    }, /no matching compaction\/start/],
    ['nested start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/start', { compactionId: NEXT_COMPACTION_ID, turn: 2 })
    }, /still compacting/],
    ['repeated summary', (session: ReturnType<Context['sessions']['create']>) => {
      const original = appendUser(session, 'original')
      const start = session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      const summarized = session.append('compaction/summary', summary({
        shadowedRange: { start: original, end: original },
        shadowedSeqs: [original],
      }))
      appendCheckpoint(session, start.seq, summarized.seq, [original])
      session.append('compaction/summary', summary({
        shadowedRange: { start: summarized.seq + 1, end: summarized.seq + 1 },
        shadowedSeqs: [summarized.seq + 1],
      }))
    }, /repeated within one compaction/],
    ['summary for another compaction', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary({ compactionId: NEXT_COMPACTION_ID }))
    }, /compaction\/summary id .* does not match compaction\/start id/],
    ['summary for another source command', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: TEST_COMMAND_ID,
        turn: 1,
      })
      session.append('compaction/summary', summary({ sourceCommandId: NEXT_COMMAND_ID }))
    }, /compaction\/summary sourceCommandId .* does not match compaction\/start sourceCommandId/],
    ['empty shadow set', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary({ shadowedSeqs: [] }))
    }, /shadowedSeqs must be non-empty/],
    ['wrong endpoints', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary({ shadowedRange: { start: 1, end: 4 } }))
    }, /shadowedRange must match/],
    ['invalid token count', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary({ shadowedTokenCount: -1 }))
    }, /non-negative safe integer/],
    ['end without start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1, error: 'failed' })
    }, /no matching compaction\/start/],
    ['wrong end turn', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 2, error: 'failed' })
    }, /does not match/],
    ['end for another compaction', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/end', { compactionId: NEXT_COMPACTION_ID, turn: 1, error: 'failed' })
    }, /compaction\/end id .* does not match compaction\/start id/],
    ['end missing the source command', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: TEST_COMMAND_ID,
        turn: 1,
      })
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1, error: 'failed' })
    }, /compaction\/end sourceCommandId .* does not match compaction\/start sourceCommandId/],
    ['empty end source command id', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: TEST_COMMAND_ID,
        turn: 1,
      })
      session.append('compaction/end', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: CommandId(''),
        turn: 1,
        error: 'failed',
      })
    }, /compaction\/end sourceCommandId must be a non-empty string/],
    ['success without summary', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    }, /requires one compaction\/summary/],
  ])('rejects %s', async (_name, action, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    expect(() => { action(session) }).toThrow(message)
  })
})
