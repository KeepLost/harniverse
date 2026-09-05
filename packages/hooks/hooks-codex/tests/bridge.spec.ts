import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksCodex from '@deepseek-ai/dsh-hooks-codex'
import type { HookConfigDiscovery } from '@deepseek-ai/dsh-hook-protocol'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop Codex bridge tests with a mock model, the real loop and bash
 * executor, and shell hooks from a temporary config. Covers regex matching,
 * block-only decisions, and the five-event subset.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-codex-'))
  dirs.push(dir)
  return dir
}
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}
function writeHooks(dir: string, hooks: unknown): void {
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
}

function writeDefaultProjectHooks(dir: string, hooks: unknown): void {
  const path = join(dir, '.dsh', 'hooks', 'codex.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ hooks }))
}

async function autoHarness(
  adapter: MockAdapter,
  discovery?: HookConfigDiscovery,
  beforeHooks?: (ctx: Context) => void,
): Promise<{ ctx: Context; hooks: import('@deepseek-ai/cordis').Fiber }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  beforeHooks?.(ctx)
  const hooks = await ctx.plugin(HooksCodex, {
    model: 'test-model',
    ...discovery !== undefined ? { discovery } : {},
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, hooks }
}

async function harness(dir: string, adapter: MockAdapter, beforeHooks?: (ctx: Context) => void): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  beforeHooks?.(ctx)
  await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'test-model' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}
function events(agent: Agent): SessionEvent[] { return [...agent.session.events] }

/** Poll `predicate` until true or the deadline passes (detached hook effects can't be awaited directly). */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

