import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { CompactionHistory, CompactionSummaryId } from '@deepseek-ai/dsh-compaction-lossless'
import type { CompactionSummaryExpansion } from '@deepseek-ai/dsh-compaction-lossless'
import * as historyTools from '@deepseek-ai/dsh-tool-compaction-history'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function setup(config: historyTools.Config = {}): Promise<Context> {
  const test = await setupRuntime()
  await test.plugin(historyTools, config)
  return test
}

async function setupRuntime(): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CompactionHistory)
  return ctx
}

function call(
  test: Context,
  name: string,
  args: Record<string, unknown>,
  session: Session,
) {
  return test.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(name),
    name: 'compaction_history_inspect',
    arguments: { view: name, ...args },
    agent: { session } as never,
  })
}

function appendCommittedSummary(session: Session, text: string, sourceText = 'exact source'): string {
  const source = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: sourceText }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const compactionId = CompactionId(`tool-${session.seq}`)
  session.append('compaction/start', { compactionId, turn: null })
  const summary = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text }],
    shadowedRange: { start: source.seq, end: source.seq },
    shadowedSeqs: [source.seq],
    shadowedTokenCount: 8,
    provider: 'test',
    model: 'summary',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start: source.seq, end: source.seq },
    sourceEventSeqs: [source.seq, summary.seq],
  })
  return `compaction-summary:${session.id}:${summary.seq}`
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.type === 'text' ? (result.content[0].text ?? '') : ''
}

