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

describe('session_message', () => {
  it('describes the ordinary-session creation and direct-child continuation workflow', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSessionDelivery)
    await ctx.plugin(tool)

    const create = ctx.tools.schemas().find(schema => schema.name === 'session_create')
    const createProperties = (create?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(createProperties)).toEqual(['agent_profile_id'])
    expect(create?.description).toContain('does not send an initial message')
    expect(create?.description).toContain('session_message')
    expect(ctx.tools.schemas().find(schema => schema.name === 'session_message')?.description)
      .toContain('direct subagent')

    await ctx.fiber.dispose()
  })

  it('creates a persistent ordinary session through the Agent factory', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSessionDelivery)
    await ctx.plugin(tool)
    const sender = (await ctx.agents.create({
      sessionId: SessionId('creator'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent

    const result = await ctx.tools.execute({
      name: 'session_create',
      arguments: {},
      callId: CallId('create-call'),
      signal: new AbortController().signal,
      agent: sender,
    })

    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('Created persistent session'))).toBe(true)
    const created = ctx.agents.list().find(agent => agent.id !== sender.id)
    expect(created).toBeDefined()
    expect(created?.session.header.origin).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('forwards agent_profile_id into the created Session identity', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.provide('agentPresets', {
      resolve: (id: string | undefined) => Promise.resolve({ id: id ?? 'standard' }),
      mount: () => Promise.resolve(),
    } as never)
    await ctx.plugin(LocalSessionDelivery)
    await ctx.plugin(tool)
    const sender = (await ctx.agents.create({
      sessionId: SessionId('profile-creator'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent

    const result = await ctx.tools.execute({
      name: 'session_create',
      arguments: { agent_profile_id: 'code' },
      callId: CallId('profile-create-call'),
      signal: new AbortController().signal,
      agent: sender,
    })

    expect(result.isError, JSON.stringify(result)).toBe(false)
    if (result.isError) throw new Error('expected session_create success')
    expect(result.value).toMatchObject({ agentProfile: 'code' })
    const created = ctx.agents.list().find(agent => agent.id !== sender.id)
    expect(created?.session.header.agentProfile).toBe('code')
    await ctx.fiber.dispose()
  })

  it('rejects the removed profile_id instead of creating with the default Profile', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSessionDelivery)
    await ctx.plugin(tool)
    const sender = (await ctx.agents.create({
      sessionId: SessionId('legacy-profile-creator'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent

    const result = await ctx.tools.execute({
      name: 'session_create',
      arguments: { profile_id: 'standard' },
      callId: CallId('legacy-profile-create-call'),
      signal: new AbortController().signal,
      agent: sender,
    })

    expect(result.isError).toBe(true)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('profile_id was removed; use agent_profile_id'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('returns after live inbox acceptance without waiting for the target reply', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSessionDelivery)
    await ctx.plugin(tool)
    expect(ctx.tools.get('session_message')).toBeDefined()
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
      name: 'session_message',
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
        name: 'session_message',
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

describe('calling-agent authority', () => {
  it('fails loud without a calling agent for every session tool', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSessionDelivery)
    await ctx.plugin(tool)
    const signal = new AbortController().signal

    const rendered = async (name: string, args: unknown, callId: string): Promise<string> => {
      const result = await ctx.tools.execute({ name, arguments: args, callId: CallId(callId), signal })
      expect(result.isError).toBe(true)
      return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    }

    expect(await rendered('session_message', { session_id: 'any', message: 'hello' }, 'no-agent-message'))
      .toContain('session_message requires a calling agent')
    expect(await rendered('session_create', {}, 'no-agent-create'))
      .toContain('session_create requires a calling agent')
    expect(await rendered('session_unload', { session_id: 'any' }, 'no-agent-unload'))
      .toContain('session_unload requires a calling agent')

    await ctx.fiber.dispose()
  })
})
