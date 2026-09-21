/** Actual compaction and pruning consumers of durable request projection. */
import { afterEach, describe, expect, it } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
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
  it.each([undefined, SessionId('not-loaded')])('preserves requests without a loaded session (%s)', async (sessionId) => {
    const { ctx, session } = await setup()
    const options: GenerateOptions = { provider: 'mock', model: 'mock', messages: [
      createUserMessage({ source: { kind: 'user' }, content: [image('standalone')] }),
    ], ...(sessionId === undefined ? {} : { sessionId }) }
    expect(ctx.waterfall(ctx.llm, 'llm/project-request', options, () => options)).toBe(options)
    expect(session.events).toEqual([])
  })

  it('ignores empty assistant nodes and maps non-leading image ordinals without counting text', async () => {
    const { ctx, session } = await setup()
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [] }),
    }, { surfaceOp: 'append' })
    const source = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: 'before' }, image('same'), { type: 'text', text: 'between' }, image('same'),
    ] }), { surfaceOp: 'append' })
    const options: GenerateOptions = { provider: 'mock', model: 'mock', sessionId: session.id, messages: session.deriveMessages() }
    const request = ctx.waterfall(ctx.llm, 'llm/project-request', options, () => options)
    expect(request.messages).toHaveLength(1)
    expect(request.onImagesOmitted?.([{ message: 0, image: 1 }, { message: 0, image: 1 }])[0]?.content).toEqual([
      { type: 'text', text: 'before' }, image('same'), { type: 'text', text: 'between' },
      { type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT },
    ])
    expect(session.events.filter(event => event.type === 'image/offload').map(event => event.data.targets)).toEqual([
      [{ messageSeq: source.seq, imageIndex: 1 }],
    ])
    expect(source.data.content.at(-1)).toEqual(image('same'))
  })

  it('rejects an invalid omission batch atomically', async () => {
    const { ctx, session } = await setup()
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [image('durable')] }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: 'answer' }] }),
    }, { surfaceOp: 'append' })
    const options: GenerateOptions = { provider: 'mock', model: 'mock', sessionId: session.id, messages: [
      ...session.deriveMessages(), createUserMessage({ source: { kind: 'plugin', plugin: 'request-only' }, content: [image('transient')] }),
    ] }
    const request = ctx.waterfall(ctx.llm, 'llm/project-request', options, () => options)
    const before = session.events
    for (const message of [2, 3]) {
      expect(() => request.onImagesOmitted?.([{ message: 0, image: 0 }, { message, image: 0 }]))
        .toThrow('image pressure target is not a durable session occurrence')
    }
    for (const target of [{ message: 0, image: 1 }, { message: 1, image: 0 }]) {
      expect(() => request.onImagesOmitted?.([{ message: 0, image: 0 }, target]))
        .toThrow('image pressure target is not a visible image')
    }
    expect(session.events).toBe(before)
    expect(session.deriveMessages()).toEqual(options.messages.slice(0, 2))
  })

  it('rejects pressure for a source replaced after request assembly and preserves its attempt snapshot', async () => {
    const { ctx, session } = await setup()
    const source = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [image('compacted')] }), { surfaceOp: 'append' })
    const options: GenerateOptions = { provider: 'mock', model: 'mock', sessionId: session.id, messages: session.deriveMessages() }
    const request = ctx.waterfall(ctx.llm, 'llm/project-request', options, () => options)
    const summary = session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text: 'summary' }] }), {
      surfaceOp: { op: 'replace', start: source.seq, end: source.seq }, sourceEventSeqs: [source.seq],
    })
    expect(() => request.onImagesOmitted?.([{ message: 0, image: 0 }]))
      .toThrow('image pressure source was replaced during the request')
    const refreshed = request.onImagesOmitted?.([])
    expect(refreshed).toEqual(options.messages)
    expect(Object.isFrozen(refreshed)).toBe(true)
    expect(session.deriveMessages()).toEqual([summary.data])
    expect(session.events.filter(event => event.type === 'image/offload')).toEqual([])
  })

  it('refuses pressure settlement when an evicted historical source can no longer be read', async () => {
    const { ctx, session: source } = await setup()
    source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [image('historical')] }), { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    let available = true
    const id = SessionId('evicted-image-source')
    const restored = ctx.sessions.prepare(id, {
      seedSource: 'persistence',
      seed: structuredClone(source.events.slice(1)),
      meta: { ...source.header, id },
      history: { firstSeq: 1, eventAt: seq => available ? structuredClone(source.eventAt(seq)) : undefined },
      surface: { nodes: [0], replaceGeneration: 0 },
    })
    const detach = ctx.sessions.enter(restored)
    try {
      const options: GenerateOptions = { provider: 'mock', model: 'mock', sessionId: id, messages: restored.deriveMessages() }
      const request = ctx.waterfall(ctx.llm, 'llm/project-request', options, () => options)
      const historical = new WeakRef(restored.eventAt(0)!)
      const before = restored.eventsFrom(1)
      available = false
      // Historical payloads are weakly held; keep the in-flight message alive across real collection.
      setFlagsFromString('--expose-gc')
      const collect = runInNewContext('gc') as () => void
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await setImmediate()
        collect()
        if (historical.deref() === undefined) break
      }
      expect(historical.deref()).toBeUndefined()
      expect(() => request.onImagesOmitted?.([{ message: 0, image: 0 }]))
        .toThrow('image pressure target has no source event')
      expect(restored.eventsFrom(1)).toEqual(before)
      expect(request.messages[0]?.content).toEqual([image('historical')])
    } finally {
      detach()
    }
  })

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