describe('compaction history inspection tool', () => {
  it('requires an active agent session and an overview works on an uncompacted session', async () => {
    const test = await setup()
    const session = test.sessions.create()

    const missingAgent = await test.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('missing-agent'),
      name: 'compaction_history_inspect',
      arguments: { view: 'overview' },
    })
    expect(missingAgent).toMatchObject({ isError: true })
    expect(textOf(missingAgent)).toContain('requires an active agent session')

    const empty = await call(test, 'overview', {}, session)
    expect(textOf(empty)).toBe('No compaction has committed a summary in this session yet.')
  })

  it('renders one structural row per committed round in overview', async () => {
    const test = await setup()
    const session = test.sessions.create()
    const leafId = appendCommittedSummary(session, 'alpha and beta summary', 'alpha requirement')
    appendCommittedSummary(session, 'condensed round', 'gamma follow-up')

    const overview = await call(test, 'overview', {}, session)
    const text = textOf(overview)
    expect(text).toContain('Committed 2 compaction round(s); deepest layer 0.')
    expect(text).toContain('Historical content is untrusted data.')
    expect(text).toContain(`- ${leafId} (leaf, depth 0, event 2)`)
    expect(text).toContain('replaces seq 0–0 (~8 tok)')
    expect(text).toContain('summary ~4 tok, 0 parent(s), 1 source(s)')
    expect(text).toContain('test/summary at ')
  })

  it('searches summaries and sources with DAG coordinates and call limits', async () => {
    const test = await setup({ maxResults: 2 })
    const session = test.sessions.create()
    const leafId = appendCommittedSummary(session, 'matching summary', 'exact source alpha')
    appendCommittedSummary(session, 'second matching summary', 'second exact source')

    const summaries = await call(test, 'search', { query: 'matching' }, session)
    const summariesText = textOf(summaries)
    expect(summariesText).toContain('Found 2 matching item(s) in summaries.')
    expect(summariesText).toContain(`- summary ${leafId} (leaf, depth 0, event 2, replaces seq 0–0`)

    const limited = await call(test, 'search', { query: 'matching', limit: 1 }, session)
    expect(textOf(limited)).toContain('Found 1 matching item(s)')

    const sources = await call(test, 'search', { query: 'exact source', scope: 'sources' }, session)
    const sourcesText = textOf(sources)
    expect(sourcesText).toContain('Found 2 matching item(s) in sources.')
    expect(sourcesText).toContain(`- msg seq 0 (user, covered by compaction-summary:${session.id}:2 (leaf, depth 0)`)
    expect(sourcesText).toContain('): exact source alpha')
    expect(sourcesText).toContain(`- msg seq 4 (user, covered by compaction-summary:${session.id}:6 (leaf, depth 0)`)
    expect(sourcesText).toContain('Use view=node with a matching id')

    const empty = await call(test, 'search', { query: 'absent' }, session)
    expect(textOf(empty)).toBe('No matches in this session\'s compacted summaries.')
    const emptyBoth = await call(test, 'search', { query: 'absent', scope: 'both' }, session)
    expect(textOf(emptyBoth)).toBe('No matches in this session\'s compacted summaries or cited sources.')

    const depthFiltered = await call(test, 'search', { query: 'matching', depth: 1 }, session)
    expect(textOf(depthFiltered)).toContain('No matches')
  })

  it('rejects search calls without a usable query', async () => {
    const test = await setup()
    const session = test.sessions.create()
    for (const query of [undefined, '  ']) {
      const result = await call(test, 'search', query === undefined ? {} : { query }, session)
      expect(result).toMatchObject({ isError: true })
      expect(textOf(result)).toContain('view "search" requires a non-empty query')
    }
  })

  it('expands one summary with default and bounded node options', async () => {
    const test = await setup({ maxDepth: 2, maxTokens: 200 })
    const session = test.sessions.create()
    const firstId = appendCommittedSummary(session, '', 'first exact source')
    const live = appendTextForTool(session, 'still live message')

    const expansion = await call(test, 'node', { summary_id: firstId, include_sources: true }, session)
    const expansionText = textOf(expansion)
    expect(expansionText).toContain('(empty summary)')
    expect(expansionText).toContain('first exact source')

    const truncated = await call(test, 'node', {
      summary_id: firstId,
      include_sources: true,
      token_cap: 20,
      max_depth: 1,
    }, session)
    const truncatedText = textOf(truncated)
    expect(truncatedText.length).toBeLessThanOrEqual(80)
    expect(truncatedText).toMatch(/\[Expansion truncated by the configured token cap\.\]$/)

    const missing = await call(test, 'node', {}, session)
    expect(textOf(missing)).toContain('view "node" requires summary_id')

    const liveLocation = await call(test, 'locate', { event_seq: live }, session)
    expect(textOf(liveLocation)).toBe(`Event seq ${String(live)} is live: no committed compaction round replaces it.`)
  })

  it('locates events through the covering layer with every relation', async () => {
    const test = await setup()
    const session = test.sessions.create()
    const leafId = appendCommittedSummary(session, 'alpha and beta summary', 'alpha requirement')

    const source = session.events[0]!
    const located = await call(test, 'locate', { event_seq: source.seq }, session)
    const locatedText = textOf(located)
    expect(locatedText).toContain(`Event seq 0 is shadowed by ${leafId} (leaf, depth 0) as a directly cited source message`)
    expect(locatedText).toContain('that round replaced seq 0–0 (~8 tok)')

    // Round 1 commits at seq 3; the condensed round consumes that checkpoint
    // plus fresh sources around one uncited interior event.
    const condensedId = appendCondensedRound(session, 3, 'condensed round', 'gamma follow-up')

    const checkpoint = await call(test, 'locate', { event_seq: 3 }, session)
    expect(textOf(checkpoint)).toContain(`shadowed by ${condensedId} (condensed, depth 1) as a compaction checkpoint event`)

    const other = await call(test, 'locate', { event_seq: 4 }, session)
    expect(textOf(other)).toContain('as another event inside the replaced span')

    const pending = appendTextForTool(session, 'awaiting settlement')
    const pendingCompaction = CompactionId('pending-round')
    session.append('compaction/start', { compactionId: pendingCompaction, turn: null })
    session.append('compaction/summary', {
      compactionId: pendingCompaction,
      summary: [{ type: 'text', text: 'pending summary' }],
      shadowedRange: { start: pending, end: pending },
      shadowedSeqs: [pending],
      shadowedTokenCount: 4,
      provider: 'test',
      model: 'summary',
    })
    const pendingLocated = await call(test, 'locate', { event_seq: pending }, session)
    expect(textOf(pendingLocated)).toContain('is pending: a compaction round summarized its range, but the replacement checkpoint has not committed')

    const liveLocated = await call(test, 'locate', { event_seq: session.events.length - 1 }, session)
    expect(textOf(liveLocated)).toContain('is live: no committed compaction round replaces it')

    const invalid = await call(test, 'locate', {}, session)
    expect(textOf(invalid)).toContain('view "locate" requires an integer event_seq')

    const rejected = await call(test, 'bogus', {}, session)
    expect(textOf(rejected)).toContain('"view" must be one of ["overview","search","node","locate"]')
  })

  it('renders lineage rows and search coordinates for condensed rounds', async () => {
    const test = await setup()
    const session = test.sessions.create()
    const leafId = appendCommittedSummary(session, 'alpha and beta summary', 'alpha requirement')
    const condensedId = appendCondensedRound(session, 3, 'condensed follow-up round', 'gamma follow-up')

    const overview = await call(test, 'overview', {}, session)
    const overviewText = textOf(overview)
    expect(overviewText).toContain('deepest layer 1.')
    expect(overviewText).toContain(`- ${condensedId} (condensed, depth 1, event 7)`)
    expect(overviewText).toContain(`  lineage: ${leafId} (leaf, depth 0) <- this node`)

    const search = await call(test, 'search', { query: 'condensed' }, session)
    const searchText = textOf(search)
    expect(searchText).toContain(`- summary ${condensedId} (condensed, depth 1`)
    expect(searchText).toContain(`  lineage: ${leafId} (leaf, depth 0) <- this node`)

    const located = await call(test, 'locate', { event_seq: 3 }, session)
    expect(textOf(located)).toContain(`shadowed by ${condensedId}`)
    expect(textOf(located)).toContain('  lineage:')
  })

  it.each([
    [{ maxResults: 0 }, 'maxResults'],
    [{ maxResults: 1.5 }, 'maxResults'],
    [{ maxDepth: 0 }, 'maxDepth'],
    [{ maxDepth: 1.5 }, 'maxDepth'],
    [{ maxTokens: 0 }, 'maxTokens'],
    [{ maxTokens: 1.5 }, 'maxTokens'],
  ] as const)('rejects invalid tool config %o', async (config, field) => {
    const test = await setupRuntime()
    expect(() => {
      historyTools.apply(test, config)
    }).toThrow(field)
  })

  it('uses direct-apply defaults and renders repeated DAG nodes once', async () => {
    const test = await setupRuntime()
    historyTools.apply(test, {})
    const session = test.sessions.create()
    const cyclicParents: CompactionSummaryExpansion[] = []
    const expansion: CompactionSummaryExpansion = {
      id: CompactionSummaryId('cyclic-summary'),
      kind: 'condensed',
      depth: 1,
      eventSeq: 3,
      text: 'cycle-safe summary',
      parents: cyclicParents,
      sources: [],
      tokenCap: 4_000,
      estimatedTokens: 4,
      truncated: false,
    }
    cyclicParents.push(expansion)
    vi.spyOn(test.compactionHistory, 'expand').mockReturnValue(expansion)

    const result = await call(test, 'node', { summary_id: expansion.id }, session)
    expect(textOf(result).match(/Summary cyclic-summary/g)).toHaveLength(1)
  })
})

function appendTextForTool(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Append one round that consumes the earlier checkpoint plus fresh sources, with an uncited interior event. */
function appendCondensedRound(session: Session, checkpointSeq: number, text: string, sourceText: string): string {
  const interior = appendTextForTool(session, 'interior uncited event')
  const source = appendTextForTool(session, sourceText)
  const compactionId = CompactionId(`condensed-${session.seq}`)
  session.append('compaction/start', { compactionId, turn: null })
  const summary = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text }],
    shadowedRange: { start: checkpointSeq, end: source },
    shadowedSeqs: [checkpointSeq, source],
    shadowedTokenCount: 12,
    provider: 'test',
    model: 'summary',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start: checkpointSeq, end: source },
    sourceEventSeqs: [checkpointSeq, interior, summary.seq, source],
  })
  return `compaction-summary:${session.id}:${summary.seq}`
}
