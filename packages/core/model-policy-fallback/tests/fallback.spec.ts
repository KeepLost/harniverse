import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ModelPolicyService from '@deepseek-ai/dsh-model-policy'
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
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script[this.requests.length - 1]
    if (response instanceof Error) throw response
    for (const chunk of response ?? []) yield chunk
  }
}

async function boot(adapter: ScriptedAdapter): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ModelPolicyService, {
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
  await ctx.plugin(Object.assign((inner: Context) => { apply(inner) }, { inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['primary', 'backup'], adapter)
  const agent = ctx.agentLoop.create(SessionId('fallback'), { provider: 'primary', model: 'chat' })
  ctx.modelPolicy.initialize(agent.session, 'routed')
  return { ctx, agent }
}

describe('Model Route fallback', () => {
  it('advances to the next concrete target after a terminal provider failure', async () => {
    const adapter = new ScriptedAdapter([new LlmError('primary unavailable', 'AUTH'), text('backup works')])
    const { ctx, agent } = await boot(adapter)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.model])).toEqual([
      ['primary', 'chat'],
      ['backup', 'chat'],
    ])
    expect(agent.session.events.find(event => event.type === 'model/fallback')?.data).toMatchObject({
      route: 'fallback',
      from: { provider: 'primary', model: 'chat' },
      to: { provider: 'backup', model: 'chat' },
      failure: { code: 'AUTH' },
    })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'backup works' }],
    })
    await ctx.fiber.dispose()
  })
})
