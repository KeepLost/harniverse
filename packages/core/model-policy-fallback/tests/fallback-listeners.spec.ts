import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmFailure, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ModelPolicyService, { type Config } from '@deepseek-ai/dsh-model-policy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply, inject } from '../src/index.ts'

function text(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly (StreamChunk[] | Error)[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })),
      },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script[this.requests.length - 1]
    if (response instanceof Error) throw response
    for (const chunk of response ?? []) yield chunk
  }
}

async function boot(adapter: ScriptedAdapter, policy?: Config, initialProfile = 'routed'): Promise<{ ctx: Context; agent: Agent; fallback: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ModelPolicyService, policy ?? {
    profiles: {
      routed: {
        models: [],
        routes: ['fallback'],
        defaultTarget: { kind: 'route', route: 'fallback' },
      },
    },
    routes: {
      fallback: {
        targets: [
          { provider: 'primary', model: 'chat' },
          { provider: 'backup', model: 'chat' },
        ],
      },
    },
  })
  const fallback = await ctx.plugin(Object.assign((inner: Context) => { apply(inner) }, { inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['primary', 'backup'], adapter)
  const agent = ctx.agentLoop.create(SessionId('fallback'), { provider: 'primary', model: 'chat' })
  if (initialProfile !== undefined) ctx.modelPolicy.initialize(agent.session, initialProfile)
  return { ctx, agent, fallback }
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const collected: StreamChunk[] = []
  for await (const chunk of chunks) collected.push(chunk)
  return collected
}

const failure = (code: string): LlmFailure => ({ message: `${code} failure`, code })

describe('Model Route fallback listeners', () => {
  it('rejects installation without the model policy service', () => {
    const ctx = new Context()
    expect(() => { apply(ctx) }).toThrow('model-policy-fallback requires modelPolicy')
  })

  it('streams untagged one-shot requests without session enforcement', async () => {
    const { ctx } = await boot(new ScriptedAdapter([]))
    const chunks = await collect(ctx.llm.stream({ provider: 'primary', model: 'chat', messages: [] }))
    expect(chunks).toEqual([])
    await ctx.fiber.dispose()
  })

  it('refuses stream requests for sessions that are not attached', async () => {
    const { ctx } = await boot(new ScriptedAdapter([]))
    expect(() => ctx.llm.stream({ provider: 'primary', model: 'chat', messages: [], sessionId: SessionId('ghost') }))
      .toThrow('session "ghost" is not attached')
    await ctx.fiber.dispose()
  })

  it('refuses stream requests outside the session profile', async () => {
    const { ctx, agent } = await boot(new ScriptedAdapter([]))
    expect(() => ctx.llm.stream({ provider: 'other', model: 'chat', messages: [], sessionId: agent.session.id }))
      .toThrow('is not allowed by profile "routed"')
    await ctx.fiber.dispose()
  })

  it('carries the route effort override onto the redirected retry request', async () => {
    const adapter = new ScriptedAdapter([new LlmError('primary unavailable', 'AUTH'), text('backup works')])
    const { ctx, agent } = await boot(adapter, {
      profiles: {
        routed: {
          models: [],
          routes: ['fallback'],
          defaultTarget: { kind: 'route', route: 'fallback' },
        },
      },
      routes: {
        fallback: {
          targets: [
            { provider: 'primary', model: 'chat' },
            { provider: 'backup', model: 'chat', reasoningEffort: 'high' },
          ],
        },
      },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests.map(request => [request.provider, request.model, request.reasoningEffort])).toEqual([
      ['primary', 'chat', undefined],
      ['backup', 'chat', ReasoningEffortId('high')],
    ])
    await ctx.fiber.dispose()
  })

  it('records the provider HTTP status in the fallback event', async () => {
    const adapter = new ScriptedAdapter([new LlmError('primary unavailable', 'AUTH', { status: 511 }), text('backup works')])
    const { ctx, agent } = await boot(adapter)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.find(event => event.type === 'model/fallback')?.data).toMatchObject({
      failure: { code: 'AUTH', status: 511 },
    })
    await ctx.fiber.dispose()
  })

  it('stops after the last route target instead of appending a terminal fallback', async () => {
    const adapter = new ScriptedAdapter([new LlmError('primary unavailable', 'AUTH'), new LlmError('backup unavailable', 'AUTH')])
    const { ctx, agent } = await boot(adapter)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['primary', 'chat'],
      ['backup', 'chat'],
    ])
    expect(agent.session.events.filter(event => event.type === 'model/fallback')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('leaves the request config untouched when disposed mid-request despite a prior fallback', async () => {
    const { ctx, agent, fallback } = await boot(new ScriptedAdapter([]))
    agent.session.append('model/fallback', {
      turn: 5,
      step: 2,
      route: 'fallback',
      from: { provider: 'primary', model: 'chat' },
      to: { provider: 'backup', model: 'chat' },
      failure: { message: 'primary unavailable', code: 'AUTH' },
    })
    const config: LlmCallConfig = { provider: 'primary', model: 'chat' }
    let release!: (value: LlmCallConfig) => void
    const gate = new Promise<LlmCallConfig>((resolve) => { release = resolve })
    const dispatched = agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 5, step: 2, signal: new AbortController().signal },
      () => gate,
    )
    await Promise.resolve()
    await fallback.dispose()
    release(config)
    await expect(dispatched).resolves.toBe(config)
    await ctx.fiber.dispose()
  })

  it('returns the downstream error action unchanged for cancellations', async () => {
    const { ctx, agent } = await boot(new ScriptedAdapter([]))
    for (const code of ['ABORTED', 'CANCELLED', 'CANCELED']) {
      const dispatched = agentEvents(ctx, agent).waterfall(
        'agent/request-error',
        { turn: 1, step: 1, provider: 'primary', failure: failure(code), retryPolicy: undefined, signal: new AbortController().signal },
        async () => undefined,
      )
      await expect(dispatched).resolves.toBeUndefined()
    }
    expect(agent.session.events.filter(event => event.type === 'model/fallback')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('returns the downstream error action when a pre-aborted signal is supplied', async () => {
    const { ctx, agent } = await boot(new ScriptedAdapter([]))
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    const dispatched = agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      { turn: 1, step: 1, provider: 'primary', failure: failure('AUTH'), retryPolicy: undefined, signal: controller.signal },
      async () => undefined,
    )
    await expect(dispatched).resolves.toBeUndefined()
    expect(agent.session.events.filter(event => event.type === 'model/fallback')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('keeps the downstream retry action from another recovery owner', async () => {
    const { ctx, agent } = await boot(new ScriptedAdapter([]))
    const dispatched = agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      { turn: 1, step: 1, provider: 'primary', failure: failure('AUTH'), retryPolicy: undefined, signal: new AbortController().signal },
      async () => ({ kind: 'retry' }),
    )
    await expect(dispatched).resolves.toEqual({ kind: 'retry' })
    expect(agent.session.events.filter(event => event.type === 'model/fallback')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('returns the downstream error action when disposed mid-dispatch', async () => {
    const { ctx, agent, fallback } = await boot(new ScriptedAdapter([]))
    let release!: (value: undefined) => void
    const gate = new Promise<undefined>((resolve) => { release = resolve })
    const dispatched = agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      { turn: 1, step: 1, provider: 'primary', failure: failure('AUTH'), retryPolicy: undefined, signal: new AbortController().signal },
      () => gate,
    )
    await Promise.resolve()
    await fallback.dispose()
    release(undefined)
    await expect(dispatched).resolves.toBeUndefined()
    expect(agent.session.events.filter(event => event.type === 'model/fallback')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips fallback for sessions without a model target event', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ModelPolicyService)
    await ctx.plugin(Object.assign((inner: Context) => { apply(inner) }, { inject }))
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([])
    ctx.llm.registerAdapter(['primary'], adapter)
    const agent = ctx.agentLoop.create(SessionId('uninitialized'), { provider: 'primary', model: 'chat' })
    const dispatched = agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      { turn: 1, step: 1, provider: 'primary', failure: failure('AUTH'), retryPolicy: undefined, signal: new AbortController().signal },
      async () => undefined,
    )
    await expect(dispatched).resolves.toBeUndefined()
    expect(agent.session.events.filter(event => event.type === 'model/fallback')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips fallback when the active target pins a concrete model', async () => {
    const { ctx, agent } = await boot(new ScriptedAdapter([]), {
      profiles: {
        routed: {
          models: [],
          routes: ['fallback'],
          defaultTarget: { kind: 'route', route: 'fallback' },
        },
        pinned: {
          models: [{ provider: 'primary', model: 'chat' }],
          routes: [],
          defaultTarget: { kind: 'model', selection: { provider: 'primary', model: 'chat' } },
        },
      },
      routes: {
        fallback: {
          targets: [
            { provider: 'primary', model: 'chat' },
            { provider: 'backup', model: 'chat' },
          ],
        },
      },
    })
    ctx.modelPolicy.setProfile(agent.session, 'pinned')
    const dispatched = agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      { turn: 1, step: 1, provider: 'primary', failure: failure('AUTH'), retryPolicy: undefined, signal: new AbortController().signal },
      async () => undefined,
    )
    await expect(dispatched).resolves.toBeUndefined()
    expect(agent.session.events.filter(event => event.type === 'model/fallback')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('skips fallback when the route offers a single target', async () => {
    const { ctx, agent } = await boot(new ScriptedAdapter([]), {
      profiles: {
        solo: {
          models: [],
          routes: ['solo'],
          defaultTarget: { kind: 'route', route: 'solo' },
        },
      },
      routes: {
        solo: {
          targets: [{ provider: 'primary', model: 'chat' }],
        },
      },
    }, 'solo')
    const dispatched = agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      { turn: 1, step: 1, provider: 'primary', failure: failure('AUTH'), retryPolicy: undefined, signal: new AbortController().signal },
      async () => undefined,
    )
    await expect(dispatched).resolves.toBeUndefined()
    expect(agent.session.events.filter(event => event.type === 'model/fallback')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('falls back to the route head model when the failure carries no model', async () => {
    const { ctx, agent } = await boot(new ScriptedAdapter([]))
    const dispatched = agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      { turn: 9, step: 1, provider: 'primary', failure: failure('AUTH'), retryPolicy: undefined, signal: new AbortController().signal },
      async () => undefined,
    )
    await expect(dispatched).resolves.toEqual({ kind: 'retry' })
    expect(agent.session.events.find(event => event.type === 'model/fallback')?.data).toMatchObject({
      turn: 9,
      step: 1,
      route: 'fallback',
      from: { provider: 'primary', model: 'chat' },
      to: { provider: 'backup', model: 'chat' },
    })
    await ctx.fiber.dispose()
  })
})
