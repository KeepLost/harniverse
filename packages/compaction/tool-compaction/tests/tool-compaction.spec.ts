import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CompactionEngine,
  CompactionId,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolCompaction from '@deepseek-ai/dsh-tool-compaction'

const RESULT: CompactionResult = {
  compactionId: CompactionId('tool-compaction-test'),
  startSeq: 1,
  summarySeq: 2,
  endSeq: 3,
  summary: [{ type: 'text', text: 'private summary body' }],
  shadowedRange: { start: 3, end: 9 },
  shadowedSeqs: [3, 5, 7, 9],
  shadowedTokenCount: 321,
}

class RecordingCompactionEngine extends CompactionEngine {
  readonly compactIfNeeded = vi.fn((
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> => Promise.resolve(RESULT))

  protected override performCompactNow(
    _agent: ManualCompactAgentContext,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    throw new Error('unexpected compactNow call')
  }

  readonly compactRegionMock = vi.fn(
    (_start: number, _end: number, _agent: CompactionAgentContext, _signal?: AbortSignal): Promise<CompactionResult> =>
      Promise.resolve(RESULT),
  )

  override compactRegion(start: number, end: number, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult> {
    return this.compactRegionMock(start, end, agent, signal)
  }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function setup(): Promise<{ ctx: Context; compact: RecordingCompactionEngine; agent: Agent }> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(RecordingCompactionEngine)
  const compact = ctx.compaction as RecordingCompactionEngine
  await ctx.plugin(toolCompaction)
  const session = Session.create(SessionId('tool-compaction'))
  const agent = { session, options: {} } as Agent
  return { ctx, compact, agent }
}

describe('context_compact', () => {
  it('is independently discoverable and exclusive', async () => {
    const test = await setup()

    expect(test.ctx.tools.schemas({ session: test.agent.session })).toContainEqual({
      name: 'context_compact',
      description: 'Compact older conversation history while retaining recent context. Use after detailed prior context is no longer needed.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Briefly explain why older context can be condensed now.',
          },
          from: {
            type: 'number',
            description: 'First message to compact, as a 1-based position from the oldest retained message. Omit both positions to let policy choose the span.',
          },
          to: {
            type: 'number',
            description: 'Last message to compact, inclusive, in the same positioning. The span must end before the current turn; boundaries snap to keep tool calls paired.',
          },
        },
        required: ['reason'],
      },
    })
    expect(test.ctx.tools.executionMode({
      signal: new AbortController().signal,
      callId: CallId('mode'),
      name: 'context_compact',
      arguments: { reason: 'phase complete' },
      agent: test.agent,
    })).toEqual({ kind: 'exclusive' })
  })

