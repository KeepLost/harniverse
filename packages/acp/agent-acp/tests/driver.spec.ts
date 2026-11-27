/**
 * ACP mode through the real factory: an agent sealed with the ACP step driver
 * runs its turns on a scripted external agent in a real child process, and the
 * session log carries what the model loop would have written.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as acp from '../src/index.ts'

const fakeAgent = fileURLToPath(new URL('./fake-agent.ts', import.meta.url))

interface Turn {
  updates?: Record<string, unknown>[]
  stopReason?: string
  permission?: { title?: string; toolCallId?: string; options: { optionId: string; name: string; kind: string }[] }
  hang?: boolean
  exit?: number
  settle?: number
  echoCwd?: boolean
}

interface Harness {
  readonly ctx: Context
  readonly dir: string
  readonly log: () => Record<string, unknown>[]
  readonly eof: () => boolean
}

async function harness(
  turns: Turn[],
  config: Partial<acp.Config> = {},
  mounts: { approval?: boolean } = {},
  extra: { name?: string | null } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-acp-'))
  const scenario = join(dir, 'scenario.json')
  const log = join(dir, 'log.jsonl')
  const eof = join(dir, 'eof')
  writeFileSync(scenario, JSON.stringify({ turns, ...extra }))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (mounts.approval === true) await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(acp, {
    command: process.execPath,
    args: [fakeAgent],
    env: { ACP_FAKE_SCENARIO: scenario, ACP_FAKE_LOG: log, ACP_FAKE_EOF: eof },
    credentialEnv: {},
    permission: 'reject',
    ...config,
  })
  return {
    ctx,
    dir,
    log: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [],
    eof: () => existsSync(eof),
  }
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

function core(agent: Agent): SessionEvent[] {
  return agent.session.events.filter(event => !event.type.startsWith('agent/inbox/'))
}

function textOf(event: SessionEvent | undefined): string {
  if (event === undefined || event.type !== 'assistant/message') return ''
  return event.data.message.content.map(block => block.type === 'text' ? block.text : block.type === 'tool-call' ? `[${block.name}]` : '(reasoning)').join('')
}

/** Send one message in a session whose workspace is the scenario directory, and wait for the turn. */
async function run(h: Harness, text: string): Promise<Agent> {
  const agent = h.ctx.agentLoop.create(SessionId('acp'), {}, { cwd: h.dir })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(h.ctx, agent)
  return agent
}

const chunk = (value: string): Record<string, unknown> => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
const thought = (value: string): Record<string, unknown> => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value } })

