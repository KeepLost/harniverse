import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import type { HookConfigDiscovery } from '@deepseek-ai/dsh-hook-protocol'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop bridge tests: a scripted mock MODEL drives the REAL agent loop + REAL
 * bash executor, and the REAL `dsh-hooks-claude-code` bridge runs REAL shell hook
 * scripts written to a temp dir — only the model is mocked (the "prefer the real
 * implementation" rule). Each test writes a `hooks.json` + executable scripts,
 * loads the bridge pointed at them, and asserts the hook's effect on the loop.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function subagentCarrier(ctx: Context) {
  return scopeTarget(ctx as unknown as SubagentRuntime, undefined)
}

/** Write a hooks.json + named executable scripts into a fresh temp dir. */
function writeConfig(hooks: unknown, scripts: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }
  return dir
}

async function harness(configDir: string, adapter: MockAdapter, beforeHooks?: (ctx: Context) => void): Promise<Context> {
  return (await harnessWithFiber(configDir, adapter, beforeHooks)).ctx
}

/** {@link harness}, also exposing the bridge's fiber for tests that dispose it. */
async function harnessWithFiber(
  configDir: string | undefined,
  adapter: MockAdapter,
  beforeHooks?: (ctx: Context) => void,
  discovery?: HookConfigDiscovery,
): Promise<{ ctx: Context; hooks: Fiber }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  beforeHooks?.(ctx)
  const hooks = await ctx.plugin(HooksClaude, {
    ...configDir !== undefined ? { configPath: join(configDir, 'hooks.json') } : {},
    ...discovery !== undefined ? { discovery } : {},
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, hooks }
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function events(agent: Agent): SessionEvent[] {
  return [...agent.session.events]
}

async function autoHarness(
  adapter: MockAdapter,
  discovery?: HookConfigDiscovery,
  beforeHooks?: (ctx: Context) => void,
): Promise<{ ctx: Context; hooks: Fiber }> {
  return harnessWithFiber(undefined, adapter, beforeHooks, discovery)
}

function writeProjectHooks(dir: string, hooks: unknown): void {
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
}

function writeDefaultProjectHooks(dir: string, hooks: unknown): void {
  const path = join(dir, '.dsh', 'hooks', 'claude-code.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ hooks }))
}

/**
 * Poll `predicate` until it returns true or the deadline passes. Detached
 * emit-listener hooks (session-start, subagent) fire on a `.then` the test can't
 * await directly; polling for the observable EFFECT is robust under load, where a
 * single fixed sleep flakes ("async state is not synchronous state").
 */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

describe('hooks-claude-code bridge — UserPromptSubmit', () => {
  it('a UserPromptSubmit hook that exits 2 closes a blocked turn without a step', async () => {
    // UserPromptSubmit ignores its malformed matcher field, then exit 2 blocks
    // with the reason on stderr.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const block = join(dir, 'block.sh')
    writeFileSync(block, '#!/usr/bin/env bash\necho "prompt denied by policy" >&2\nexit 2\n')
    chmodSync(block, 0o755)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: '[', hooks: [{ type: 'command', command: block }] }] } }))

    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do something' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // The prompt was blocked inside its turn before any model step.
    expect(adapter.requests).toHaveLength(0)
    expect(events(agent).filter(e => e.type === 'turn/start' || e.type === 'hook/invoked'
      || e.type === 'hook/result' || e.type === 'turn/end').map(e => e.type))
      .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
  })

  it('a UserPromptSubmit hook printing additionalContext injects it for the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const ctxScript = join(dir, 'ctx.sh')
    writeFileSync(ctxScript, '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"remember: be brief"}}\'\n')
    chmodSync(ctxScript, 0o755)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: ctxScript }] }] } }))

    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // The injected context reached the model and is recorded with the plugin source.
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('remember: be brief')
    const ctxMsg = events(agent).find(e => e.type === 'user/message' && e.data.source.kind !== 'user')
    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.source).toEqual({ kind: 'plugin', plugin: 'hooks-claude-code' })
  })
})

