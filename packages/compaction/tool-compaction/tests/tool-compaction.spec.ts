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
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
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

  override compactRegion(): Promise<CompactionResult> {
    throw new Error('unexpected compactRegion call')
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
})
