import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {
  ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import { registerTrajectoryAssistantDefinition } from '../src/client/trajectory-assistant-definition.ts'
import { registerTrajectoryCompactionDefinitions } from '../src/client/trajectory-compaction-definition.ts'
import type { TrajectorySnapshot } from '../src/client/trajectory-contract.ts'
import { registerTrajectoryMessageDefinitions } from '../src/client/trajectory-message-definitions.ts'
import { registerTrajectoryRequestHeaderDefinition } from '../src/client/trajectory-request-header-definition.ts'
import { trajectoryViewDefinition } from '../src/client/trajectory-snapshot-builder.ts'
import { registerTrajectoryToolDefinition } from '../src/client/trajectory-tool-definition.ts'

const DEFINITIONS: ConversationNodeDefinition[] = []
const registrationContext = {
  conversationEvents: {
    register: (definition: ConversationNodeDefinition) => {
      DEFINITIONS.push(definition)
      return () => {}
    },
  },
} as unknown as Context

registerTrajectoryMessageDefinitions(registrationContext)
registerTrajectoryRequestHeaderDefinition(registrationContext)
registerTrajectoryAssistantDefinition(registrationContext)
registerTrajectoryToolDefinition(registrationContext)
registerTrajectoryCompactionDefinitions(registrationContext)

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
    return [trajectoryViewDefinition]
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
      time: 1_700_000_000_000 + seq,
      type,
      data,
      ...extra,
    } as unknown as ConversationEventInput['event'],
    view: undefined,
  }
}

function assembler(events: readonly ConversationEventInput[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(
    new TestEventDefinitions(),
    new TestViewDefinitions(),
  )
  value.replaceWindow(events, hasMore)
  value.flush()
  return value
}

function snapshot(value: ConversationNodeAssembler): TrajectorySnapshot {
  const current = value.snapshot('trajectory') as TrajectorySnapshot | undefined
  if (current === undefined) throw new Error('trajectory view was not registered')
  return current
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'test', model: 'test' },
  }
}

/** A fan-out wide enough that a per-event sibling scan or copy costs seconds; the linear fold takes a fraction of a second. */
const WIDE_FAN_OUT = 20_000
/** Wall-clock ceiling for folding and publishing the wide fan-out. */
const WIDE_FAN_OUT_BUDGET_MS = 5_000

const dispatch = (
  seq: number,
  type: string,
  parentCallId: string,
  subCallId: string,
  text?: string,
): ConversationEventInput => at(seq, type, {
  rootCallId: 'root', parentCallId, subCallId, name: 'read', arguments: { path: subCallId },
  ...text === undefined ? {} : { content: [{ type: 'text', text }] },
})

const toolResult = (callId: string, text: string) => ({
  id: `result-${callId}`, role: 'user', source: { kind: 'tool', callId },
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
})

/** One root Code call followed by `width` settled sub-calls and the root result. */
function wideFanOut(width: number): ConversationEventInput[] {
  const events: ConversationEventInput[] = [
    at(1, 'turn/start', { turn: 1 }),
    at(2, 'step/start', { turn: 1, step: 1 }),
    at(3, 'tool/call', { turn: 1, step: 1, callId: 'root', name: 'code', arguments: '{}' }),
  ]
  for (let index = 0; index < width; index++) {
    events.push(dispatch(4 + index * 2, 'tool/code-dispatch-start', 'root', `call-${index}`))
    events.push(dispatch(5 + index * 2, 'tool/code-dispatch', 'root', `call-${index}`, 'done'))
  }
  events.push(at(4 + width * 2, 'tool/result', {
    turn: 1, step: 1, message: toolResult('root', 'root done'),
  }, { surfaceOp: 'append' }))
  events.push(at(5 + width * 2, 'step/end', { turn: 1, step: 1 }))
  return events
}

