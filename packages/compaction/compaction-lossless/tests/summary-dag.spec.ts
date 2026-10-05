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
import type { CompactionHistorySearchHit, CompactionSummaryHit } from '@deepseek-ai/dsh-compaction-lossless'

/** Narrow one search hit to its summary variant or fail the test loudly. */
function summaryHit(hit: CompactionHistorySearchHit | undefined): CompactionSummaryHit {
  if (hit === undefined || hit.kind !== 'summary') throw new Error('expected a summary hit')
  return hit
}

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
  it('forwards explicitly configured history limits while assembling providers', async () => {
    const calls: unknown[][] = []
    const fakeContext = {
      plugin: async (...args: unknown[]) => { calls.push(args) },
    } as unknown as Context

    await applyLossless(fakeContext, {
      maxSearchResults: 10,
      maxExpansionDepth: 4,
      maxExpansionTokens: 2_000,
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1]).toEqual({
      maxSearchResults: 10,
      maxExpansionDepth: 4,
      maxExpansionTokens: 2_000,
    })
    expect(calls[1]?.[1]).toEqual({})
  })

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
    const leafExpansion = ctx.compactionHistory.expand(session.id, summaryHit(leafHit).id, {
      maxDepth: 4,
      includeSources: true,
      tokenCap: 2_000,
    })
    expect(leafExpansion.sources).toEqual([
      { eventSeq: first, role: 'user', text: 'alpha requirement with exact value 41' },
      { eventSeq: second, role: 'user', text: 'beta decision' },
    ])

    const [hit] = ctx.compactionHistory.search(session.id, 'condensed gamma')
    expect(hit).toMatchObject({ kind: 'summary', nodeKind: 'condensed', depth: 1 })
    expect(ctx.compactionHistory.search(session.id, 'alpha', { limit: 0 })).toHaveLength(1)
    const expanded = ctx.compactionHistory.expand(session.id, summaryHit(hit).id, {
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
    expect(ctx.compactionHistory.expand(session.id, summaryHit(hit).id, { maxDepth: 1 })).toMatchObject({
      parents: [],
      sources: [],
      truncated: true,
    })
    expect(ctx.compactionHistory.expand(session.id, summaryHit(hit).id, { maxDepth: 2, tokenCap: 1 })).toMatchObject({
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

    const expanded = ctx.compactionHistory.expand(session.id, summaryHit(hit).id, {
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
    const sourceBounded = ctx.compactionHistory.expand(session.id, summaryHit(tinyHit).id, {
      includeSources: true,
      tokenCap: 2,
    })
    expect(sourceBounded.sources).toEqual([
      { eventSeq: longSource, role: 'user', text: 'sour' },
    ])
    expect(sourceBounded.truncated).toBe(true)

    const longSummary = `searchable ${'x'.repeat(300)}`
    appendSummary(session, [appendText(session, 'snippet source')], longSummary)
    const longSummaryHit = summaryHit(ctx.compactionHistory.search(session.id, 'searchable')[0])
    expect(longSummaryHit.snippet).toHaveLength(243)
    expect(longSummaryHit.snippet).toMatch(/\.\.\.$/)
  })

  it('lists committed rounds as structural descriptors with ancestry', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.create()

    expect(ctx.compactionHistory.list(session.id)).toEqual([])
    const first = appendText(session, 'alpha requirement')
    const second = appendText(session, 'beta decision')
    const leafCheckpoint = appendSummary(session, [first, second], 'alpha and beta summary')
    const third = appendText(session, 'gamma follow-up')
    appendSummary(session, [leafCheckpoint, third], 'condensed alpha beta gamma')

    const nodes = ctx.compactionHistory.list(session.id)
    expect(nodes.map(node => node.kind)).toEqual(['leaf', 'condensed'])
    expect(nodes[0]).toMatchObject({
      kind: 'leaf',
      depth: 0,
      shadowedRange: { start: first, end: second },
      parentCount: 0,
      sourceCount: 2,
      lineage: [],
      provider: 'test',
      model: 'summary',
    })
    expect(nodes[0]!.eventSeq).toBeLessThan(nodes[1]!.eventSeq)
    expect(nodes[1]).toMatchObject({
      kind: 'condensed',
      depth: 1,
      shadowedRange: { start: leafCheckpoint, end: third },
      parentCount: 1,
      sourceCount: 1,
      lineage: [{ id: nodes[0]!.id, kind: 'leaf', depth: 0 }],
    })
    expect(nodes[1]!.summaryTokenCount).toBeGreaterThan(0)
    expect(typeof nodes[1]!.createdAt).toBe('number')
  })

  it('searches cited source messages with their covering coordinates', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.create()

    const first = appendText(session, 'alpha requirement with exact value 41')
    const second = appendText(session, 'beta decision')
    appendSummary(session, [first, second], 'alpha and beta summary')
    const third = appendText(session, 'gamma follow-up holds exact value 41')
    appendSummary(session, [third], 'gamma summary')

    const sourceOnly = ctx.compactionHistory.search(session.id, 'exact value', { scope: 'sources' })
    expect(sourceOnly).toHaveLength(2)
    expect(sourceOnly.every(hit => hit.kind === 'source')).toBe(true)
    const [newest, older] = sourceOnly as Extract<typeof sourceOnly[number], { kind: 'source' }>[]
    expect(newest).toMatchObject({
      kind: 'source',
      eventSeq: third,
      role: 'user',
      snippet: 'gamma follow-up holds exact value 41',
      node: { kind: 'leaf', depth: 0, shadowedRange: { start: third, end: third } },
    })
    expect(older!.eventSeq).toBe(first)

    expect(ctx.compactionHistory.search(session.id, 'alpha', { scope: 'sources' })).toHaveLength(1)
    // Depth restriction applies to the covering node's layer.
    expect(ctx.compactionHistory.search(session.id, 'alpha', { scope: 'sources', depth: 1 })).toHaveLength(0)
    expect(ctx.compactionHistory.search(session.id, 'gamma', { scope: 'summaries' })).toHaveLength(1)
    const both = ctx.compactionHistory.search(session.id, 'gamma', { scope: 'both' })
    expect(both.map(hit => hit.kind).toSorted()).toEqual(['source', 'summary'])
    // The shared cap bounds both corpora together.
    expect(ctx.compactionHistory.search(session.id, 'exact value', { scope: 'both', limit: 1 })).toHaveLength(1)
  })

  it('locates one event as live, pending, or shadowed with its relation', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.create()

    const first = appendText(session, 'alpha requirement')
    const second = appendText(session, 'beta decision')
    const leafCheckpoint = appendSummary(session, [first, second], 'alpha and beta summary')
    const third = appendText(session, 'gamma follow-up')
    appendSummary(session, [leafCheckpoint, third], 'condensed alpha beta gamma')
    const live = appendText(session, 'still visible message')

    const asSource = ctx.compactionHistory.locate(session.id, first)
    expect(asSource).toMatchObject({ status: 'shadowed', relation: 'source' })
    const asCheckpoint = ctx.compactionHistory.locate(session.id, leafCheckpoint)
    if (asCheckpoint.status !== 'shadowed') throw new Error('expected the checkpoint to be shadowed')
    expect(asCheckpoint.relation).toBe('checkpoint')
    expect(asCheckpoint.node.kind).toBe('condensed')
    expect(ctx.compactionHistory.locate(session.id, live)).toEqual({ status: 'live' })
    expect(() => ctx!.compactionHistory.locate(session.id, live + 1)).toThrow(/outside the session log/)
    expect(() => ctx!.compactionHistory.locate(session.id, -1)).toThrow(/outside the session log/)

    const pendingCompaction = CompactionId('pending-round')
    session.append('compaction/start', { compactionId: pendingCompaction, turn: null })
    const pendingSource = appendText(session, 'pending source message')
    session.append('compaction/summary', {
      compactionId: pendingCompaction,
      summary: [{ type: 'text', text: 'pending summary' }],
      shadowedRange: { start: pendingSource, end: pendingSource },
      shadowedSeqs: [pendingSource],
      shadowedTokenCount: 4,
      provider: 'test',
      model: 'summary',
    })
    expect(ctx.compactionHistory.locate(session.id, pendingSource)).toEqual({ status: 'pending' })
  })

  it('marks non-message events inside a replaced span as other', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.create()

    const first = appendText(session, 'alpha requirement')
    const marker = session.append('compaction/start', { compactionId: CompactionId('other-relation'), turn: null })
    const second = appendText(session, 'beta decision')
    const compactionId = CompactionId('other-round')
    session.append('compaction/start', { compactionId, turn: null })
    const summary = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'span summary' }],
      shadowedRange: { start: first, end: second },
      shadowedSeqs: [first, second],
      shadowedTokenCount: 8,
      provider: 'test',
      model: 'summary',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'span summary' }],
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', start: first, end: second },
      sourceEventSeqs: [marker.seq, summary.seq, first, second],
    })

    expect(ctx.compactionHistory.locate(session.id, marker.seq)).toMatchObject({
      status: 'shadowed',
      relation: 'other',
    })
  })

  it('breaks parent ties deterministically and ignores unknown parent ids', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CompactionHistory)
    const session = ctx.sessions.create()

    const first = appendText(session, 'alpha')
    const checkpointA = appendSummary(session, [first], 'leaf a summary')
    const second = appendText(session, 'beta')
    const checkpointB = appendSummary(session, [second], 'leaf b summary')
    appendSummary(session, [checkpointA, checkpointB], 'merged round')

    const merged = ctx.compactionHistory.list(session.id).at(-1)!
    expect(merged.kind).toBe('condensed')
    expect(merged.parentCount).toBe(2)
    // Both parents sit at depth 0; the first stays the chain because the
    // second is not deeper.
    expect(merged.lineage).toEqual([{ id: `compaction-summary:${session.id}:2`, kind: 'leaf', depth: 0 }])
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

    const reasoningHit = summaryHit(ctx.compactionHistory.search(session.id, 'model reasoning')[0])
    expect(reasoningHit.snippet).toBe('{"type":"reasoning","text":"model reasoning"}')
    expect(ctx.compactionHistory.expand(session.id, reasoningHit.id, { includeSources: true }).sources).toEqual([])
  })

  it('reconstructs the same DAG when history loads after the session exists', async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const first = appendText(session, 'persisted fact')
    appendSummary(session, [first], 'persisted summary')

    await ctx.plugin(CompactionHistory)

    expect(ctx.compactionHistory.search(session.id, 'persisted summary')).toMatchObject([
      { kind: 'summary', nodeKind: 'leaf', depth: 0 },
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
