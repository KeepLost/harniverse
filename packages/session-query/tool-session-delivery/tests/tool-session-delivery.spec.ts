import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSessionDelivery from '@deepseek-ai/dsh-session-delivery-local'
import * as tool from '../src/index.ts'

class GatedAdapter extends LlmAdapter {
  readonly started = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.started.resolve(undefined)
    await this.release.promise
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'target reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'target reply' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('session_send_message', () => {
  it('returns after live inbox acceptance without waiting for the target reply', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSessionDelivery)
    await ctx.plugin(tool)
    const adapter = new GatedAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const sender = (await ctx.agents.create({
      sessionId: SessionId('sender'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const target = (await ctx.agents.create({
      sessionId: SessionId('target'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent

    const result = await ctx.tools.execute({
      name: 'session_send_message',
      arguments: { session_id: target.id, message: 'do the next task' },
      callId: CallId('delivery-call'),
      signal: new AbortController().signal,
      agent: sender,
    })

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('This confirms delivery only'))).toBe(true)
    await adapter.started.promise
    expect(target.status).toBe('running')
    const runningUnload = await ctx.tools.execute({
      name: 'session_unload',
      arguments: { session_id: target.id },
      callId: CallId('running-unload-call'),
      signal: new AbortController().signal,
      agent: sender,
    })
    expect(runningUnload.isError).toBe(true)
    expect(ctx.agents.get(target.id)).toBe(target)
    adapter.release.resolve(undefined)
    await target.whenIdle()
    expect(target.session.deriveMessages().some(message =>
      message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === 'do the next task'))).toBe(true)
    const unload = await ctx.tools.execute({
      name: 'session_unload',
      arguments: { session_id: target.id },
      callId: CallId('idle-unload-call'),
      signal: new AbortController().signal,
      agent: sender,
    })
    expect(unload.isError, JSON.stringify(unload)).toBe(false)
    expect(unload.content.some(block => block.type === 'text' && block.text.includes('was unloaded'))).toBe(true)
    expect(ctx.agents.get(target.id)).toBeUndefined()
    expect(ctx.sessions.get(target.id)).toBeUndefined()
    const repeated = await ctx.tools.execute({
      name: 'session_unload',
      arguments: { session_id: target.id },
      callId: CallId('repeated-unload-call'),
      signal: new AbortController().signal,
      agent: sender,
    })
    expect(repeated.isError).toBe(false)
    expect(repeated.content.some(block => block.type === 'text' && block.text.includes('already unloaded'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('cold-resumes a persisted ordinary session and still returns only acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-delivery-'))
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root })
      await ctx.plugin(AgentDefaultModel, { provider: 'deployment-default', model: 'deployment-default' })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(LocalSessionDelivery)
      await ctx.plugin(tool)
      const adapter = new GatedAdapter()
      ctx.llm.registerAdapter(['mock'], adapter)
      const sender = await ctx.agents.create({
        sessionId: SessionId('cold-sender'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const seed: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'request/header',
          seq: 1,
          time: 2,
          data: { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' },
        },
        { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      const cold = ctx.sessions.prepare(SessionId('cold-target'), { seed })
      const detach = ctx.sessions.enter(cold)
      ctx.sessions.announce(cold)
      await ctx.sessions.flush(cold)
      detach()
      expect(ctx.agents.get(SessionId('cold-target'))).toBeUndefined()

      const result = await ctx.tools.execute({
        name: 'session_send_message',
        arguments: { session_id: 'cold-target', message: 'resume and continue' },
        callId: CallId('cold-delivery-call'),
        signal: new AbortController().signal,
        agent: sender.agent,
      })

      expect(result.isError).toBe(false)
      expect(result.content.some(block => block.type === 'text' && block.text.includes('This confirms delivery only'))).toBe(true)
      const resumed = ctx.agents.get(SessionId('cold-target'))
      expect(resumed).toBeDefined()
      await adapter.started.promise
      adapter.release.resolve(undefined)
      await resumed?.whenIdle()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
