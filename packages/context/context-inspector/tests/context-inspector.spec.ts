// The manifest must equal what a real assembled request carries: the test
// rides the same `agent/request` waterfall that builds the outgoing request,
// captures the proposed request, and diffs the inspector's same-instant
// projection against it.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ContextInspector from '@deepseek-ai/dsh-context-inspector'
import type { ContextManifest } from '@deepseek-ai/dsh-context-inspector'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter, persona = 'You are precise.'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ContextInspector)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'context_compact',
    description: 'Compact older conversation history.',
    parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
  }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('context-inspector', () => {
  it('projects a manifest identical to the real assembled request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('inspect'), { provider: 'mock', model: 'mock' })

    let manifest: ContextManifest | undefined
    ctx.on('agent/request', async ({ agent: subject, signal }, next) => {
      const proposed = await next()
      if (subject !== agent) return proposed
      // Built between the surface append and the request assembly of the same
      // step, so the fold sees exactly what the outgoing request will carry.
      manifest = await ctx.contextInspector.manifest(agent, signal)
      return proposed
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect me' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]
    if (request === undefined) throw new Error('no request was captured')
    const requestMessages = request.messages.map(message => ({
      role: message.role,
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    }))
    const conversation = manifest?.segments.filter(segment => segment.plane === 'conversation') ?? []
    expect(conversation.map(segment => ({ role: segment.kind, text: segment.text }))).toEqual(requestMessages)
    const system = manifest?.segments.find(segment => segment.plane === 'system')
    const expectedSystem = request.system === undefined ? undefined
      : request.system.slice(0, Math.min(159, request.system.length))
        + (request.system.length > 159 ? '…' : '')
    expect(system?.text).toBe(expectedSystem)
    expect(manifest?.totalTokens).toBeGreaterThan(0)
    expect(manifest?.tools).toContain('context_compact')
    expect(manifest?.segments.every(segment => segment.tokens >= 0)).toBe(true)
  })

  it('carries per-segment provenance linking checkpoints to shadowed seqs', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('provenance'), { provider: 'mock', model: 'mock' })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old work' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpointed' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: agent.session.surface.nodes[0]!, end: agent.session.surface.nodes[0]! },
      sourceEventSeqs: [agent.session.surface.nodes[0]!],
    })

    const manifest = await ctx.contextInspector.manifest(agent)
    const conversation = manifest.segments.filter(segment => segment.plane === 'conversation')
    const checkpoint = conversation.find(segment => segment.shadowedSeqs !== undefined)
    expect(checkpoint).toBeDefined()
    expect(checkpoint?.shadowedSeqs).toHaveLength(1)
    expect(conversation.every(segment => typeof segment.seq === 'number')).toBe(true)
  })

  it('is a read-only projection: manifest calls do not append session events', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter, '')
    const agent = ctx.agentLoop.create(SessionId('readonly'), { provider: 'mock', model: 'mock' })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'stable' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      usage: { input: 1, output: 1 },
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    const before = agent.session.events.length

    const manifest = await ctx.contextInspector.manifest(agent)
    await ctx.contextInspector.manifest(agent)

    expect(agent.session.events.length).toBe(before)
    // A usage-only assistant node derives no message and yields no segment.
    const texts = manifest.segments.filter(s => s.plane === 'conversation').map(s => s.text)
    expect(texts).toContain('stable')
  })
})
