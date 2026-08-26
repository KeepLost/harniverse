import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import {
  CompactionId,
  compactCheckpointSource,
} from '@deepseek-ai/dsh-compaction'
import {
  CompactionHistory,
  CompactionSummaryId,
  apply as applyLossless,
  truncateHistoryText,
} from '@deepseek-ai/dsh-compaction-lossless'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

function appendText(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function appendSummary(session: Session, sourceSeqs: number[], text: string): number {
  const compactionId = CompactionId(`dag-${session.seq}`)
  const start = session.append('compaction/start', { compactionId, turn: null })
  const summary = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text }],
    shadowedRange: { start: sourceSeqs[0]!, end: sourceSeqs.at(-1)! },
    shadowedSeqs: sourceSeqs,
    shadowedTokenCount: 100,
    provider: 'test',
    model: 'summary',
  })
  const checkpoint = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start: sourceSeqs[0]!, end: sourceSeqs.at(-1)! },
    sourceEventSeqs: [start.seq, summary.seq, ...sourceSeqs],
  })
  session.append('compaction/end', { compactionId, turn: null })
  return checkpoint.seq
}

describe('lossless compaction summary DAG', () => {
  it('attaches from the first event when the entered session was not announced in this realm', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.prepare()
    const detach = ctx.sessions.enter(session)

    appendText(session, 'entered before announcement')

    expect(ctx.compactionHistory.stats(session.id)).toEqual({ summaries: 0, maxDepth: 0 })
    detach()
  })

  it('rebuilds leaf and condensed nodes with expandable source lineage', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory, {
      maxSearchResults: 10,
      maxExpansionDepth: 4,
      maxExpansionTokens: 2_000,
    })
    const session = ctx.sessions.create()

    const first = appendText(session, 'alpha requirement with exact value 41')
    const second = appendText(session, 'beta decision')
    const leafCheckpoint = appendSummary(session, [first, second], 'alpha and beta summary')
    const third = appendText(session, 'gamma follow-up')
    appendSummary(session, [leafCheckpoint, third], 'condensed alpha beta gamma')

    expect(ctx.compactionHistory.stats(session.id)).toEqual({ summaries: 2, maxDepth: 1 })
    expect(ctx.compactionHistory.search(session.id, '   ')).toEqual([])
    const [leafHit] = ctx.compactionHistory.search(session.id, 'alpha beta summary')
    const leafExpansion = ctx.compactionHistory.expand(session.id, leafHit!.id, {
      maxDepth: 4,
      includeSources: true,
      tokenCap: 2_000,
    })
    expect(leafExpansion.sources).toEqual([
      { eventSeq: first, role: 'user', text: 'alpha requirement with exact value 41' },
      { eventSeq: second, role: 'user', text: 'beta decision' },
    ])

    const [hit] = ctx.compactionHistory.search(session.id, 'condensed gamma')
    expect(hit).toMatchObject({ kind: 'condensed', depth: 1 })
    expect(ctx.compactionHistory.search(session.id, 'alpha', 0)).toHaveLength(1)
    const expanded = ctx.compactionHistory.expand(session.id, hit!.id, {
      maxDepth: 2,
      includeSources: true,
      tokenCap: 2_000,
    })
    expect(expanded.parents).toHaveLength(1)
    expect(expanded.parents[0]).toMatchObject({
      kind: 'leaf',
      depth: 0,
      sources: [
        { eventSeq: first, role: 'user', text: 'alpha requirement with exact value 41' },
        { eventSeq: second, role: 'user', text: 'beta decision' },
      ],
    })
    expect(expanded.sources).toEqual([
      { eventSeq: third, role: 'user', text: 'gamma follow-up' },
    ])
    expect(expanded.truncated).toBe(false)
    expect(ctx.compactionHistory.expand(session.id, hit!.id, { maxDepth: 1 })).toMatchObject({
      parents: [],
      sources: [],
      truncated: true,
    })
    expect(ctx.compactionHistory.expand(session.id, hit!.id, { maxDepth: 2, tokenCap: 1 })).toMatchObject({
      parents: [],
      truncated: true,
    })
    expect(() => ctx!.compactionHistory.expand(session.id, CompactionSummaryId('missing'))).toThrow(/was not found/)
  })

  it('bounds returned summary and source text by the requested token estimate', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory, { maxExpansionTokens: 100 })
    const session = ctx.sessions.create()
    const source = appendText(session, 'source detail that must not fit')
    appendSummary(session, [source], 'summary content that is deliberately much longer than the cap')
    const [hit] = ctx.compactionHistory.search(session.id, 'deliberately')

    const expanded = ctx.compactionHistory.expand(session.id, hit!.id, {
      includeSources: true,
      tokenCap: 3,
    })

    expect(expanded.text).toBe('summary cont')
    expect(expanded.sources).toEqual([])
    expect(expanded.estimatedTokens).toBe(3)
    expect(expanded.truncated).toBe(true)

    const longSource = appendText(session, 'source detail that exceeds the remaining expansion budget')
    appendSummary(session, [longSource], 'tiny')
    const [tinyHit] = ctx.compactionHistory.search(session.id, 'tiny')
    const sourceBounded = ctx.compactionHistory.expand(session.id, tinyHit!.id, {
      includeSources: true,
      tokenCap: 2,
    })
    expect(sourceBounded.sources).toEqual([
      { eventSeq: longSource, role: 'user', text: 'sour' },
    ])
    expect(sourceBounded.truncated).toBe(true)

    const longSummary = `searchable ${'x'.repeat(300)}`
    appendSummary(session, [appendText(session, 'snippet source')], longSummary)
    const [longHit] = ctx.compactionHistory.search(session.id, 'searchable')
    expect(longHit!.snippet).toHaveLength(243)
    expect(longHit!.snippet).toMatch(/\.\.\.$/)
  })

  it('bounds non-ASCII text with the same deterministic estimate', () => {
    expect(truncateHistoryText('甲乙abc', 1)).toEqual({ text: '甲乙', tokens: 1, truncated: true })
    expect(truncateHistoryText('甲乙', 1)).toEqual({ text: '甲乙', tokens: 1, truncated: false })
  })

  it('counts non-ASCII summary text in search estimates', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.create()
    appendSummary(session, [appendText(session, 'source')], '甲乙 summary')

    expect(ctx.compactionHistory.search(session.id, '甲乙')).toMatchObject([{ tokenCount: 3 }])
  })

  it('renders non-text summary blocks and skips invalid source references', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.create()
    const source = appendText(session, 'replaceable source')
    const compactionId = CompactionId('non-text')
    const start = session.append('compaction/start', { compactionId, turn: null })
    const summary = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'reasoning', text: 'model reasoning' }],
      shadowedRange: { start: source, end: source },
      shadowedSeqs: [start.seq, 999],
      shadowedTokenCount: 8,
      provider: 'test',
      model: 'summary',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', start: source, end: source },
      sourceEventSeqs: [source, summary.seq],
    })

    const [hit] = ctx.compactionHistory.search(session.id, 'model reasoning')
    expect(hit!.snippet).toBe('{"type":"reasoning","text":"model reasoning"}')
    expect(ctx.compactionHistory.expand(session.id, hit!.id, { includeSources: true }).sources).toEqual([])
  })

  it('reconstructs the same DAG when history loads after the session exists', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const first = appendText(session, 'persisted fact')
    appendSummary(session, [first], 'persisted summary')

    await ctx.plugin(CompactionHistory)

    expect(ctx.compactionHistory.search(session.id, 'persisted summary')).toMatchObject([
      { kind: 'leaf', depth: 0 },
    ])
  })

  it('publishes a summary node only after its replacement checkpoint commits', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.create()
    const source = appendText(session, 'source for an interrupted compaction')
    const compactionId = CompactionId('interrupted')
    session.append('compaction/start', { compactionId, turn: null })
    session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'summary that never committed' }],
      shadowedRange: { start: source, end: source },
      shadowedSeqs: [source],
      shadowedTokenCount: 8,
      provider: 'test',
      model: 'summary',
    })
    session.append('compaction/end', { compactionId, turn: null, error: 'interrupted' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'orphan checkpoint' }],
      source: compactCheckpointSource(CompactionId('orphan')),
    }), { surfaceOp: 'append' })

    expect(ctx.compactionHistory.search(session.id, 'never committed')).toEqual([])
    expect(ctx.compactionHistory.stats(session.id)).toEqual({ summaries: 0, maxDepth: 0 })
  })

  it('keeps indexes session-local and drops disposed sessions', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const first = ctx.sessions.create()
    const second = ctx.sessions.create()
    appendSummary(first, [appendText(first, 'first session')], 'shared summary')
    appendSummary(second, [appendText(second, 'second session')], 'shared summary')

    expect(ctx.compactionHistory.search(first.id, 'shared')).toHaveLength(1)
    expect(ctx.compactionHistory.search(second.id, 'shared')).toHaveLength(1)
    ctx.emit('session/disposed', first)
    expect(() => ctx!.compactionHistory.stats(first.id)).toThrow(/is not live/)
    expect(ctx.compactionHistory.stats(second.id)).toEqual({ summaries: 1, maxDepth: 0 })
  })

  it.each([
    [{ maxSearchResults: 0 }, 'maxSearchResults'],
    [{ maxSearchResults: 1.5 }, 'maxSearchResults'],
    [{ maxExpansionDepth: 0 }, 'maxExpansionDepth'],
    [{ maxExpansionDepth: 1.5 }, 'maxExpansionDepth'],
    [{ maxExpansionTokens: 0 }, 'maxExpansionTokens'],
    [{ maxExpansionTokens: 1.5 }, 'maxExpansionTokens'],
  ] as const)('rejects invalid history config %o', async (config, field) => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(CompactionHistory, config)).rejects.toThrow(field)
  })

  it('applies programmatic defaults when Loader schema resolution is bypassed', async () => {
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(TokenMeter)

    await applyLossless(ctx, {})

    expect(ctx.compactionHistory.config).toEqual({
      maxSearchResults: 20,
      maxExpansionDepth: 3,
      maxExpansionTokens: 4_000,
    })
  })
})