describe('hooks-codex bridge', () => {
  it('a PreToolUse hook (exit 2) denies a tool the regex matcher matches as a substring', async () => {
    const dir = configDir()
    const deny = script(dir, 'deny.sh', '#!/usr/bin/env bash\necho "codex blocked it" >&2\nexit 2\n')
    // Codex regex matcher: "Bash" is /Bash/ — matches the tool name "Bash".
    writeHooks(dir, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: deny }] }] })

    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'ls' }), textResponse('done')])
    const ctx = await harness(dir, adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'no' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run ls' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('codex blocked it'))).toBe(true)
    expect(events(agent).some(e => e.type === 'hook/invoked' && e.data.dialect === 'codex' && e.data.point === 'PreToolUse')).toBe(true)
  })

  it('a Stop hook (exit 2) forces the turn to continue with the reason as steering', async () => {
    const dir = configDir()
    // Stop ignores its malformed matcher field. Block once with a marker;
    // until the loop guard lands, an always-blocking hook would never finish.
    const marker = join(dir, 'fired')
    const cont = script(dir, 'cont.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\necho "keep going: address the goal" >&2\nexit 2\n`)
    writeHooks(dir, { Stop: [{ matcher: '[', hooks: [{ type: 'command', command: cont }] }] })

    const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer after goal')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('keep going: address the goal')
  }, 15_000) // Two real hook subprocesses and agent steps need startup and teardown headroom under load.

  it('turn cancellation aborts and reaps a running UserPromptSubmit hook before idle', async () => {
    const dir = configDir()
    const pidFile = join(dir, 'pid')
    const marker = join(dir, 'started')
    const slow = script(dir, 'slow-prompt.sh', `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ntouch "${marker}"\nsleep 30\n`)
    writeHooks(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: slow }] }] })

    const adapter = new MockAdapter([textResponse('must not run')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('cancel-prompt-hook'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel the hook' }], source: { kind: 'user' } }))
    await waitFor(() => existsSync(marker))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())

    const idle = agent.whenIdle()
    agent.cancel({ kind: 'user' })
    await idle

    expect(() => process.kill(pid, 0)).toThrow()
    expect(adapter.requests).toHaveLength(0)
    expect(events(agent).filter(event => event.type === 'turn/start' || event.type === 'hook/invoked'
      || event.type === 'hook/result' || event.type === 'turn/end').map(event => event.type))
      .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
  })

  it('only the five bridge-supported Codex events are honored — a SubagentStop entry is ignored', async () => {
    const dir = configDir()
    const s = script(dir, 'x.sh', '#!/usr/bin/env bash\nexit 2\n')
    writeHooks(dir, { SubagentStop: [{ hooks: [{ type: 'command', command: s }] }] })

    const adapter = new MockAdapter([textResponse('fine')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('a missing config registers no hooks and does not crash', async () => {
    const dir = configDir() // no hooks.json written
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('an invalid regex matcher is reported and registers no hooks', async () => {
    const dir = configDir()
    writeHooks(dir, {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }],
      PreToolUse: [{ matcher: '[', hooks: [{ type: 'command', command: 'exit 2' }] }],
    })
    const adapter = new MockAdapter([textResponse('ok')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, (ctx) => { ctx.logger.warn = warn as never })
    const agent = ctx.agentLoop.create(SessionId('invalid-codex-matcher'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(event => event.type === 'hook/invoked')).toBe(false)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'invalid codex regex matcher "[" on event "PreToolUse"',
    ))
  })

  it('disposing the bridge fiber removes its listeners (HMR safety)', async () => {
    const dir = configDir()
    // A leaked listener would let this blocking hook veto the prompt and log an invocation; a
    // no-op hook would pass even when leaked.
    const deny = script(dir, 'deny.sh', '#!/usr/bin/env bash\nexit 2\n')
    writeHooks(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: deny }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'm' })
    await fiber.dispose()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1) // not blocked → the listener is gone
    expect(events(agent).some(e => e.type === 'hook/invoked')).toBe(false) // no hook ran
  })

  it('disposing the bridge aborts a still-running SessionStart hook and drains to quiescence', async () => {
    const dir = configDir()
    const pidFile = join(dir, 'pid')
    const marker = join(dir, 'started')
    // Record the PID and marker before sleeping past the suite timeout. Disposal must abort the
    // tracked process through `runPoint`, not await its natural exit.
    const slow = script(dir, 'slow.sh', `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ntouch "${marker}"\nsleep 30\n`)
    writeHooks(dir, { SessionStart: [{ hooks: [{ type: 'command', command: slow }] }] })
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'm' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' }) // fires agent/session-start
    await waitFor(() => existsSync(marker))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await fiber.dispose()
    // Disposal reaches quiescence only after the aborted run settles and the process is reaped, so
    // `kill(pid, 0)` must report ESRCH. Untracked fire-and-forget work would remain.
    expect(() => process.kill(pid, 0)).toThrow()
    // runHook resolves an aborted run as a non-blocking error, so draining must
    // not log a rejected continuation.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('SessionStart hook failed'))
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in HooksCodex).toBe(false)
    expect(HooksCodex.name).toBe('hooks-codex')
    expect(HooksCodex.inject).toEqual(['shell'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(HooksCodex) as Record<string, unknown>
    expect(unwrapped).toBe(HooksCodex)
    expect(unwrapped.name).toBe('hooks-codex')
    expect(unwrapped.inject).toEqual(['shell'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})

describe('hooks-codex bridge — automatic discovery', () => {
  it('omits configPath and discovers the default hooks.json independently per session cwd', async () => {
    const firstDir = configDir()
    const secondDir = configDir()
    writeDefaultProjectHooks(firstDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })
    writeDefaultProjectHooks(secondDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] })

    const adapter = new MockAdapter([textResponse('second session ran')])
    const { ctx, hooks } = await autoHarness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('auto-codex-first'),
      meta: { cwd: firstDir },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first.agent)

    const second = await ctx.agents.create({
      sessionId: SessionId('auto-codex-second'),
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
    const explicitDir = configDir()
    const projectDir = configDir()
    writeHooks(explicitDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] })
    writeHooks(projectDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })

    const adapter = new MockAdapter([textResponse('explicit config won')])
    const ctx = await harness(explicitDir, adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('explicit-codex-override'),
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
    const projectDir = configDir()
    const hooksPath = join(projectDir, '.dsh', 'hooks', 'codex.json')
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
      sessionId: SessionId('auto-codex-reload'),
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
    const root = configDir()
    const projectDir = configDir()
    writeFileSync(join(root, 'bad.json'), '{')
    writeHooks(projectDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })
    const warn = vi.fn()
    const adapter = new MockAdapter([textResponse('should not run')])
    const { ctx, hooks } = await autoHarness(adapter, {
      root,
      user: ['bad.json'],
      project: ['hooks.json'],
    }, (context) => { context.logger.warn = warn as never })
    const handle = await ctx.agents.create({
      sessionId: SessionId('auto-codex-bad-source'),
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

  it('warns on a skipped async hook loaded from a discovered source', async () => {
    const root = configDir()
    const marker = join(root, 'discovery-ran')
    writeFileSync(join(root, 'codex.json'), JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [
        { type: 'command', command: 'bg.sh', async: true },
        { type: 'command', command: `touch "${marker}"` },
      ] }],
    } }))
    const warn = vi.fn()
    const adapter = new MockAdapter([textResponse('ok')])
    const { ctx, hooks } = await autoHarness(adapter, {
      root,
      user: ['codex.json'],
      project: [],
    }, (context) => { context.logger.warn = warn as never })
    const handle = await ctx.agents.create({
      sessionId: SessionId('auto-codex-skipped'),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)

    await waitFor(() => existsSync(marker))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(
      /hooks-codex: skipping async hook on UserPromptSubmit from ".*codex\.json" \(only sync command hooks run\)/,
    ))
    await handle.dispose()
    await hooks.dispose()
  })

  it('disposes automatic-discovery listeners', async () => {
    const projectDir = configDir()
    writeHooks(projectDir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] })
    const adapter = new MockAdapter([textResponse('listener removed')])
    const { ctx, hooks } = await autoHarness(adapter)
    await hooks.dispose()
    const handle = await ctx.agents.create({
      sessionId: SessionId('auto-codex-disposed'),
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
