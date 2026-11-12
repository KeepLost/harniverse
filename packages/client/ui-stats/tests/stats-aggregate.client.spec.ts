/**
 * Pure aggregation and builder tests: node sets become ordered rows and
 * window totals; the keyed builder merges upserts and rebuilds rows.
 */
import { describe, expect, it } from 'vitest'
import { aggregateStats } from '../src/client/stats-aggregate.ts'
import { StatsSnapshotBuilder } from '../src/client/stats-snapshot-builder.ts'
import type {
  StatsCompactionFacts, StatsConversationViewNode, StatsStepMetrics, StatsTrigger,
} from '../src/client/stats-contract.ts'
import { EMPTY_STATS_SNAPSHOT } from '../src/client/stats-contract.ts'

let seq = 0

function stepNode(turn: number, step: number, over: Partial<StatsStepMetrics> = {}, key?: string): StatsConversationViewNode {
  seq += 1
  return {
    key: key ?? `k${seq}`, kind: 'stats-step', id: `${turn}:${step}`, target: 'stats', anchorSeq: seq,
    data: {
      turn, step, anchorSeq: seq, startTime: 1_000, endTime: 2_000, closed: true,
      firstTokenTime: 1_100, messageTime: 1_500, interrupted: false,
      usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 100 },
      retries: 0, calls: [], toolMs: 0, toolWall: null, toolOpen: 0, answer: null,
      ...over,
    },
  }
}

function promptNode(turn: number | null, trigger: StatsTrigger): StatsConversationViewNode {
  seq += 1
  return {
    key: `k${seq}`, kind: 'stats-prompt', id: `p${seq}`, target: 'stats', anchorSeq: seq,
    data: { turn, trigger },
  }
}

function turnEndNode(turn: number, closeKind: string): StatsConversationViewNode {
  seq += 1
  return {
    key: `k${seq}`, kind: 'stats-turn-end', id: `t${turn}`, target: 'stats', anchorSeq: seq,
    data: { turn, time: 9_000, closeKind },
  }
}

function compactionNode(facts: Partial<StatsCompactionFacts> & { anchorSeq?: number }): StatsConversationViewNode {
  seq += 1
  return {
    key: `k${seq}`, kind: 'stats-compaction', id: `c${seq}`, target: 'stats', anchorSeq: seq,
    data: {
      anchorSeq: seq, turn: null, startedAt: 1_000, endedAt: 1_200,
      provider: null, model: null, usage: null, shadowedTokenCount: null, error: null,
      ...facts,
    },
  }
}

const USER: StatsTrigger = {
  sourceKind: 'user', plugin: null, form: null, summary: null, preview: 'hi', files: 0, images: 0,
}

describe('aggregateStats', () => {
  it('groups steps and prompts into ordered turn rows with totals', () => {
    const result = aggregateStats([
      promptNode(1, USER),
      stepNode(1, 1),
      stepNode(1, 2, { usage: { inputTokens: 100, outputTokens: 10 } }),
      turnEndNode(1, 'completed'),
      promptNode(2, USER),
      stepNode(2, 1, { retries: 2, toolMs: 5, calls: [{ callId: 'x', name: 't', startedAt: 1, endedAt: 6, ms: 5, error: true, chars: 0 }] }),
    ])
    expect(result.rows.map(row => row.kind === 'turn' ? `turn${row.turn}` : 'compaction'))
      .toEqual(['turn1', 'turn2'])
    expect(result.totals).toEqual({
      turns: 2, steps: 3, inputTokens: 700, llmMs: 1_500, toolMs: 5,
      ttftMs: 300, ttftSteps: 3, decodeMs: 1_200, decodeTokens: 110,
      outputTokens: 110, cacheReadTokens: 200, cacheWriteTokens: 0, retries: 2, toolErrors: 1,
    })
    const first = result.rows[0]
    if (first?.kind !== 'turn') throw new Error('expected turn row')
    expect(first.trigger?.preview).toBe('hi')
    expect(first.ended).toBe(true)
    expect(first.closeKind).toBe('completed')
  })

  it('attaches a location-unresolved prompt to the next step turn', () => {
    const result = aggregateStats([
      promptNode(null, USER),
      stepNode(1, 1),
    ])
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.trigger).toBe(USER)
  })

  it('drops a prompt that no turn ever adopts', () => {
    const result = aggregateStats([promptNode(null, USER), turnEndNode(1, 'completed')])
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.trigger).toBeNull()
  })

  it('renders standalone compactions as between-turn rows and numbered ones inside their turn', () => {
    const result = aggregateStats([
      stepNode(1, 1),
      compactionNode({ turn: null, provider: 'deepseek', shadowedTokenCount: 4_000 }),
      stepNode(2, 1),
      compactionNode({ turn: 2 }),
    ])
    expect(result.rows.map(row => row.kind)).toEqual(['turn', 'compaction', 'turn'])
    const middle = result.rows[1]
    if (middle?.kind !== 'compaction') throw new Error('expected compaction row')
    expect(middle.facts.provider).toBe('deepseek')
    const last = result.rows[2]
    if (last?.kind !== 'turn') throw new Error('expected turn row')
    expect(last.compactions).toHaveLength(1)
  })

  it('keeps only the first prompt of a turn as its trigger', () => {
    const second: StatsTrigger = { ...USER, preview: 'second' }
    const result = aggregateStats([promptNode(1, USER), promptNode(1, second), stepNode(1, 1)])
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.trigger).toBe(USER)
  })

  it('creates an empty turn row for a turn that only ended', () => {
    const result = aggregateStats([turnEndNode(3, 'blocked')])
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.steps).toEqual([])
    expect(row.closeKind).toBe('blocked')
    expect(result.totals.turns).toBe(1)
  })

  it('drops a prompt whose resolved turn never materialized', () => {
    const result = aggregateStats([promptNode(7, USER), stepNode(1, 1)])
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.turn).toBe(1)
    expect(row.trigger).toBeNull()
  })

  it('returns the empty snapshot for no nodes', () => {
    expect(aggregateStats([])).toEqual(EMPTY_STATS_SNAPSHOT)
  })
})

describe('StatsSnapshotBuilder', () => {
  it('replaces and applies node sets into rebuilt rows', () => {
    const builder = new StatsSnapshotBuilder()
    expect(builder.empty).toBe(EMPTY_STATS_SNAPSHOT)
    const base = stepNode(1, 1, {}, 'stable')
    const first = builder.replace({ nodes: [promptNode(1, USER), base] })
    expect(first.rows).toHaveLength(1)
    const second = builder.apply({ upserts: [{ ...base, data: { ...(base.data as StatsStepMetrics), retries: 1 } }] })
    expect(second.rows).toHaveLength(1)
    const row = second.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.steps).toHaveLength(1)
    expect(row.steps[0]?.retries).toBe(1)
    expect(second.totals.retries).toBe(1)
  })
})