describe('hooks-claude-code bridge — PreToolUse', () => {
  it('a matching PreToolUse hook that exits 2 denies the tool (isError result), tool never runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const deny = join(dir, 'deny.sh')
    writeFileSync(deny, '#!/usr/bin/env bash\necho "danger tool blocked" >&2\nexit 2\n')
    chmodSync(deny, 0o755)
    // Matcher "danger" (literal) selects only the danger tool.
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'danger', hooks: [{ type: 'command', command: deny }] }] } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'danger', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'danger', description: 'd', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'should not run' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use danger' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('danger tool blocked'))).toBe(true)
  })

  it('a PreToolUse hook whose matcher does NOT match leaves the tool alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const deny = join(dir, 'deny.sh')
    writeFileSync(deny, '#!/usr/bin/env bash\nexit 2\n')
    chmodSync(deny, 0o755)
    // Matcher only targets "danger" — the "safe" tool is untouched.
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'danger', hooks: [{ type: 'command', command: deny }] }] } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'safe', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'safe', description: 's', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ran ok' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use safe' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(ran).toBe(true)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(false)
  })
})

describe('hooks-claude-code bridge — PostToolUse', () => {
  it('a PostToolUse hook that blocks (exit 2) turns the result into an isError with feedback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const block = join(dir, 'block.sh')
    writeFileSync(block, '#!/usr/bin/env bash\necho "output rejected, retry" >&2\nexit 2\n')
    chmodSync(block, 0o755)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: block }] }] } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'raw output' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const result = events(agent).find(e => e.type === 'tool/result')
    // PostToolUse blocks AFTER the tool ran: the result is rewritten to isError + feedback.
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('output rejected, retry'))).toBe(true)
  })

  it('a PostToolUse hook printing additionalContext attaches it after the tool result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const s = join(dir, 'ctx.sh')
    writeFileSync(s, '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"note: tool was slow"}}\'\n')
    chmodSync(s, 0o755)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const resultIdx = log.findIndex(e => e.type === 'tool/result')
    const ctxIdx = log.findIndex(e => e.type === 'user/message' && e.data.source.kind !== 'user')
    expect(ctxIdx).toBeGreaterThan(resultIdx) // context appended AFTER the tool result
    const ctxMsg = log[ctxIdx]
    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.content.some(b => b.type === 'text' && b.text.includes('tool was slow'))).toBe(true)
  })

  it('a PreToolUse permissionDecision:ask fails closed without an approval service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const s = join(dir, 'ask.sh')
    writeFileSync(s, '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"needs approval"}}\'\n')
    chmodSync(s, 0o755)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'x' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // No approval service is mounted, so `ask` fails closed: the tool does not run and the result is isError.
    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('needs approval'))).toBe(true)
  })
})

describe('hooks-claude-code bridge — SessionStart', () => {
  it('a SessionStart hook injects additionalContext the first request sees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const s = join(dir, 'start.sh')
    writeFileSync(s, '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"project uses tabs"}}\'\n')
    chmodSync(s, 0o755)
    // matcher 'startup' selects the startup source.
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: s }] }] } }))

    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    // session-start fires async (detached .then → agent.inject); injection now
    // enters the next-step inbox directly and becomes a user/message only after
    // step entry, so synchronize on the pending inbox item before sending.
    await waitFor(() => agent.inbox.nextStep.some(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('project uses tabs'))))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('project uses tabs')
  })
})

