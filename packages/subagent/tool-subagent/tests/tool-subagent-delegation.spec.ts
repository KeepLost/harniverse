/**
 * Continuable delegation outcomes: waiting-mode resolution, empty child
 * output, and preserved partial answers on failed foreground invocations.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function continuableSetup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  config: Omit<tool.Config, 'provider'> = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-tool-subagent-delegation-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool, { provider: 'spawn', ...config })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

let calls = 0
function callSubagent(ctx: Context, args: unknown, agent: { id: ReturnType<typeof SessionId> }) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`delegation-${++calls}`),
    name: 'subagent',
    arguments: args,
    agent: agent as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('dsh-tool-subagent continuable delegation outcomes', () => {
  it('renders a textless sync invocation without a final-output section', async () => {
    const { ctx, parent } = await continuableSetup([[
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])

    const result = await callSubagent(ctx, { description: 'silent work', prompt: 'work quietly', mode: 'sync' }, parent)

    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.value).toMatchObject({ mode: 'sync', output: [] })
    expect(text(result)).toContain('completed invocation')
    expect(text(result)).not.toContain('Final output:')
  })

  it('reports a failed foreground invocation with its preserved partial answer', async () => {
    const { ctx, parent } = await continuableSetup([maxTokensResponse('partial answer')])

    const result = await callSubagent(ctx, { description: 'doomed work', prompt: 'get cut off', mode: 'sync' }, parent)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent run hit its token limit before finishing')
    expect(text(result)).toContain('Partial output before the run ended:')
    expect(text(result)).toContain('partial answer')
  })

  it('waits synchronously by default when background execution is disabled', async () => {
    const { ctx, parent } = await continuableSetup(
      [textResponse('foreground answer')],
      { enableRunInBackground: false, backgroundMode: 'continuable' },
    )

    const result = await callSubagent(ctx, { description: 'blocking work', prompt: 'answer now' }, parent)

    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.value).toMatchObject({ mode: 'sync' })
    expect(text(result)).toContain('foreground answer')
    expect(text(result)).toContain('Use session_message with session_id')
  })
})
