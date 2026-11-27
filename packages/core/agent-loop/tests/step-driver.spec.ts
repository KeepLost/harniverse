/**
 * The factory's driver seam: a step driver registered in the agent's scope
 * replaces the model loop inside the same machine-owned turn.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
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

describe('a step driver registered in the agent scope', () => {
  it('replaces the model loop, so an agent with no model route still completes a turn', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const calls: string[] = []
    ctx.agents.registerDriver(host => ({
      async prepare(position) {
        calls.push(`prepare ${position.turn}:${position.step}`)
        return `prep-${position.step}`
      },
      async run(position, prep) {
        calls.push(`run ${position.turn}:${position.step} ${String(prep)}`)
        host.session.append('assistant/message', {
          turn: position.turn,
          step: position.step,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'from the external agent' }],
            source: { provider: 'acp', model: 'external' },
          }),
        }, { surfaceOp: 'append' })
        return { kind: 'completed' as const }
      },
    }))
    // No provider or model: the model loop would refuse the first request.
    const agent = ctx.agentLoop.create(SessionId('external'), {})
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(calls).toEqual(['prepare 1:1', 'run 1:1 prep-1'])
    expect(agent.session.events.filter(event => !event.type.startsWith('agent/inbox/')).map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(adapter.requests).toEqual([])
    expect(agent.session.events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })
})