describe('hooks-claude-code bridge — automatic discovery', () => {
  it('loads the shipped user-global file under DSH_HOME by default', async () => {
    const userHome = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-home-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-project-'))
    dirs.push(userHome, projectDir)
    mkdirSync(join(userHome, 'hooks'))
    const script = join(userHome, 'hooks', 'context.sh')
    writeFileSync(script, '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"global claude hook"}}\'\n')
    chmodSync(script, 0o755)
    writeFileSync(join(userHome, 'hooks', 'claude-code.json'), JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: script }] }],
    } }))

    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = userHome
    try {
      const adapter = new MockAdapter([textResponse('ok')])
      const { ctx, hooks } = await autoHarness(adapter)
      const handle = await ctx.agents.create({
        sessionId: SessionId('auto-claude-user-global'),
        meta: { cwd: projectDir },
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, handle.agent)

      expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('global claude hook')
      await handle.dispose()
      await hooks.dispose()
    } finally {
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
      else process.env.DSH_HOME = previousHome
    }
  })

  it('omits configPath and discovers the default hooks.json independently per session cwd', async () => {
    const firstDir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-project-'))
    const secondDir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-project-'))
    dirs.push(firstDir, secondDir)
    writeDefaultProjectHooks(firstDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })
    writeDefaultProjectHooks(secondDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] })

    const adapter = new MockAdapter([textResponse('second session ran')])
    const { ctx, hooks } = await autoHarness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('auto-claude-first'),
      meta: { cwd: firstDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first.agent)

    const second = await ctx.agents.create({
      sessionId: SessionId('auto-claude-second'),
      meta: { cwd: secondDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    second.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, second.agent)

    expect(adapter.requests).toHaveLength(1)
    expect(events(first.agent).some(event => event.type === 'hook/invoked')).toBe(true)
    expect(events(second.agent).some(event => event.type === 'hook/invoked')).toBe(true)
    await first.dispose()
    await second.dispose()
    await hooks.dispose()
  })

  it('treats an explicit configPath as a complete override of discovered sources', async () => {
    const explicitDir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-explicit-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-project-'))
    dirs.push(explicitDir, projectDir)
    writeProjectHooks(explicitDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] })
    writeProjectHooks(projectDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })

    const adapter = new MockAdapter([textResponse('explicit config won')])
    const ctx = await harness(explicitDir, adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('explicit-claude-override'),
      meta: { cwd: projectDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)

    expect(adapter.requests).toHaveLength(1)
    expect(events(handle.agent).filter(event => event.type === 'hook/invoked')).toHaveLength(1)
    await handle.dispose()
  })

  it('takes source changes on the next event while the current event keeps its immutable snapshot', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-project-'))
    dirs.push(projectDir)
    const hooksPath = join(projectDir, '.dsh', 'hooks', 'claude-code.json')
    const replacementPath = join(projectDir, 'replacement.json')
    const markerPath = join(projectDir, 'same-event-ran')
    writeFileSync(replacementPath, JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }],
    } }))
    writeDefaultProjectHooks(projectDir, {
      UserPromptSubmit: [{ hooks: [
        { type: 'command', command: `cp "${replacementPath}" "${hooksPath}"` },
        { type: 'command', command: `touch "${markerPath}"` },
      ] }],
    })

    const adapter = new MockAdapter([textResponse('first event ran')])
    const { ctx, hooks } = await autoHarness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('auto-claude-reload'),
      meta: { cwd: projectDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    expect(existsSync(markerPath)).toBe(true)

    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)
    expect(adapter.requests).toHaveLength(1)
    expect(events(handle.agent).filter(event => event.type === 'hook/invoked')).toHaveLength(3)
    await handle.dispose()
    await hooks.dispose()
  })

  it('continues with healthy sources when a configured source is unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-discovery-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-project-'))
    dirs.push(root, projectDir)
    writeFileSync(join(root, 'bad.json'), '{')
    writeProjectHooks(projectDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })
    const warn = vi.fn()
    const adapter = new MockAdapter([textResponse('should not run')])
    const { ctx, hooks } = await autoHarness(adapter, {
      root,
      user: ['bad.json'],
      project: ['hooks.json'],
    }, (context) => { context.logger.warn = warn as never })
    const handle = await ctx.agents.create({
      sessionId: SessionId('auto-claude-bad-source'),
      meta: { cwd: projectDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)

    expect(adapter.requests).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad.json'))
    await handle.dispose()
    await hooks.dispose()
  })

  it('disposes automatic-discovery listeners', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-project-'))
    dirs.push(projectDir)
    writeProjectHooks(projectDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })
    const adapter = new MockAdapter([textResponse('listener removed')])
    const { ctx, hooks } = await autoHarness(adapter)
    await hooks.dispose()
    const handle = await ctx.agents.create({
      sessionId: SessionId('auto-claude-disposed'),
      meta: { cwd: projectDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)

    expect(adapter.requests).toHaveLength(1)
    expect(events(handle.agent).some(event => event.type === 'hook/invoked')).toBe(false)
    await handle.dispose()
  })
})

