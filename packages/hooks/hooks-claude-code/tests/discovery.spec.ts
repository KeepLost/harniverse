import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Discovery-path variable binding: the vars snapshot a discovered source sees
 * (pluginRoot, projectDir, per-session cwd fallback) plus the skipped-hook and
 * no-session-cwd edges of `discoveredConfig`.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function executable(path: string, body: string): string {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

function writeSource(root: string, hooks: unknown): string {
  const path = join(root, 'hooks.json')
  writeFileSync(path, JSON.stringify({ hooks }))
  return path
}

interface DiscoveryHarness {
  ctx: Context
  hooks: import('@deepseek-ai/cordis').Fiber
  warn: ReturnType<typeof vi.fn>
}

async function harness(
  discovery: import('@deepseek-ai/dsh-hook-protocol').HookConfigDiscovery,
  opts: { pluginRoot?: string; projectDir?: string } = {},
): Promise<DiscoveryHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  const warn = vi.fn()
  ctx.logger.warn = warn as never
  const hooks = await ctx.plugin(HooksClaude, {
    discovery,
    ...opts.pluginRoot !== undefined ? { pluginRoot: opts.pluginRoot } : {},
    ...opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {},
  })
  return { ctx, hooks, warn }
}

describe('hooks-claude-code discovery variables', () => {
  it('binds configured pluginRoot and projectDir into discovered commands and warns on skipped hooks', async () => {
    const pluginRoot = tempDir('dsh-cc-plugin-root-')
    const projectDir = tempDir('dsh-cc-project-')
    const root = tempDir('dsh-cc-discovery-')
    const substituted = join(root, 'plugin-root-substituted')
    executable(join(pluginRoot, 'ctx.sh'), [
      '#!/usr/bin/env bash',
      `touch "${substituted}"`,
      'printf \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"proj=%s"}}\' "$CLAUDE_PROJECT_DIR"',
      '',
    ].join('\n'))
    const source = writeSource(root, {
      UserPromptSubmit: [{ hooks: [
        { type: 'tool', name: 'Plan' },
        { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/ctx.sh' },
      ] }],
    })

    const adapter = new MockAdapter([textResponse('ok')])
    const { ctx, hooks, warn } = await harness(
      { root, user: ['hooks.json'], project: [] },
      { pluginRoot, projectDir },
    )
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('cc-discovery-vars'),
      meta: { cwd: projectDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain(`proj=${projectDir}`)
    expect(existsSync(substituted)).toBe(true)
    const skipped = warn.mock.calls.map(call => String(call[0])).find(text => text.includes('skipping unsupported'))
    expect(skipped).toBe(`hooks-claude-code: skipping unsupported "tool" hook on UserPromptSubmit from "${source}" (only command hooks run)`)
    await handle.dispose()
    await hooks.dispose()
  })

  it('discovers for a no-agent direct tool run with no session cwd', async () => {
    const root = tempDir('dsh-cc-discovery-')
    const marker = join(root, 'no-agent-ran')
    writeSource(root, {
      PreToolUse: [{ hooks: [{ type: 'command', command: `touch "${marker}"` }] }],
    })

    const { ctx, hooks } = await harness({ root, user: ['hooks.json'], project: [] })
    ctx.tools.register(defineContentToolFixture({
      name: 'Bash',
      description: 'b',
      parameters: { command: { type: 'string' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('cc-no-agent'),
      name: 'Bash',
      arguments: { command: 'x' },
    })

    expect(result.isError).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(existsSync(marker)).toBe(true)
    await hooks.dispose()
  })
})
