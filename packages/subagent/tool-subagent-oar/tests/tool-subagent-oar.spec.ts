/** Runtime-alias selection, one-shot provider guards, and Loader metadata. */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, {
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as externalTool from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  const calls: { provider: string; request: ResolvedSubagentStartRequest }[] = []
  for (const name of ['codex-provider', 'claude-provider', 'future-provider']) {
    ctx.subagents.registerProvider({
      name,
      capabilities: NO_START_CAPABILITIES,
      inheritsParentContext: false,
      start: async (request) => {
        calls.push({ provider: name, request })
        return {
          id: SessionId(randomUUID()),
          result: Promise.resolve({ output: [{ type: 'text' as const, text: 'child result' }], stopReason: 'completed' as const }),
          dispose: () => Promise.resolve(),
          localAgent: undefined,
        }
      },
    })
  }
  const parent = {
    id: SessionId(randomUUID()),
    session: { header: { cwd: process.cwd() } },
  } as unknown as Agent
  return { ctx, parent, calls }
}

let callCounter = 0

function callTool(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`oar-tool-${++callCounter}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
}

describe('subagent_oar tool', () => {
  it('selects one configured provider per call and exposes only task inputs', async (test) => {
    const { ctx, parent, calls } = await setup()
    test.onTestFinished(() => ctx.fiber.dispose())
    const fiber = await ctx.plugin(externalTool, {
      providers: { codex: 'codex-provider', claude: 'claude-provider', future: 'future-provider' },
    })
    const schema = ctx.tools.schemas().find(tool => tool.name === 'subagent_oar')
    expect(schema?.parameters.required).toEqual(['runtime', 'description', 'prompt'])
    expect(Object.keys(schema?.parameters.properties as Record<string, unknown>).sort()).toEqual(['description', 'prompt', 'runtime'])
    expect(schema?.parameters.properties).toMatchObject({ runtime: { enum: ['codex', 'claude', 'future'] } })
    for (const runtime of ['codex', 'claude', 'future']) {
      const result = await callTool(ctx, 'subagent_oar', { runtime, description: `Use ${runtime}`, prompt: 'independent task' }, parent)
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      const text = JSON.stringify(result.content)
      expect(text).toContain('completed invocation')
      expect(text).toContain('child result')
    }
    expect(calls.map(call => call.provider)).toEqual(['codex-provider', 'claude-provider', 'future-provider'])
    expect(calls[0]?.request.prompt).toEqual([{ type: 'text', text: 'independent task' }])
    expect(calls[0]?.request.parent).toBe(parent)
    expect(ctx.tools.get('subagent_oar')?.isConcurrencySafe?.({
      runtime: 'codex', description: 'task', prompt: 'task',
    })).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(false)
  })

  it('flattens an early-stopped child into an error carrying partial output', async (test) => {
    const { ctx, parent } = await setup()
    test.onTestFinished(() => ctx.fiber.dispose())
    ctx.subagents.registerProvider({
      name: 'failing',
      capabilities: NO_START_CAPABILITIES,
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId(randomUUID()),
        result: Promise.resolve({
          output: [{ type: 'text' as const, text: 'partial work' }],
          stopReason: 'error' as const,
          diagnostic: 'OAR subagent failure (stage: turn; category: unknown).',
        }),
        dispose: () => Promise.resolve(),
        localAgent: undefined,
      }),
    })
    await ctx.plugin(externalTool, { providers: { broken: 'failing' } })
    const result = await callTool(ctx, 'subagent_oar', { runtime: 'broken', description: 'task', prompt: 'task' }, parent)
    expect(result.isError).toBe(true)
    const text = JSON.stringify(result.content)
    expect(text).toContain('stopped early')
    expect(text).toContain('partial work')
  })

  it('rejects unconfigured runtime names before starting any child', async (test) => {
    const { ctx, parent, calls } = await setup()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
    const result = await callTool(ctx, 'subagent_oar', { runtime: 'unconfigured', description: 'task', prompt: 'task' }, parent)
    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('fails visibly when the selected provider disappears', async (test) => {
    const { ctx, parent, calls } = await setup()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(externalTool, { providers: { missing: 'missing-provider' } })
    const result = await callTool(ctx, 'subagent_oar', { runtime: 'missing', description: 'task', prompt: 'task' }, parent)
    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('rejects empty runtime maps and keeps Loader metadata', async (test) => {
    const { ctx } = await setup()
    test.onTestFinished(() => ctx.fiber.dispose())
    expect('default' in externalTool).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(externalTool)).toBe(externalTool)
    await expect(ctx.plugin(externalTool, { providers: {} })).rejects.toThrow('at least one')
    await expect(ctx.plugin(externalTool, { providers: { ' ': 'codex-provider' } })).rejects.toThrow('non-empty')
  })

  it('requires a caller and independently scoped one-shot providers', async (test) => {
    const { ctx, parent } = await setup()
    test.onTestFinished(() => ctx.fiber.dispose())
    ctx.subagents.registerProvider({
      name: 'inherited',
      capabilities: NO_START_CAPABILITIES,
      inheritsParentContext: true,
      start: async () => { throw new Error('must not run') },
    })
    await ctx.plugin(externalTool, { providers: { inherited: 'inherited' } })
    const args = { runtime: 'inherited', description: 'task', prompt: 'task' }
    const noParent = await callTool(ctx, 'subagent_oar', args)
    expect(noParent.isError).toBe(true)
    const inherited = await callTool(ctx, 'subagent_oar', args, parent)
    expect(inherited.isError).toBe(true)
    expect(JSON.stringify(inherited.content)).toContain('independent conversation')
  })

  it('presents the task description on the call card', async (test) => {
    const { ctx } = await setup()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
    const args = { runtime: 'codex', description: 'Inspect child', prompt: 'task' }
    expect(ctx.tools.get('subagent_oar')?.presentCall?.(args)).toEqual({
      card: 'generic', title: 'Inspect child', rawInput: args,
    })
  })

  it('supports direct composition with the declared optional defaults', async (test) => {
    const { ctx } = await setup()
    test.onTestFinished(() => ctx.fiber.dispose())
    externalTool.apply(ctx, { providers: { codex: 'codex-provider' } })
    expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(true)
  })
})
