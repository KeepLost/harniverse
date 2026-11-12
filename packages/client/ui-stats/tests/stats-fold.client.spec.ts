/**
 * Definition-fold acceptance over the real ConversationNodeAssembler: fixture
 * event windows produce the published step/prompt/turn-end/compaction nodes
 * with the expected per-step facts.
 */
import { describe, expect, it } from 'vitest'
import type {
  ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type { StatsCompactionFacts, StatsStepMetrics } from '../src/client/stats-contract.ts'
import { registerStatsConversation } from '../src/client/stats-snapshot-builder.ts'
import type { StatsSnapshot } from '../src/client/stats-contract.ts'
import type { Context } from '@deepseek-ai/cordis'

const DEFINITIONS: ConversationNodeDefinition[] = []
const VIEWS: ConversationViewDefinition[] = []
const registrationContext = {
  conversationEvents: {
    register: (definition: ConversationNodeDefinition) => {
      DEFINITIONS.push(definition)
      return () => {}
    },
  },
  conversationViews: {
    register: (definition: ConversationViewDefinition) => {
      VIEWS.push(definition)
      return () => {}
    },
  },
} as unknown as Context

registerStatsConversation(registrationContext)

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return VIEWS
  }
}

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): ConversationEventInput {
  return {
    event: {
      seq,
      time: 1_700_000_000_000 + seq * 10,
      type,
      data,
      ...extra,
    } as unknown as ConversationEventInput['event'],
    view: undefined,
  }
}

