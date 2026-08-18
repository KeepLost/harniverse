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

describe('compaction history tools', () => {
  it('returns empty search guidance and rejects calls without an active agent', async () => {
    const test = await setup()
    const session = test.sessions.create()
    const empty = await test.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('empty-search'),
      name: 'compaction_history_search',
      arguments: { query: 'absent' },
      agent: { session } as never,
    })
    expect(empty).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'No matching compacted summaries were found in this session.' }],
    })

    const missingAgent = await test.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('missing-agent'),
      name: 'compaction_history_search',
      arguments: { query: 'anything' },
    })
    expect(missingAgent).toMatchObject({
      isError: true,
    })
    const missingAgentText = missingAgent.content[0]?.type === 'text' ? missingAgent.content[0].text : ''
    expect(missingAgentText).toContain('requires an active agent session')
  })

  it('applies call limits and expands default depth, token, and source options', async () => {
    const test = await setup({ maxResults: 2, maxDepth: 2, maxTokens: 200 })
    const session = test.sessions.create()
    const firstId = appendCommittedSummary(session, '', 'first exact source')
    appendCommittedSummary(session, 'second matching summary')
    appendCommittedSummary(session, 'third matching summary')

    const search = await test.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('limited-search'),
      name: 'compaction_history_search',
      arguments: { query: 'matching', limit: 1 },
      agent: { session } as never,
    })
    const searchText = search.content[0]?.type === 'text' ? search.content[0].text : ''
    expect(searchText).toContain('Found 1 compacted summary node(s).')

    const expansion = await test.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('default-expand'),
      name: 'compaction_history_expand',
      arguments: { summaryId: firstId, includeSources: true },
      agent: { session } as never,
    })
    expect(expansion).toMatchObject({ isError: false })
    const expansionText = expansion.content[0]?.type === 'text' ? expansion.content[0].text : ''
    expect(expansionText).toContain('(empty summary)')
    expect(expansionText).toContain('first exact source')

    const truncated = await test.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('truncated-expand'),
      name: 'compaction_history_expand',
      arguments: { summaryId: firstId, includeSources: true, tokenCap: 20, maxDepth: 1 },
      agent: { session } as never,
    })
    const truncatedText = truncated.content[0]?.type === 'text' ? truncated.content[0].text : ''
    expect(truncatedText.length).toBeLessThanOrEqual(80)
    expect(truncatedText).toMatch(/\[Expansion truncated by the configured token cap\.\]$/)
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

    const result = await test.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('cycle-expand'),
      name: 'compaction_history_expand',
      arguments: { summaryId: expansion.id },
      agent: { session } as never,
    })
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text.match(/Summary cyclic-summary/g)).toHaveLength(1)
  })
})