describe('hooks-claude-code bridge — SubagentStart / SubagentStop (observe)', () => {
  it('runs SubagentStart and SubagentStop hooks when the subagent lifecycle events fire', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    // Each hook touches a marker file so we can assert it ran (these events are
    // observe-only — there is no decision to assert, only the side effect).
    const startMarker = join(dir, 'start-ran')
    const stopMarker = join(dir, 'stop-ran')
    const startHook = join(dir, 'start.sh')
    const stopHook = join(dir, 'stop.sh')
    writeFileSync(startHook, `#!/usr/bin/env bash\ntouch "${startMarker}"\n`)
    writeFileSync(stopHook, `#!/usr/bin/env bash\ntouch "${stopMarker}"\n`)
    chmodSync(startHook, 0o755)
    chmodSync(stopHook, 0o755)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      SubagentStart: [{ hooks: [{ type: 'command', command: startHook }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: stopHook }] }],
    } }))

    const adapter = new MockAdapter([])
    const { ctx, hooks } = await harnessWithFiber(dir, adapter)
    // Drive the observe-only lifecycle events directly (no real child needed — the
    // bridge just listens). No child agent is registered, so SubagentStart's
    // child lookup yields undefined and it simply runs the hook.
    ctx.emit(subagentCarrier(ctx), 'subagent/start', { runId: SubagentRunId('run-1'), provider: 'inproc', id: SessionId('child-1'), local: false })
    ctx.emit(subagentCarrier(ctx), 'subagent/end', { runId: SubagentRunId('run-1'), provider: 'inproc', id: SessionId('child-1'), local: false, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done' }] })

    // Both hooks run async (detached .then); poll for their marker files rather
    // than a fixed sleep that flakes under load.
    await waitFor(() => existsSync(startMarker) && existsSync(stopMarker))
    expect(existsSync(startMarker)).toBe(true)
    expect(existsSync(stopMarker)).toBe(true)
    // The markers prove the hook PROCESSES ran, not that the detached `.then`
    // continuations did (`touch` lands before the process exits). Dispose drains
    // them, so the no-context arm of the SubagentStart continuation — covered
    // only here — executes before this file's coverage snapshot instead of
    // racing it (the arm went uncovered on a loaded CI runner and failed the
    // per-file 100% branch gate).
    await hooks.dispose()
  })

  it('disposing the bridge aborts a still-running hook and drains to quiescence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-'))
    dirs.push(dir)
    const pidFile = join(dir, 'pid')
    const marker = join(dir, 'started')
    const slowHook = join(dir, 'slow.sh')
    // Record the hook shell's PID and touch the marker FIRST so the test can
    // tell "the hook is genuinely mid-run", then sleep far past the suite
    // timeout. Dispose must KILL the process (the tracker's abort signal), not
    // await its exit or its 10-minute default hook timeout.
    writeFileSync(slowHook, `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ntouch "${marker}"\nsleep 30\n`)
    chmodSync(slowHook, 0o755)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      SubagentStart: [{ hooks: [{ type: 'command', command: slowHook }] }],
    } }))

    const { ctx, hooks } = await harnessWithFiber(dir, new MockAdapter([]))
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    ctx.emit(subagentCarrier(ctx), 'subagent/start', { runId: SubagentRunId('run-1'), provider: 'inproc', id: SessionId('child-1'), local: false })
    await waitFor(() => existsSync(marker))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await hooks.dispose()
    // Quiescence, not just promptness: the drain resolves only after the run
    // settled, and the run settles only after the killed process was reaped —
    // so by the time dispose returns, the PID must be GONE (kill(pid, 0)
    // throws ESRCH). An untracked fire-and-forget regression would leave the
    // process alive (or unreaped) and fail this deterministically.
    expect(() => process.kill(pid, 0)).toThrow()
    // The aborted run resolves as a non-blocking error (runHook never rejects),
    // so the drained continuation must NOT have logged a failure.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('SubagentStart hook failed'))
  })
})