describe('an ACP-mode agent', () => {
  it('writes the external reply as one model-loop-shaped step and passes the prompt through', async () => {
    const h = await harness([{ updates: [chunk('Hello'), chunk(' world')] }])
    try {
      const agent = await run(h, 'hi there')
      expect(core(agent).map(event => event.type)).toEqual([
        'turn/start', 'step/start', 'user/message', 'acp/session', 'assistant/chunk', 'assistant/chunk', 'assistant/chunk',
        'assistant/message', 'step/end', 'turn/end',
      ])
      expect(core(agent).find(event => event.type === 'acp/session')).toMatchObject({ data: { sessionId: 'external-1', reached: 'new' } })
      expect(textOf(core(agent).find(event => event.type === 'assistant/message'))).toBe('Hello world')
      expect(core(agent).at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
      const prompts = h.log().filter(entry => entry.method === 'session/prompt')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.params).toMatchObject({ sessionId: 'external-1', prompt: [{ type: 'text', text: 'hi there' }] })
      expect(h.log().find(entry => entry.method === 'assistant/message')).toBeUndefined()
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('keeps reasoning apart from the visible answer', async () => {
    const h = await harness([{ updates: [thought('thinking'), chunk('answer')] }])
    try {
      const agent = await run(h, 'q')
      const message = core(agent).find(event => event.type === 'assistant/message')
      expect(message?.type === 'assistant/message' && message.data.message.content).toEqual([
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'answer' },
      ])
      expect(message?.type === 'assistant/message' && message.data.message.source).toEqual({ kind: 'model', provider: 'acp', model: 'fake-external' })
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('splits a turn around tool calls: one step per run of speech, calls and results in the step that made them', async () => {
    const h = await harness([{
      updates: [
        chunk('Let me look'),
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'List files', kind: 'search' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] },
        chunk('Done'),
      ],
    }])
    try {
      const agent = await run(h, 'list')
      const events = core(agent)
      expect(events.filter(event => event.type === 'step/start').length).toBe(2)
      const messages = events.filter(event => event.type === 'assistant/message')
      expect(messages.map(textOf)).toEqual(['Let me look[search]', 'Done'])
      const first = events.findIndex(event => event.type === 'assistant/message')
      expect(events.slice(first, first + 4).map(event => event.type)).toEqual(['assistant/message', 'tool/call', 'tool/result', 'step/end'])
      expect(events[first + 1]).toMatchObject({ data: { turn: 1, step: 1, callId: 't1', name: 'search', arguments: 'List files' } })
      expect(events[first + 2]).toMatchObject({ data: { message: { content: [{ type: 'tool-result', toolCallId: 't1', isError: false, content: [{ type: 'text', text: 'a.txt' }] }] } } })
      expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
      // One external prompt produced both steps.
      expect(h.log().filter(entry => entry.method === 'session/prompt')).toHaveLength(1)
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('holds speech that arrives while a tool is still running, and records a failed tool as an error result', async () => {
    const h = await harness([{
      updates: [
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run build' },
        chunk('early'),
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' },
      ],
    }])
    try {
      const agent = await run(h, 'build')
      const events = core(agent)
      const first = events.findIndex(event => event.type === 'assistant/message')
      expect(events.slice(first, first + 3).map(event => event.type)).toEqual(['assistant/message', 'tool/call', 'tool/result'])
      expect(events[first + 2]).toMatchObject({
        data: { error: { name: 'AcpToolError', code: 'failed' }, message: { content: [{ isError: true, content: [{ type: 'text', text: 'Run build' }] }] } },
      })
      // The held speech waited for the step boundary, then became the second step's message.
      expect(events.filter(event => event.type === 'assistant/message').map(textOf)).toEqual(['[tool]', 'early'])
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('marks a tool the turn ended without a result as incomplete', async () => {
    const h = await harness([{ updates: [{ sessionUpdate: 'tool_call', toolCallId: 't9', title: 'Never ends' }], stopReason: 'end_turn' }])
    try {
      const agent = await run(h, 'go')
      const result = core(agent).find(event => event.type === 'tool/result')
      expect(result).toMatchObject({ data: { error: { code: 'incomplete' }, message: { content: [{ isError: true }] } } })
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('maps the external stop reasons onto the turn ending', async () => {
    for (const [stopReason, reason] of [['max_tokens', { kind: 'max-tokens' }], ['refusal', { kind: 'error' }], ['brand_new', { kind: 'error' }]] as const) {
      const h = await harness([{ updates: [chunk('partial')], stopReason }])
      try {
        const agent = await run(h, 'go')
        expect(core(agent).at(-1)).toMatchObject({ data: { reason: { ...reason, ...reason.kind === 'error' ? { error: { code: 'ACP_TURN' } } : {} } } })
      } finally {
        await h.ctx.fiber.dispose()
        rmSync(h.dir, { recursive: true, force: true })
      }
    }
  })

  it('records an agent process that dies mid-turn as a transport failure and retries on the next turn', async () => {
    const h = await harness([{ updates: [chunk('half')], settle: 100, exit: 1 }, { updates: [chunk('second try')] }])
    try {
      const agent = await run(h, 'one')
      const ending = core(agent).at(-1)
      expect(ending).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'ACP_TURN' } } } })
      expect(ending?.type === 'turn/end' && ending.data.reason.kind === 'error' && ending.data.reason.error.message).toContain('(transport)')
      const interrupted = core(agent).find(event => event.type === 'assistant/message')
      expect(interrupted).toMatchObject({ type: 'assistant/message', data: { interrupted: true } })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
      await waitForIdle(h.ctx, agent)
      const messages = core(agent).filter(event => event.type === 'assistant/message')
      expect(textOf(messages.at(-1))).toBe('second try')
      expect(h.log().filter(entry => entry.method === 'initialize')).toHaveLength(2)
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('ends a user cancellation as an aborted turn after telling the external agent', async () => {
    const h = await harness([{ updates: [chunk('streaming')], hang: true }])
    try {
      const agent = h.ctx.agentLoop.create(SessionId('acp'), {}, { cwd: h.dir })
      const idle = waitForIdle(h.ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await vi_waitFor(() => { expect(core(agent).some(event => event.type === 'assistant/chunk')).toBe(true) })
      agent.cancel({ kind: 'user' })
      await idle
      expect(core(agent).at(-1)).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
      expect(core(agent).find(event => event.type === 'assistant/message')).toMatchObject({ data: { interrupted: true } })
      await vi_waitFor(() => { expect(h.log().some(entry => entry.method === 'session/cancel')).toBe(true) })
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('reports an agent that cannot start, and tries again on the next turn', async () => {
    const h = await harness([], { command: '/nonexistent/acp-agent-binary' })
    try {
      const agent = await run(h, 'one')
      const first = core(agent).at(-1)
      expect(first).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'ACP_TURN' } } } })
      expect(first?.type === 'turn/end' && first.data.reason.kind === 'error' && first.data.reason.error.message).toContain('(spawn)')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
      await waitForIdle(h.ctx, agent)
      expect(core(agent).filter(event => event.type === 'turn/end')).toHaveLength(2)
      expect(core(agent).filter(event => event.type === 'turn/start')).toHaveLength(2)
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('reaps the external process when the agent closes', async () => {
    const h = await harness([{ updates: [chunk('bye')] }])
    try {
      const agent = await run(h, 'go')
      expect(h.eof()).toBe(false)
      await h.ctx.agents.close(agent.id)
      await vi_waitFor(() => { expect(h.eof()).toBe(true) })
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('the working directory', () => {
  it('is the session workspace, and the process runs there', async () => {
    const h = await harness([{ echoCwd: true }])
    try {
      const agent = await run(h, 'where')
      // macOS resolves its temporary directory through a symlink: the child's cwd is the real path.
      expect(textOf(core(agent).find(event => event.type === 'assistant/message'))).toBe(`${realpathSync(h.dir)}|${h.dir}`)
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('falls back to a configured directory, resolved against the launch directory', async () => {
    const h = await harness([{ echoCwd: true }], { cwd: '.' })
    try {
      const agent = await run(h, 'where')
      expect(textOf(core(agent).find(event => event.type === 'assistant/message'))).toBe(`${resolve('.')}|${resolve('.')}`)
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('refuses a session that has no workspace when nothing is configured', async () => {
    const h = await harness([{ echoCwd: true }])
    try {
      const agent = h.ctx.agentLoop.create(SessionId('acp'), {})
      const idle = waitForIdle(h.ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'where' }], source: { kind: 'user' } }))
      await idle
      const ending = core(agent).at(-1)
      expect(ending).toMatchObject({ data: { reason: { kind: 'error', error: { code: 'ACP_NO_CWD' } } } })
      expect(h.log()).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('permission requests', () => {
  const ask = { permission: { title: 'Delete the build', toolCallId: 'c1', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] }, stopReason: 'end_turn' }

  it('decline under ask without an approval answerer, allow under allow', async () => {
    for (const [permission, mounts, expected] of [
      ['ask', {}, { outcome: 'cancelled' }],
      ['reject', {}, { outcome: 'cancelled' }],
      ['allow', {}, { outcome: 'selected', optionId: 'yes' }],
    ] as const) {
      const h = await harness([ask], { permission }, mounts)
      try {
        await run(h, 'do it')
        expect(h.log().find(entry => entry.method === 'permission-decision')?.decision).toEqual({ outcome: expected })
      } finally {
        await h.ctx.fiber.dispose()
        rmSync(h.dir, { recursive: true, force: true })
      }
    }
  })

  it('route through the approval seam, which audits the question on the session', async () => {
    const h = await harness([ask], { permission: 'ask' }, { approval: true })
    try {
      h.ctx.on('approval/request', async ({ toolName }) => toolName === 'Delete the build' ? 'allowed-once' : 'rejected')
      const agent = await run(h, 'do it')
      expect(h.log().find(entry => entry.method === 'permission-decision')?.decision).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
      expect(core(agent).filter(event => event.type === 'approval/asked' || event.type === 'approval/decided').map(event => event.type))
        .toEqual(['approval/asked', 'approval/decided'])
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('the plugin', () => {
  async function load(config: Partial<acp.Config>): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(acp, { command: 'agent', args: [], env: {}, credentialEnv: {}, permission: 'ask', ...config })
    return ctx
  }

  it('rejects a protocol this client cannot request and an empty working directory', async () => {
    await expect(load({ protocol: 3 } as unknown as Partial<acp.Config>)).rejects.toThrow('agent-acp: protocol must be 1 or 2, got 3')
    await expect(load({ cwd: '' })).rejects.toThrow('agent-acp: config cwd must not be empty')
  })

  it('keeps the namespace-plugin export shape (no stray default)', () => {
    expect(acp.name).toBe('agent-acp')
    expect(acp.inject).toEqual(['agents', 'subprocess'])
    expect('default' in acp).toBe(false)
  })

  it('unregisters the driver when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(acp, { command: 'agent', args: [], env: {}, credentialEnv: {}, permission: 'ask' })
    expect(ctx.agents.driverFor(undefined)).toBeInstanceOf(Function)
    await fiber.dispose()
    expect(ctx.agents.driverFor(undefined)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('what the log carries', () => {
  it('drops non-text agent output, passes over plan, notice, usage, and session-info updates, and reads every tool-call shape', async () => {
    const h = await harness([{
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAA', mimeType: 'image/png' } },
        { sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'medium', status: 'pending' }] },
        { sessionUpdate: 'notice', severity: 'info', title: 'Heads up' },
        { sessionUpdate: 'usage_update', used: 1, size: 2 },
        { sessionUpdate: 'session_info_update', title: 'A title' },
        { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Build', kind: 'execute', rawInput: { cmd: 'make' } },
        {
          sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed',
          content: [{ type: 'diff', path: '/a' }, { type: 'content', content: { type: 'image', data: 'AA', mimeType: 'image/png' } }],
        },
        { sessionUpdate: 'tool_call_update', toolCallId: 't7', status: 'completed' },
        chunk('ok'),
      ],
    }])
    try {
      const agent = await run(h, 'go')
      const events = core(agent)
      const message = events.find(event => event.type === 'assistant/message')
      // The trailing speech follows the tool calls, so it opens the next step's message.
      expect(message?.type === 'assistant/message' && message.data.message.content.map(block => block.type)).toEqual(['tool-call', 'tool-call'])
      expect(events.filter(event => event.type === 'assistant/message').map(textOf)).toEqual(['[execute][tool]', 'ok'])
      expect(events.filter(event => event.type === 'tool/call').map(event => event.type === 'tool/call' && [event.data.name, event.data.arguments]))
        .toEqual([['execute', '{"cmd":"make"}'], ['tool', '']])
      // Neither call reported text: the first falls back to its title, the second has none.
      expect(events.filter(event => event.type === 'tool/result').map(event => event.type === 'tool/result' && event.data.message.content[0]?.content))
        .toEqual([[{ type: 'text', text: 'Build' }], [{ type: 'text', text: '' }]])
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('sends a placeholder when the step input carries no text', async () => {
    const h = await harness([{ updates: [chunk('ok')] }, { updates: [chunk('ok again')] }])
    try {
      const agent = await run(h, '   ')
      agent.followup(createUserMessage({ content: [{ type: 'image', attachment: { id: 'a' } as never }], source: { kind: 'user' } }))
      await waitForIdle(h.ctx, agent)
      expect(h.log().filter(entry => entry.method === 'session/prompt').map(entry => entry.params)).toEqual([
        { sessionId: 'external-1', prompt: [{ type: 'text', text: '(no text content)' }] },
        { sessionId: 'external-1', prompt: [{ type: 'text', text: '(no text content)' }] },
      ])
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('forwards what the person wrote and leaves out context a plugin injected', async () => {
    const h = await harness([{ updates: [chunk('ok')] }])
    try {
      const agent = h.ctx.agentLoop.create(SessionId('acp'), {}, { cwd: h.dir })
      // Injected context is claimed into the same step as the person's message.
      agent.inject(createUserMessage({ content: [{ type: 'text', text: 'from a plugin' }], source: { kind: 'plugin', plugin: 'test' } }))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'from a person' }], source: { kind: 'user' } }))
      await waitForIdle(h.ctx, agent)
      expect(h.log().find(entry => entry.method === 'session/prompt')?.params).toMatchObject({
        prompt: [{ type: 'text', text: 'from a person' }],
      })
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('attributes output to the command when the agent reports no name', async () => {
    const h = await harness([{ updates: [chunk('anonymous')] }], {}, {}, { name: null })
    try {
      const agent = await run(h, 'who')
      const message = core(agent).find(event => event.type === 'assistant/message')
      expect(message?.type === 'assistant/message' && message.data.message.source).toEqual({ kind: 'model', provider: 'acp', model: process.execPath })
    } finally {
      await h.ctx.fiber.dispose()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

/** Poll until \`check\` passes. */
async function vi_waitFor(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      check()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  check()
}
