/** Actual compaction and pruning consumers of durable request projection. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { CallId, createMessage, createToolResultMessage, createUserMessage, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { OFFLOADED_IMAGE_STUB_TEXT, resolveImageOffloadDecisions } from '@deepseek-ai/dsh-image-offload-policy'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as imageOffload from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

function image(id: string): ContentBlock {
  return { type: 'image', attachment: { attachmentId: AttachmentId(id), mediaType: 'image/png', bytes: 4, width: 1, height: 1 } }
}

async function setup(setting: number | 'unlimited' = 'unlimited') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenMeter)
  ctx.provide('settings', { get: () => ({ imageOffloadAfterUserTurns: setting }) })
  await ctx.plugin(imageOffload)
  const session = ctx.sessions.create(SessionId('runtime-paths'))
  return { ctx, session }
}

describe('image offload across compaction consumers', () => {
  it('settles mixed-age expiry before pressure selects the remaining occurrences', async () => {
    const { ctx, session } = await setup(2)
    const sources = ['aged', 'young', 'newest'].map(id => session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [image(id)],
    }), { surfaceOp: 'append' }))
    const adapter = new MockAdapter([(options) => {
      expect(options.messages.map(message => message.content[0]?.type)).toEqual(['text', 'image', 'image'])
      expect(options.onImagesOmitted?.([{ message: 1, image: 0 }]).map(message => message.content[0]?.type)).toEqual(['text', 'text', 'image'])
      return textResponse('ok')
    }])
    ctx.llm.registerAdapter(['mock'], adapter)
    for await (const _chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', sessionId: session.id, messages: session.deriveMessages() })) { /* drain */ }
    expect(session.events.filter(event => event.type === 'image/offload').map(event => event.data.targets)).toEqual([
      [{ messageSeq: sources[0]!.seq, imageIndex: 0 }], [{ messageSeq: sources[1]!.seq, imageIndex: 0 }],
    ])
    expect(resolveImageOffloadDecisions(session.events, { setting: 2 })).toEqual([])
  })

  it('does not shift or resettle an occurrence selected by overlapping requests', async () => {
    const { ctx, session } = await setup()
    const source = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [image('same'), image('same')] }), { surfaceOp: 'append' })
    const options: GenerateOptions = { provider: 'mock', model: 'mock', sessionId: session.id, messages: session.deriveMessages() }
    const first = ctx.waterfall(ctx.llm, 'llm/project-request', options, () => options)
    const second = ctx.waterfall(ctx.llm, 'llm/project-request', options, () => options)
    first.onImagesOmitted?.([{ message: 0, image: 0 }])
    const refreshed = second.onImagesOmitted?.([{ message: 0, image: 0 }])
    expect(refreshed?.[0]?.content.map(block => block.type)).toEqual(['text', 'image'])
    expect(session.events.filter(event => event.type === 'image/offload').map(event => event.data.targets)).toEqual([
      [{ messageSeq: source.seq, imageIndex: 0 }],
    ])
  })

  it.each(['age', 'pressure'] as const)('summarizes %s-offloaded images as stubs through the real compaction engine', async (reason) => {
    const { ctx, session } = await setup(reason === 'age' ? 1 : 'unlimited')
    await ctx.plugin(BasicCompactionEngine, { auto: false })
    const adapter = new MockAdapter([textResponse('short summary')])
    adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: 20_000 } })
    ctx.llm.registerAdapter(['mock'], adapter)
    session.append('turn/start', { turn: 1 })
    const source = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: 'context '.repeat(2000) }, image('summarized'),
    ] }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('assistant/message', {
      turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 1 },
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: 'ack' }] }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'follow-up' }] }), { surfaceOp: 'append' })
    if (reason === 'pressure') session.append('image/offload', { targets: [{ messageSeq: source.seq, imageIndex: 0 }] })
    expect(ctx.tokenMeter.measure(session).baseline.kind).toBe('usage')
    const agent = { session, options: { provider: 'mock', model: 'mock' } } as Agent
    await ctx.compaction.compactRegion(source.seq, source.seq, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.purpose).toBe('compaction')
    expect(adapter.requests[0]?.messages[0]?.content.at(-1)).toEqual({ type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT })
    expect(session.projectedMessageAt(source.seq)).toBeUndefined()
    expect(session.events.filter(event => event.type === 'image/offload')).toHaveLength(1)
    expect(resolveImageOffloadDecisions(session.events, { setting: 1, pressureCount: 100 })).toEqual([])
    expect(source.data.content.at(-1)?.type).toBe('image')
  })

  it('keeps pressure stubs whole when pruning and preserves surviving image ages', async () => {
    const { ctx, session } = await setup()
    const pruner = await ctx.plugin(ToolResultPruner, { thresholdChars: 180, headChars: 4, tailChars: 3 })
    const original = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: CallId('read'), isError: false, content: [
        { type: 'text', text: 'x'.repeat(1000) }, image('old'), image('remaining'),
      ] }),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'later' }] }), { surfaceOp: 'append' })
    session.append('image/offload', { targets: [{ messageSeq: original.seq, imageIndex: 0 }] })
    const result = ctx.toolResultPruner.pruneSession(session)
    expect(result.pruned).toHaveLength(1)
    const seq = result.pruned[0]!.replacementSeq
    const projected = session.projectedMessageAt(seq)?.content[0]
    expect(projected?.type).toBe('tool-result')
    if (projected?.type !== 'tool-result') throw new Error('missing pruned result')
    expect(projected.content).toContainEqual({ type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT })
    expect(projected.content.filter(block => block.type === 'image')).toEqual([image('remaining')])
    expect(resolveImageOffloadDecisions(session.events, { setting: 1 })).toEqual([
      { target: { messageSeq: seq, imageIndex: 0 }, reason: 'age' },
    ])
    expect(original.data.message.content[0].content.filter(block => block.type === 'image')).toHaveLength(2)
    expect(ctx.toolResultPruner.pruneSession(session).pruned).toEqual([])
    await pruner.dispose()
    await ctx.plugin(ToolResultPruner, { thresholdChars: 80, headChars: 4, tailChars: 3 })
    expect(ctx.toolResultPruner.pruneSession(session).pruned).toEqual([])
    expect(session.projectedMessageAt(seq)?.content[0]).toEqual(projected)
  })

  it('maps repeated provider selections back to original image ordinals in one message', async () => {
    const { ctx, session } = await setup()
    const event = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [image('same'), image('same'), image('same')] }), { surfaceOp: 'append' })
    const adapter = new MockAdapter([(options) => {
      expect(options.onImagesOmitted?.([{ message: 0, image: 0 }])[0]?.content.map(block => block.type)).toEqual(['text', 'image', 'image'])
      expect(options.onImagesOmitted?.([{ message: 0, image: 0 }])[0]?.content.map(block => block.type)).toEqual(['text', 'text', 'image'])
      return textResponse('ok')
    }])
    ctx.llm.registerAdapter(['mock'], adapter)
    for await (const _chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: session.deriveMessages(), sessionId: session.id })) { /* consume */ }
    expect(session.events.filter(item => item.type === 'image/offload').flatMap(item => item.data.targets)).toEqual([
      { messageSeq: event.seq, imageIndex: 0 }, { messageSeq: event.seq, imageIndex: 1 },
    ])
  })
})