describe('Trajectory conversation Definitions', () => {
  it('replays finalized Assistant history from the final message while preserving timing and streamed usage', () => {
    const current = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
      }),
      at(4, 'assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'first token' },
      }),
      at(5, 'assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ' redundant tail' },
      }),
      at(6, 'assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      }),
      at(7, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-finalized-history', 'finalized body'),
      }, { surfaceOp: 'append' }),
      at(8, 'step/end', { turn: 1, step: 1 }),
    ]))

    expect(current.eventNodes).toMatchObject([{
      kind: 'assistant',
      seq: 7,
      blocks: [{ kind: 'text', text: 'finalized body' }],
      timing: {
        stepStartTime: 1_700_000_000_002,
        firstTokenTime: 1_700_000_000_004,
        completedTime: 1_700_000_000_007,
      },
    }])
    expect(current.requests).toMatchObject([{
      purpose: 'assistant',
      status: 'complete',
      usage: { inputTokens: 10, outputTokens: 3 },
    }])

    const boundary = snapshot(assembler([
      at(20, 'assistant/chunk', {
        turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
      }),
      at(21, 'assistant/chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'first token' },
      }),
      at(22, 'assistant/chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: ' redundant tail' },
      }),
      at(23, 'assistant/message', {
        turn: 2,
        step: 1,
        message: assistantMessage('assistant-boundary-history', 'boundary body'),
        usage: { inputTokens: 12, outputTokens: 4 },
      }, { surfaceOp: 'append' }),
    ]))
    expect(boundary.eventNodes).toMatchObject([{
      kind: 'assistant',
      blocks: [{ kind: 'text', text: 'boundary body' }],
      usage: { inputTokens: 12, outputTokens: 4 },
      timing: {
        stepStartTime: null,
        firstTokenTime: 1_700_000_000_021,
        completedTime: 1_700_000_000_023,
      },
    }])
  })

  it('assembles streaming usage, preserves retry facts, and materializes interruption', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'first attempt' },
      }),
      at(4, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      }),
    ])

    expect(snapshot(value).partial?.blocks).toEqual([{ kind: 'text', text: 'first attempt' }])
    expect(snapshot(value).requests).toMatchObject([{
      purpose: 'assistant',
      status: 'running',
      usage: { inputTokens: 10, outputTokens: 3 },
    }])

    value.append(at(5, 'llm/retry', {
      retryId: 'retry-1',
      turn: 1,
      step: 1,
      provider: 'test',
      mode: 'normal',
      policyKey: 'test-normal',
      retry: 1,
      maxRetries: 2,
      delayMs: 25,
      failure: { code: 'TRANSPORT', message: 'temporary failure' },
    }))
    value.append(at(6, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'second attempt' },
    }))
    value.append(at(7, 'step/end', { turn: 1, step: 1 }))
    value.flush()

    const settled = snapshot(value)
    expect(settled.partial).toBeNull()
    expect(settled.eventNodes).toMatchObject([{
      kind: 'assistant',
      seq: 6.1,
      interrupted: true,
      blocks: [{ kind: 'text', text: 'second attempt' }],
    }])
    expect(settled.requests).toMatchObject([{
      purpose: 'assistant',
      status: 'error',
      retry: 1,
      maxRetries: 2,
      retryDelayMs: 25,
      usage: { inputTokens: 10, outputTokens: 3 },
    }])
  })

  it('keeps parallel interrupted roots and nests Code Dispatch results', () => {
    const current = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', {
        turn: 1, step: 1, callId: 'root-a', name: 'code', arguments: '{}',
      }),
      at(4, 'tool/call', {
        turn: 1, step: 1, callId: 'root-b', name: 'parallel', arguments: '{}',
      }),
      at(5, 'tool/code-dispatch-start', {
        rootCallId: 'root-a',
        parentCallId: 'root-a',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
      }),
      at(6, 'tool/code-dispatch', {
        rootCallId: 'root-a',
        parentCallId: 'root-a',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
        content: [{ type: 'text', text: 'contents' }],
      }),
      at(7, 'step/end', { turn: 1, step: 1 }),
    ]))

    const tools = current.eventNodes.filter(node => node.kind === 'tool-result')
    expect(tools.map(node => node.callId).sort()).toEqual(['root-a', 'root-b'])
    expect(tools.find(node => node.callId === 'root-a')?.subCalls).toMatchObject([{
      kind: 'tool-result',
      callId: 'child',
      call: { name: 'read' },
    }])
  })

  it('keeps first-attachment order, rejects repeated starts, cycles, and reparenting, and adopts detached subtrees', () => {
    const current = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'root', name: 'code', arguments: '{}' }),
      dispatch(4, 'tool/code-dispatch-start', 'root', 'a'),
      dispatch(5, 'tool/code-dispatch-start', 'root', 'b'),
      dispatch(6, 'tool/code-dispatch-start', 'root', 'a'),
      dispatch(7, 'tool/code-dispatch', 'root', 'b', 'b settled'),
      dispatch(8, 'tool/code-dispatch', 'root', 'a', 'a first'),
      dispatch(9, 'tool/code-dispatch', 'root', 'a', 'a second'),
      dispatch(10, 'tool/code-dispatch-start', 'a', 'c'),
      dispatch(11, 'tool/code-dispatch-start', 'c', 'a'),
      dispatch(12, 'tool/code-dispatch-start', 'b', 'c'),
      dispatch(13, 'tool/code-dispatch', 'c', 'c', 'self'),
      dispatch(14, 'tool/code-dispatch', 'detached', 'd', 'adopted'),
      dispatch(15, 'tool/code-dispatch-start', 'root', 'a'),
      dispatch(16, 'tool/code-dispatch-start', 'c', 'root'),
      dispatch(17, 'tool/code-dispatch-start', 'b', 'detached'),
      at(18, 'step/end', { turn: 1, step: 1 }),
    ]))

    const roots = current.eventNodes.filter(node => node.kind === 'tool-result')
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({
      callId: 'root',
      error: { name: 'Interrupted', code: 'interrupted' },
      subCalls: [
        {
          kind: 'tool-result', callId: 'a', content: [{ type: 'text', text: 'a second' }],
          subCalls: [{
            kind: 'tool-result', callId: 'c', seq: 17.2, callTime: 1_700_000_000_010,
            error: { name: 'Interrupted', code: 'interrupted' }, subCalls: [],
          }],
        },
        {
          kind: 'tool-result', callId: 'b', content: [{ type: 'text', text: 'b settled' }],
          subCalls: [{
            kind: 'tool-result', callId: 'detached',
            error: { name: 'Interrupted', code: 'interrupted' },
            subCalls: [{ kind: 'tool-result', callId: 'd', content: [{ type: 'text', text: 'adopted' }] }],
          }],
        },
      ],
    })
  })

  it('rebuilds a root whose call precedes the window from its result and dispatches', () => {
    const current = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      dispatch(3, 'tool/code-dispatch-start', 'root', 'a'),
      dispatch(4, 'tool/code-dispatch', 'root', 'a', 'done'),
      at(5, 'tool/result', {
        turn: 1, step: 1, message: toolResult('root', 'root done'),
      }, { surfaceOp: 'append' }),
      at(6, 'step/end', { turn: 1, step: 1 }),
    ], true))

    expect(current.eventNodes.filter(node => node.kind === 'tool-result')).toMatchObject([{
      seq: 5, callId: 'root', call: null, content: [{ type: 'text', text: 'root done' }],
      subCalls: [{ kind: 'tool-result', callId: 'a', callTime: 1_700_000_000_003, content: [{ type: 'text', text: 'done' }] }],
    }])
  })

  it('folds and publishes a wide Code Dispatch fan-out inside its budget', () => {
    const started = performance.now()
    const current = snapshot(assembler(wideFanOut(WIDE_FAN_OUT)))
    const elapsedMs = performance.now() - started

    const roots = current.eventNodes.filter(node => node.kind === 'tool-result')
    expect(roots).toHaveLength(1)
    const subCalls = roots[0]?.subCalls ?? []
    expect(subCalls).toHaveLength(WIDE_FAN_OUT)
    expect(subCalls.slice(0, 3).map(subCall => subCall.callId)).toEqual(['call-0', 'call-1', 'call-2'])
    expect(subCalls.at(-1)?.callId).toBe(`call-${WIDE_FAN_OUT - 1}`)
    expect(elapsedMs, `folded ${WIDE_FAN_OUT} dispatches in ${Math.round(elapsedMs)} ms`).toBeLessThan(WIDE_FAN_OUT_BUDGET_MS)
  }, 60_000)

  it('assembles compaction lifecycle, checkpoint replacement, and orphan interruption', () => {
    const current = snapshot(assembler([
      at(1, 'compaction/start', { compactionId: 'complete', turn: null }),
      at(2, 'compaction/summary', {
        compactionId: 'complete',
        turn: null,
        summary: 'summary',
        provider: 'test',
        model: 'test',
        maxTokens: 100,
        usage: { inputTokens: 20, outputTokens: 5 },
      }),
      at(3, 'user/message', {
        id: 'checkpoint',
        role: 'user',
        content: [{ type: 'text', text: 'summary checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'complete' },
      }),
      at(4, 'compaction/end', { compactionId: 'complete', turn: null }),
      at(5, 'compaction/start', { compactionId: 'orphan', turn: null }),
      at(6, 'session/end-seed', {}),
    ]))

    expect(current.requests).toMatchObject([
      {
        purpose: 'compaction',
        startSeq: 1,
        status: 'complete',
        resultSeq: 2,
        replacementSeq: 3,
        summary: 'summary',
      },
      {
        purpose: 'compaction',
        startSeq: 5,
        status: 'error',
        completedAt: 1_700_000_000_006,
      },
    ])
    // The landed compaction rides its marker on eventNodes at the checkpoint's own seq; the
    // interrupted one never landed a checkpoint and contributes no marker.
    expect(current.eventNodes.filter(node => node.kind === 'compaction')).toEqual([{
      kind: 'compaction',
      seq: 3,
      time: 1_700_000_000_003,
      summary: null,
      summaryEventSeq: 2,
      shadowedItemCount: null,
      shadowedTokenCount: null,
    }])
  })

  it('classifies claimed inbox input as steering and consumes one inherited prompt change', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'request/header', {
        reason: 'initial',
        header: {
          config: { provider: 'test', model: 'test' },
          system: 'system prompt',
          tools: [],
        },
      }),
      at(3, 'step/start', { turn: 1, step: 1 }),
      at(4, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-1', 'first'),
      }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'm1' }],
      }),
      at(7, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(8, 'step/start', { turn: 1, step: 2 }),
    ])
    value.append(at(9, 'user/message', {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'steer here' }],
      source: { kind: 'user' },
    }))
    value.flush()

    const steering = snapshot(value)
    expect(steering.eventNodes.find(node => node.seq === 9)?.kind).toBe('steering')
    expect(steering.eventLocations.get(9)).toMatchObject({
      kind: 'step',
      turn: { turn: 1 },
      step: { step: 2 },
    })

    value.append(at(10, 'assistant/message', {
      turn: 1,
      step: 2,
      message: assistantMessage('assistant-2', 'second'),
    }))
    value.flush()
    const current = snapshot(value)

    expect(current.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['system prompt', 'system prompt'])
    expect(current.requests.map(request => request.purpose === 'assistant'
      ? request.promptChange?.kind
      : undefined)).toEqual(['initial', undefined])
  })
})
