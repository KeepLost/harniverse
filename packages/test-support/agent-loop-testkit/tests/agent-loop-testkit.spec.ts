import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { mountAgentLoopTestDependencies } from '../src/index.ts'

describe('dsh-agent-loop-testkit', () => {
  it('mounts a configurable prerequisite spine that can activate AgentLoop', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { persona: 'Test persona.' },
      tools: { mode: 'native' },
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).toBe('You are an AI agent powered by Harniverse.')
    expect(renderContextSnapshot(assembly)).toContain('Test persona.')
    await expect(ctx.plugin(AgentLoop, { agents: [] })).resolves.toBeDefined()

    await ctx.fiber.dispose()
  })
})