describe('hooks-claude-code bridge — load resilience', () => {
  it('a missing config file registers no hooks and does not crash the loop', async () => {
    const adapter = new MockAdapter([textResponse('fine')])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    await ctx.plugin(HooksClaude, { configPath: '/nonexistent/hooks.json' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // The turn ran normally — no hooks, no crash.
    expect(adapter.requests).toHaveLength(1)
  })

  it('an invalid regex matcher is reported and registers no hooks', async () => {
    const dir = writeConfig({
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }],
      PreToolUse: [{ matcher: '(', hooks: [{ type: 'command', command: 'exit 2' }] }],
    })
    const adapter = new MockAdapter([textResponse('fine')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, (ctx) => { ctx.logger.warn = warn as never })
    const agent = ctx.agentLoop.create(SessionId('invalid-claude-matcher'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(event => event.type === 'hook/invoked')).toBe(false)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'invalid claude-code regex matcher "(" on event "PreToolUse"',
    ))
  })

  it('an invalid matcher on an unsupported event does not disable supported hooks', async () => {
    const dir = writeConfig({
      Setup: [{ matcher: '(', hooks: [{ type: 'command', command: 'exit 0' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }],
    })
    const adapter = new MockAdapter([textResponse('should not run')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, (ctx) => { ctx.logger.warn = warn as never })
    const agent = ctx.agentLoop.create(SessionId('unsupported-claude-matcher'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(0)
    expect(events(agent).filter(event => event.type === 'turn/start' || event.type === 'hook/invoked'
      || event.type === 'hook/result' || event.type === 'turn/end').map(event => event.type))
      .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('invalid claude-code regex matcher'))
  })

  it('disposing the bridge fiber removes its listeners (HMR safety)', async () => {
    // A BLOCKING UserPromptSubmit hook: if the listener leaked past dispose it
    // would veto the prompt (0 model requests) and log a hook/invoked. Build the
    // ctx WITHOUT the harness's own bridge mount so this is the ONLY mount, then
    // dispose it — a leaked listener fails the test (a no-op `true` hook would
    // pass even leaked, so it proved nothing).
    const dir = writeConfig({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksClaude, { configPath: join(dir, 'hooks.json') })
    await fiber.dispose()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1) // not blocked → the listener is gone
    expect(events(agent).some(e => e.type === 'hook/invoked')).toBe(false) // no hook ran
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // Postmortem 0001 guard: this plugin HAS `inject = ['bash']`, so a stray
    // `export default apply` would collapse the module via `unwrapExports`
    // (`exports.default ?? exports`), DROP `inject`, and crash at load with
    // "cannot get property … without inject". Guard the shape directly.
    expect('default' in HooksClaude).toBe(false)
    expect(HooksClaude.name).toBe('hooks-claude-code')
    expect(HooksClaude.inject).toEqual(['shell'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(HooksClaude) as Record<string, unknown>
    expect(unwrapped).toBe(HooksClaude)
    expect(unwrapped.name).toBe('hooks-claude-code')
    expect(unwrapped.inject).toEqual(['shell'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