function assembler(events: readonly ConversationEventInput[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(
    new TestEventDefinitions(),
    new TestViewDefinitions(),
  )
  value.replaceWindow(events, false)
  value.flush()
  return value
}

function snapshot(value: ConversationNodeAssembler): StatsSnapshot {
  const current = value.snapshot('stats') as StatsSnapshot | undefined
  if (current === undefined) throw new Error('stats view was not registered')
  return current
}

function stepOf(value: StatsSnapshot, turn: number, step: number): StatsStepMetrics {
  for (const row of value.rows) {
    if (row.kind !== 'turn') continue
    for (const candidate of row.steps) {
      if (candidate.turn === turn && candidate.step === step) return candidate
    }
  }
  throw new Error(`step ${turn}:${step} not found`)
}

/** One complete step: prompt, first token, tool pair, message with usage. */
function completeTurnEvents(): ConversationEventInput[] {
  return [
    at(1, 'turn/start', { turn: 1 }),
    at(2, 'step/start', { turn: 1, step: 1 }),
    at(3, 'user/message', {
      content: [{ type: 'text', text: '  list   the files ' }],
      source: { kind: 'user', files: [
        { attachmentId: 'a1', mediaType: 'image/png', bytes: 10 },
        { attachmentId: 'a2', mediaType: 'image/png', bytes: 10 },
        { attachmentId: 'a3', mediaType: 'text/plain', bytes: 10 },
      ] },
    }),
    at(4, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'He' } }),
    at(5, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'llo' } }),
    at(6, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'fs', arguments: '{}' }),
    at(7, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'm1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(30) }] }],
        source: { kind: 'tool', callId: 'c1' },
      },
    }),
    at(8, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 2_000, cacheWriteTokens: 100 },
    }),
    at(9, 'step/end', { turn: 1, step: 1 }),
    at(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

describe('stats definitions over the real assembler', () => {
  it('folds one complete step into its metrics', () => {
    const result = snapshot(assembler(completeTurnEvents()))
    const step = stepOf(result, 1, 1)
    expect(step.closed).toBe(true)
    expect(step.firstTokenTime).toBe(1_700_000_000_040)
    expect(step.messageTime).toBe(1_700_000_000_080)
    expect(step.usage).toEqual({
      inputTokens: 900, outputTokens: 100, cacheReadTokens: 2_000, cacheWriteTokens: 100,
    })
    expect(step.calls).toHaveLength(1)
    expect(step.calls[0]).toMatchObject({ callId: 'c1', name: 'fs', error: false, chars: 30, ms: 10 })
    expect(step.toolMs).toBe(10)
    expect(step.toolWall).toBe(10)
    expect(step.toolOpen).toBe(0)
    expect(step.answer).toBe('Done.')
    expect(result.totals).toMatchObject({ turns: 1, steps: 1, llmMs: 60, toolMs: 10, ttftMs: 20, ttftSteps: 1 })
  })

  it('records the waking prompt with file and image counts', () => {
    const result = snapshot(assembler(completeTurnEvents()))
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.trigger).toMatchObject({
      sourceKind: 'user', plugin: null, form: null, files: 3, images: 2,
      preview: 'list the files',
    })
    expect(row.ended).toBe(true)
    expect(row.closeKind).toBe('completed')
  })

  it('ignores empty stream chunks for the first-token stamp', () => {
    const events = completeTurnEvents().slice(0, 3)
    events.push(at(20, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } }))
    events.push(at(21, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } } }))
    const step = stepOf(snapshot(assembler(events)), 1, 1)
    expect(step.firstTokenTime).toBeNull()
    events.push(at(22, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'He' } }))
    const stamped = stepOf(snapshot(assembler(events)), 1, 1)
    expect(stamped.firstTokenTime).toBe(1_700_000_000_220)
  })

  it('counts retries and keeps an unanswered step open', () => {
    const events = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'llm/retry', {
        retryId: 'r1', turn: 1, step: 1, provider: 'p', mode: 'normal',
        policyKey: 'k', retry: 1, maxRetries: 3, delayMs: 100,
        failure: { name: 'E', code: 'X', message: 'boom' },
      }),
    ]
    const step = stepOf(snapshot(assembler(events)), 1, 1)
    expect(step.retries).toBe(1)
    expect(step.closed).toBe(false)
    expect(step.messageTime).toBeNull()
  })

  it('marks an interrupted message and a missing tool result open', () => {
    const events = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'fs', arguments: '{}' }),
      at(4, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'par' } }),
      at(5, 'assistant/message', {
        turn: 1, step: 1, interrupted: true,
        message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'partial' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      }),
    ]
    const step = stepOf(snapshot(assembler(events)), 1, 1)
    expect(step.interrupted).toBe(true)
    expect(step.toolOpen).toBe(1)
    expect(step.toolWall).toBeNull()
  })

  it('unions overlapping tool spans for toolWall', () => {
    const events = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 't', arguments: '{}' }),
      at(4, 'tool/call', { turn: 1, step: 1, callId: 'b', name: 't', arguments: '{}' }),
      at(5, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'ma', role: 'user', content: [{ type: 'tool-result', toolCallId: 'a', content: [] }], source: { kind: 'tool', callId: 'a' } },
      }),
      at(6, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'mb', role: 'user', content: [{ type: 'tool-result', toolCallId: 'b', isError: true, content: [] }], source: { kind: 'tool', callId: 'b' } },
      }),
    ]
    const step = stepOf(snapshot(assembler(events)), 1, 1)
    expect(step.toolMs).toBe(40)
    expect(step.toolWall).toBe(30)
    expect(step.calls.filter(call => call.error)).toHaveLength(1)
  })

  it('ignores a tool result whose call is outside the window', () => {
    const events = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'mx', role: 'user', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [] }], source: { kind: 'tool', callId: 'ghost' } },
      }),
    ]
    const step = stepOf(snapshot(assembler(events)), 1, 1)
    expect(step.calls).toHaveLength(0)
  })

  it('folds plugin injections with their declared notice form', () => {
    const events = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', {
        content: [{ type: 'text', text: 'cron fired' }],
        source: { kind: 'plugin', plugin: 'scheduler', form: 'notice', summary: '计划任务触发' },
      }),
    ]
    const result = snapshot(assembler(events))
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.trigger).toMatchObject({
      sourceKind: 'plugin', plugin: 'scheduler', form: 'notice', summary: '计划任务触发',
    })
  })

  it('keeps a usage-less message and counts reasoning characters in results', () => {
    const events = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1, step: 1,
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'no usage' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      }),
    ]
    const bare = stepOf(snapshot(assembler(events)), 1, 1)
    expect(bare.usage).toBeNull()
    expect(bare.answer).toBe('no usage')

    const withReasoning = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 't', arguments: '{}' }),
      at(4, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'mr', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'reasoning', text: 'r'.repeat(7) }] }], source: { kind: 'tool', callId: 'c1' } },
      }),
    ])
    expect(stepOf(snapshot(withReasoning), 1, 1).calls[0]?.chars).toBe(7)
  })

  it('resolves a turn-level prompt for a step-less rejected turn', () => {
    const result = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'user/message', {
        content: [{ type: 'text', text: 'queued but rejected' }],
        source: { kind: 'user' },
      }),
      at(3, 'turn/end', { turn: 1, reason: { kind: 'blocked' } }),
    ]))
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.steps).toEqual([])
    expect(row.trigger?.preview).toBe('queued but rejected')
    expect(row.closeKind).toBe('blocked')
  })

  it('adds disjoint tool spans instead of unioning them', () => {
    const events = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 't', arguments: '{}' }),
      at(4, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }),
      at(5, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'ma', role: 'user', content: [{ type: 'tool-result', toolCallId: 'a', content: [] }], source: { kind: 'tool', callId: 'a' } },
      }),
      at(6, 'tool/call', { turn: 1, step: 1, callId: 'b', name: 't', arguments: '{}' }),
      at(7, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'y' } }),
      at(8, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'mb', role: 'user', content: [{ type: 'tool-result', toolCallId: 'b', content: [] }], source: { kind: 'tool', callId: 'b' } },
      }),
    ]
    const step = stepOf(snapshot(assembler(events)), 1, 1)
    expect(step.toolMs).toBe(40)
    expect(step.toolWall).toBe(40)
  })

  it('returns start-only Definition states unchanged from update', () => {
    const prompt = DEFINITIONS.find(definition => definition.kind === 'stats-prompt')
    const turnEnd = DEFINITIONS.find(definition => definition.kind === 'stats-turn-end')
    const state = { seq: 1 }
    expect(prompt?.update({ state } as never, {} as never)).toBe(state)
    expect(turnEnd?.update({ state } as never, {} as never)).toBe(state)
  })

  it('covers foreign source shapes, image blocks, reasoning-only messages, and cache-less usage', () => {
    const result = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', {
        content: [
          { type: 'image', mediaType: 'image/png', data: 'x' },
          { type: 'text', text: 'with image' },
        ],
        source: null,
      }),
      at(4, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 't', arguments: '{}' }),
      at(5, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'mi', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', mediaType: 'image/png', data: 'y' }] }], source: { kind: 'tool', callId: 'c1' } },
      }),
      at(6, 'assistant/message', {
        turn: 1, step: 1,
        message: { id: 'mr', role: 'assistant', content: [{ type: 'reasoning', text: 'thinking only' }], source: { kind: 'model', provider: 'p', model: 'm' } },
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
    ]))
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.trigger).toMatchObject({ sourceKind: 'unknown', files: 0, preview: 'with image' })
    const step = row.steps[0]
    if (step === undefined) throw new Error('expected step')
    expect(step.calls[0]?.chars).toBe(0)
    expect(step.answer).toBeNull()
    expect(step.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
  })

  it('breaks tool-sort ties by callId', () => {
    const result = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'zz', name: 't', arguments: '{}' }, { time: 5_000 }),
      at(4, 'tool/call', { turn: 1, step: 1, callId: 'aa', name: 't', arguments: '{}' }, { time: 5_000 }),
      at(5, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'mz', role: 'user', content: [{ type: 'tool-result', toolCallId: 'zz', content: [] }], source: { kind: 'tool', callId: 'zz' } },
      }),
      at(6, 'tool/result', {
        turn: 1, step: 1,
        message: { id: 'ma', role: 'user', content: [{ type: 'tool-result', toolCallId: 'aa', content: [] }], source: { kind: 'tool', callId: 'aa' } },
      }),
    ]))
    const row = result.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.steps[0]?.calls.map(call => call.callId)).toEqual(['aa', 'zz'])
  })

  it('returns compaction state unchanged for an update-routed start event', () => {
    const compaction = DEFINITIONS.find(definition => definition.kind === 'stats-compaction')
    const state = { compactionId: 'k', seq: 1, turn: null, startedAt: 1, endedAt: null, provider: null, model: null, usage: null, shadowedTokenCount: null, error: null }
    const startEvent = at(9, 'compaction/start', { compactionId: 'k', turn: null }).event
    expect(compaction?.update({ state } as never, { event: startEvent, view: undefined, role: 'update', location: { kind: 'unresolved' } } as never)).toBe(state)
  })

  it('folds standalone and numbered compactions', () => {
    const standalone = findCompaction(snapshot(assembler([
      at(1, 'compaction/start', { compactionId: 'k1', turn: null }),
      at(2, 'compaction/summary', {
        compactionId: 'k1', turn: null,
        summary: [], shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 5_000,
        provider: 'deepseek', model: 'V4', usage: { inputTokens: 4_000, outputTokens: 500, cacheReadTokens: 300, cacheWriteTokens: 20 },
      }),
      at(3, 'compaction/end', { compactionId: 'k1', turn: null }),
    ])))
    expect(standalone).toMatchObject({
      turn: null, provider: 'deepseek', model: 'V4', shadowedTokenCount: 5_000, endedAt: 1_700_000_000_030, error: null,
    })

    const usageless = findCompaction(snapshot(assembler([
      at(1, 'compaction/start', { compactionId: 'k3', turn: null }),
      at(2, 'compaction/summary', {
        compactionId: 'k3', turn: null,
        summary: [], shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 10,
        provider: 'deepseek', model: 'V4',
      }),
      at(3, 'compaction/end', { compactionId: 'k3', turn: null }),
    ])))
    expect(usageless.usage).toBeNull()

    const numbered = snapshot(assembler([
      at(1, 'turn/start', { turn: 2 }),
      at(2, 'step/start', { turn: 2, step: 1 }),
      at(3, 'compaction/start', { compactionId: 'k2', turn: 2 }),
      at(4, 'compaction/summary', {
        compactionId: 'k2', turn: 2,
        summary: [], shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 100,
        provider: 'deepseek', model: 'V4', usage: { inputTokens: 90, outputTokens: 9 },
      }),
      at(5, 'compaction/end', { compactionId: 'k2', turn: 2, error: 'budget exceeded' }),
    ]))
    const row = numbered.rows[0]
    if (row?.kind !== 'turn') throw new Error('expected turn row')
    expect(row.compactions).toHaveLength(1)
    expect(row.compactions[0]).toMatchObject({ turn: 2, error: 'budget exceeded', provider: 'deepseek', usage: { inputTokens: 90, outputTokens: 9 } })
  })
})

function findCompaction(value: StatsSnapshot): StatsCompactionFacts {
  for (const row of value.rows) {
    if (row.kind === 'compaction') return row.facts
  }
  throw new Error('no standalone compaction row')
}
