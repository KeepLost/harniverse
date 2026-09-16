// `/context` renders the inspector's manifest through the command executor,
// including the executor-owned lifecycle pair and the composed-unavailable arm.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import ContextInspector from '@deepseek-ai/dsh-context-inspector'
import * as commandContext from '@deepseek-ai/dsh-command-context'
import { renderManifest } from '@deepseek-ai/dsh-command-context/src/index.ts'
import { MockAdapter, textResponse } from '../../context-inspector/tests/mock-adapter.ts'

async function harness(withInspector = true): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are precise.' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  if (withInspector) await ctx.plugin(ContextInspector)
  await ctx.plugin(commandContext)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
  ctx.tools.register(defineContentToolFixture({
    name: 'context_compact',
    description: 'Compact older conversation history.',
    parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
  }))
  const agent = ctx.agentLoop.create(SessionId('command-context'), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, agent }
}

async function run(
  ctx: Context,
  agent: Agent,
  line = '/context',
  signal = new AbortController().signal,
): Promise<CommandResult | undefined> {
  const execution = await ctx.commands.execute(agent, line, [], signal)
  return execution?.result
}

describe('command-context', () => {
  it('renders the live manifest with per-segment provenance', async () => {
    const { ctx, agent } = await harness()
    const result = await run(ctx, agent)
    expect(result?.kind).toBe('success')
    const text = result?.kind === 'success' ? result.text : ''
    expect(text).toContain('Next request:')
    expect(text).toContain('[system] system-prompt')
    expect(text).toContain('Tools (1): context_compact.')
    const lifecycle = agent.session.events
      .filter(event => event.type === 'command/run' || event.type === 'command/done')
    expect(lifecycle).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('rejects arguments with the usage line', async () => {
    const { ctx, agent } = await harness()
    const result = await run(ctx, agent, '/context now')
    expect(result).toEqual({ kind: 'error', text: 'Usage: /context (no arguments)' })
    await ctx.fiber.dispose()
  })

  it('answers unavailable when the composition ships no inspector', async () => {
    const { ctx, agent } = await harness(false)
    const result = await run(ctx, agent)
    expect(result).toEqual({
      kind: 'error',
      text: 'Context inspection is unavailable for this composition.',
    })
    await ctx.fiber.dispose()
  })

  it('omits the text suffix for segments without a preview', () => {
    const text = renderManifest({
      segments: [{ plane: 'system', kind: 'system-prompt', text: '', tokens: 7 }],
      tools: [],
      totalTokens: 7,
    })
    expect(text).toBe(
      'Next request: 1 segments, ~7 tokens.\n'
      + '  [system] system-prompt (~7 tokens)\n'
      + 'Tools: none.',
    )
  })

  it('renders empty tools and shadowed provenance compactly', () => {
    const text = renderManifest({
      segments: [
        {
          plane: 'conversation',
          kind: 'compaction',
          text: 'summarized earlier work',
          tokens: 40,
          seq: 2,
          shadowedSeqs: [1, 2],
        },
      ],
      tools: [],
      totalTokens: 40,
    })
    expect(text).toBe(
      'Next request: 1 segments, ~40 tokens.\n'
      + '  [conversation] compaction #2 (replaced 2 items) (~40 tokens): summarized earlier work\n'
      + 'Tools: none.',
    )
  })
})