  it('forwards the exact agent and signal through the agent-request trigger', async () => {
    const test = await setup()
    const signal = new AbortController().signal
    const result = await test.ctx.tools.execute({
      signal,
      callId: CallId('compact'),
      name: 'context_compact',
      arguments: { reason: 'dependency investigation is complete' },
      agent: test.agent,
    })

    expect(test.compact.compactIfNeeded).toHaveBeenCalledWith(test.agent, 'agent-request', signal)
    expect(result).toMatchObject({
      isError: false,
      value: 'Compacted 4 older history items (~321 tokens) while retaining recent context.',
      content: [{
        type: 'text',
        text: 'Compacted 4 older history items (~321 tokens) while retaining recent context.',
      }],
    })
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).not.toContain('private summary body')
  })

  it('reports a no-op without inventing a summary result', async () => {
    const test = await setup()
    test.compact.compactIfNeeded.mockResolvedValueOnce(null)

    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('noop'),
      name: 'context_compact',
      arguments: { reason: 'checkpoint before implementation' },
      agent: test.agent,
    })

    expect(result).toMatchObject({
      isError: false,
      value: 'No compactable older history is available yet.',
    })
  })

  it.each([
    ['missing reason', {}, 'agent', 'required property "reason"'],
    ['missing agent', { reason: 'phase complete' }, undefined, 'requires an active agent session'],
    ['empty reason', { reason: '   ' }, 'agent', 'reason must not be empty'],
    ['nested dispatch', { reason: 'phase complete' }, 'nested', 'cannot run inside another tool'],
  ] as const)('rejects %s before invoking the backend', async (_label, args, mode, message) => {
    const test = await setup()
    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`rejected-${_label}`),
      name: 'context_compact',
      arguments: args,
      ...mode === undefined ? {} : { agent: test.agent },
      ...mode === 'nested' ? { parent: Symbol('parent') as never } : {},
    })

    expect(result.isError).toBe(true)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain(message)
    expect(test.compact.compactIfNeeded).not.toHaveBeenCalled()
  })

  it('compacts a model-named span through the explicit compactRegion path', async () => {
    const test = await setup()
    // Five closed-turn nodes (seqs 3,5,7,9,11) plus an open turn's node.
    for (let turn = 1; turn <= 3; turn += 1) {
      test.agent.session.append('turn/start', { turn })
      test.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `closed user ${turn}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      test.agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    test.agent.session.append('turn/start', { turn: 4 })
    test.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open turn' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const before = test.agent.session.surface.nodes.length

    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('span'),
      name: 'context_compact',
      arguments: { reason: 'early scratch work', from: 2, to: 3 },
      agent: test.agent,
    })

    expect(result.isError).toBe(false)
    const nodes = test.agent.session.surface.nodes
    // Positions 2..3 of the closed history map to the middle closed nodes.
    expect(test.compact.compactRegionMock).toHaveBeenCalledWith(nodes[1], nodes[2], test.agent, expect.anything())
    expect(test.compact.compactIfNeeded).not.toHaveBeenCalled()
    expect(test.agent.session.surface.nodes.length).toBe(before)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('Compacted 4 history items')
    expect(text).toContain('retained context is ~')
    expect(text).toContain('tokens')
  })

  it('caps a span at the closed-turn boundary and reports the usable range', async () => {
    const test = await setup()
    test.agent.session.append('turn/start', { turn: 1 })
    test.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'closed user' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    test.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    test.agent.session.append('turn/start', { turn: 2 })
    test.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open turn' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('cap'),
      name: 'context_compact',
      arguments: { reason: 'too greedy', from: 1, to: 99 },
      agent: test.agent,
    })

    expect(result.isError).toBe(false)
    const nodes = test.agent.session.surface.nodes
    expect(test.compact.compactRegionMock).toHaveBeenCalledWith(nodes[0], nodes[0], test.agent, expect.anything())
  })

  it('rejects a span with no closed-turn history', async () => {
    const test = await setup()
    test.agent.session.append('turn/start', { turn: 1 })
    test.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'only an open turn' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('no-closed'),
      name: 'context_compact',
      arguments: { reason: 'too early', from: 1, to: 1 },
      agent: test.agent,
    })

    expect(result.isError).toBe(false)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('No closed-turn history')
    expect(test.compact.compactRegionMock).not.toHaveBeenCalled()
  })

  it('rejects from without to', async () => {
    const test = await setup()
    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('half-span'),
      name: 'context_compact',
      arguments: { reason: 'half a span', from: 2 },
      agent: test.agent,
    })
    expect(result.isError).toBe(true)
    expect(test.compact.compactRegionMock).not.toHaveBeenCalled()
  })

  it('rejects non-positive, reversed, and out-of-range positions', async () => {
    const test = await setup()
    test.agent.session.append('turn/start', { turn: 1 })
    test.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'closed' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    test.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    for (const [args, fragment] of [
      [{ reason: 'bad', from: 0, to: 1 }, 'positive whole positions'],
      [{ reason: 'bad', from: 2, to: 1 }, 'must not exceed'],
      [{ reason: 'bad', from: 5, to: 9 }, 'stay within the 1 closed-turn'],
    ] as const) {
      const result = await test.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`bad-${fragment}`),
        name: 'context_compact',
        arguments: args,
        agent: test.agent,
      })
      expect(result.isError).toBe(false)
      const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
      expect(text).toContain(fragment)
    }
    expect(test.compact.compactRegionMock).not.toHaveBeenCalled()
  })

  it('advances the span start past a result whose call stays kept', async () => {
    const test = await setup()
    const session = test.agent.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('head-call'), name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('head-call'),
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'after' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Position 2 is the call's result; shadowing it alone orphans the call.
    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('head-snap'),
      name: 'context_compact',
      arguments: { reason: 'skip the pair', from: 2, to: 3 },
      agent: test.agent,
    })

    expect(result.isError).toBe(false)
    const nodes = session.surface.nodes
    expect(test.compact.compactRegionMock).toHaveBeenCalledWith(nodes[2], nodes[2], test.agent, expect.anything())
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('snapped position(s)')
  })

  it('collapses a span that is only an unanswered call', async () => {
    const test = await setup()
    const session = test.agent.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('lone-call'), name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('lone-call'),
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('collapse'),
      name: 'context_compact',
      arguments: { reason: 'just the call', from: 1, to: 1 },
      agent: test.agent,
    })

    expect(result.isError).toBe(false)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('collapses after keeping tool calls paired')
    expect(test.compact.compactRegionMock).not.toHaveBeenCalled()
  })

  it('snaps a span that would split a tool call from its result', async () => {
    const test = await setup()
    const session = test.agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'run the tool' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('call-1'), name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text: 'tool output' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'follow-up' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })

    // Positions 1..2 would shadow the call (position 2) while keeping its
    // result; the tail cut cannot orphan it.
    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('snap'),
      name: 'context_compact',
      arguments: { reason: 'scratch', from: 1, to: 2 },
      agent: test.agent,
    })

    expect(result.isError).toBe(false)
    const nodes = session.surface.nodes
    // The tail cut must stay pairing-balanced: the span shrinks to position 1.
    expect(test.compact.compactRegionMock).toHaveBeenCalledWith(nodes[0], nodes[0], test.agent, expect.anything())
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('snapped')
  })
})
