import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as ContextSnapshot from '@deepseek-ai/dsh-context-snapshot'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const SOURCE = '@deepseek-ai/dsh-context-snapshot'
const COMPLETE = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const PARTIAL = 'Current runtime context has some updates.'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** Mount the loop's prerequisites without the plugin under test. */
async function harness(adapter: MockAdapter, persona = ''): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Wait for the agent's next transition to idle after a waking send. */
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

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Owned durable user/message events, in log order. */
function ownedEvents(agent: Agent) {
  return agent.session.events.flatMap(event =>
    event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === SOURCE
      ? [event]
      : [])
}

/** Owned message texts, for compact framing assertions. */
function ownedTexts(agent: Agent): string[] {
  return ownedEvents(agent).flatMap(event =>
    event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

/** Simulate a compaction replacement shadowing one event seq. */
function shadow(agent: Agent, seq: number): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'compacted summary' }],
    source: { kind: 'plugin', plugin: 'test-compaction' },
  }), {
    surfaceOp: { op: 'replace', start: seq, end: seq },
    sourceEventSeqs: [seq],
  })
}

/** Append a completed manual-compaction bracket marker. */
function compactionEnd(agent: Agent): void {
  agent.session.append('compaction/end', { compactionId: CompactionId('test-compaction'), turn: null })
}

describe('context-snapshot', () => {
  it('materializes changed runtime context at the history tail without rewriting the system header', async () => {
    const adapter = new MockAdapter([
      textResponse('one'),
      textResponse('two'),
      textResponse('three'),
      textResponse('four'),
      textResponse('five'),
    ])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    let mode = 'read-only'
    const dispose = ctx.systemPrompt.context({ name: 'policy', order: 0, text: () => `Mode: ${mode}.` })
    const agent = ctx.agentLoop.create(SessionId('a-runtime-context'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(ownedTexts(agent)).toEqual([`${COMPLETE}\n\nMode: read-only.`])

    send(agent, 'unchanged')
    await waitForIdle(ctx, agent)
    expect(ownedEvents(agent)).toHaveLength(1)

    mode = 'danger-full-access'
    send(agent, 'changed')
    await waitForIdle(ctx, agent)
    expect(ownedTexts(agent)).toEqual([
      `${COMPLETE}\n\nMode: read-only.`,
      `${PARTIAL}\n\nMode: danger-full-access.`,
    ])
    expect(ownedEvents(agent)[1]?.data.source).toEqual({
      kind: 'plugin',
      plugin: SOURCE,
      form: 'snapshot',
      partial: true,
      sections: [{ name: 'policy', text: 'Mode: danger-full-access.' }],
    })

    dispose()
    send(agent, 'cleared')
    await waitForIdle(ctx, agent)
    expect(ownedTexts(agent)[2]).toBe(CLEARED)
    expect(ownedEvents(agent)[2]?.data.source).toEqual({ kind: 'plugin', plugin: SOURCE })

    send(agent, 'still clear')
    await waitForIdle(ctx, agent)
    expect(ownedEvents(agent)).toHaveLength(3)
    expect(adapter.requests.map(request => request.system)).toEqual(Array(5).fill(adapter.requests[0]?.system))
    expect(agent.session.events.filter(event => event.type === 'request/header')).toHaveLength(1)
  })

  it('emits a complete snapshot when the section name set changes', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const agent = ctx.agentLoop.create(SessionId('a-name-set'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(ownedTexts(agent)).toEqual([`${COMPLETE}\n\nMode: read-only.`])

    ctx.systemPrompt.context({ name: 'extra', order: 1, text: 'Extra: yes.' })
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(ownedTexts(agent)).toEqual([
      `${COMPLETE}\n\nMode: read-only.`,
      `${COMPLETE}\n\nMode: read-only.\n\nExtra: yes.`,
    ])
    expect(ownedEvents(agent)[1]?.data.source).toMatchObject({
      form: 'snapshot',
      sections: [
        { name: 'policy', text: 'Mode: read-only.' },
        { name: 'extra', text: 'Extra: yes.' },
      ],
    })
  })

  it('prepends the first complete snapshot before the user message', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter, 'You are a test agent on {{model}}.')
    await ctx.plugin(ContextSnapshot)
    const agent = ctx.agentLoop.create(SessionId('a-first-snapshot'), { provider: 'mock', model: 'mock' })

    send(agent, 'first user request')
    await waitForIdle(ctx, agent)

    expect(ownedTexts(agent)).toEqual([`${COMPLETE}\n\nYou are a test agent on mock.`])
    const messages = adapter.requests[0]!.messages
    expect(messages[0]).toMatchObject({ source: { kind: 'plugin', plugin: SOURCE } })
    expect(messages[1]).toMatchObject({ source: { kind: 'user' } })
  })

  it('recovers a fresh complete snapshot inside the request boundary after compaction removed the retained one', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    // Simulate request-boundary compaction: the replacement commits before the
    // config chain continues, shadowing the snapshot the step just published.
    let compacted = false
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      if (!compacted && turn === 1 && step === 1) {
        const published = ownedEvents(agent)[0]
        if (published !== undefined) {
          compacted = true
          shadow(agent, published.seq)
        }
      }
      return next()
    })
    await ctx.plugin(ContextSnapshot)
    const agent = ctx.agentLoop.create(SessionId('a-request-recovery'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    expect(compacted).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    const messages = adapter.requests[0]!.messages
    expect(messages[0]).toMatchObject({ source: { kind: 'plugin', plugin: 'test-compaction' } })
    expect(messages.at(-1)?.source).toEqual({
      kind: 'plugin',
      plugin: SOURCE,
      form: 'snapshot',
      sections: [{ name: 'policy', text: 'Mode: read-only.' }],
    })
    expect((messages.at(-1)?.content[0] as { text?: string }).text).toBe(`${COMPLETE}\n\nMode: read-only.`)
    // The shadowed step publication stays durable; the recovery is the retained one.
    expect(ownedEvents(agent)).toHaveLength(2)
    expect(agent.session.surface.nodes).toContain(ownedEvents(agent)[1]!.seq)
    expect(agent.session.surface.nodes).not.toContain(ownedEvents(agent)[0]!.seq)
  })

  it('recovers a durable complete snapshot on the retry after request-error compaction', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }),
      () => [{
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'snapshot request exceeded the model context window', code: 'CONTEXT_WINDOW_EXCEEDED' } },
      }],
      textResponse('recovered'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo back',
      parameters: { text: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: `echo: ${args.text}` }]
      },
    }))
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    // Simulate overflow-retry compaction: the recovery listener owns the retry
    // and shadows the retained snapshot before the loop rebuilds its request.
    let compacted = false
    ctx.on('agent/request-error', async ({ agent }) => {
      if (compacted) return undefined
      const published = ownedEvents(agent)[0]
      if (published === undefined) return undefined
      compacted = true
      shadow(agent, published.seq)
      return { kind: 'retry' }
    })
    await ctx.plugin(ContextSnapshot)
    const agent = ctx.agentLoop.create(SessionId('a-request-error-recovery'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    expect(compacted).toBe(true)
    expect(adapter.requests).toHaveLength(3)
    // The retried request must carry the recovered snapshot: an append during
    // its own agent/request chain has to reach the frozen message list.
    const retryMessages = adapter.requests[2]!.messages
    expect(retryMessages.some(message =>
      message.source.kind === 'plugin' && message.source.plugin === SOURCE)).toBe(true)
    expect(ownedTexts(agent)).toEqual([
      `${COMPLETE}\n\nMode: read-only.`,
      `${COMPLETE}\n\nMode: read-only.`,
    ])
    expect(agent.session.surface.nodes).toContain(ownedEvents(agent)[1]!.seq)
  })

  it('recovers a durable complete snapshot after manual compaction while idle', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const agent = ctx.agentLoop.create(SessionId('a-manual-recovery'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    shadow(agent, ownedEvents(agent)[0]!.seq)
    compactionEnd(agent)
    await vi.waitFor(() => { expect(ownedEvents(agent)).toHaveLength(2) })

    expect(ownedTexts(agent)[1]).toBe(`${COMPLETE}\n\nMode: read-only.`)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
  })

  it('skips compaction-end recovery while a turn is running', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const agent = ctx.agentLoop.create(SessionId('a-running-skip'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(agent.status).toBe('running')
    shadow(agent, ownedEvents(agent)[0]!.seq)
    compactionEnd(agent)
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(ownedEvents(agent)).toHaveLength(1)
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)
    expect(ownedEvents(agent)).toHaveLength(1)
  })

  it('skips compaction-end recovery for a failed compaction or an unknown session', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const agent = ctx.agentLoop.create(SessionId('a-failed-compaction'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    shadow(agent, ownedEvents(agent)[0]!.seq)
    agent.session.append('compaction/end', {
      compactionId: CompactionId('test-compaction'),
      turn: null,
      error: 'summarizer failed',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ownedEvents(agent)).toHaveLength(1)

    const bare = ctx.sessions.create(SessionId('a-no-agent'))
    expect(() => {
      bare.append('compaction/end', { compactionId: CompactionId('test-compaction'), turn: null })
    }).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ownedEvents(agent)).toHaveLength(1)
  })

  it('contains a request-boundary recovery failure without breaking the request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    let failAssembly = false
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      if (turn === 1 && step === 1 && ownedEvents(agent)[0] !== undefined) {
        shadow(agent, ownedEvents(agent)[0]!.seq)
        failAssembly = true
      }
      return next()
    })
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      if (failAssembly) throw new Error('assembly unavailable')
      return next()
    })
    await ctx.plugin(ContextSnapshot)
    const agent = ctx.agentLoop.create(SessionId('a-request-failure'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(ownedEvents(agent)).toHaveLength(1)
  })

  it('contains a manual-compaction recovery failure', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const agent = ctx.agentLoop.create(SessionId('a-manual-failure'), { provider: 'mock', model: 'mock' })
    const warnings: string[] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((message) => {
      warnings.push(String(message))
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    let failAssembly = false
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      if (failAssembly) throw new Error('assembly unavailable')
      return next()
    })
    failAssembly = true
    shadow(agent, ownedEvents(agent)[0]!.seq)
    compactionEnd(agent)
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('context-snapshot: manual-compaction recovery failed'))).toBe(true)
    })

    expect(ownedEvents(agent)).toHaveLength(1)
    warn.mockRestore()
  })

  it('contains an unrelated compaction replacement without republishing', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    const agent = ctx.agentLoop.create(SessionId('a-unrelated-compaction'), { provider: 'mock', model: 'mock' })
    const original = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old context' }],
      source: { kind: 'plugin', plugin: 'test-context' },
    }), { surfaceOp: 'append' })
    shadow(agent, original.seq)
    compactionEnd(agent)
    await new Promise(resolve => setTimeout(resolve, 10))

    send(agent, 'after compaction')
    await waitForIdle(ctx, agent)
    expect(ownedEvents(agent)).toEqual([])
    expect(adapter.requests[0]?.messages.some(message =>
      message.source.kind === 'plugin' && message.source.plugin === SOURCE)).toBe(false)
  })

  it('never publishes when no context ever contributes', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    const agent = ctx.agentLoop.create(SessionId('a-no-contexts'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(ownedEvents(agent)).toEqual([])
  })

  it('clears once after runtime context is suppressed, then stays quiet', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const agent = ctx.agentLoop.create(SessionId('a-suppressed'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(ownedTexts(agent)).toEqual([`${COMPLETE}\n\nMode: read-only.`])

    ctx.systemPrompt.suppressRuntimeContext()
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(ownedTexts(agent)).toEqual([`${COMPLETE}\n\nMode: read-only.`, CLEARED])

    send(agent, 'third')
    await waitForIdle(ctx, agent)
    expect(ownedEvents(agent)).toHaveLength(2)
  })

  it('replaces malformed owned records with the current complete snapshot', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    const agent = ctx.agentLoop.create(SessionId('a-malformed'), { provider: 'mock', model: 'mock' })
    const seed = (content: never, source: never): void => {
      agent.session.append('user/message', createUserMessage({ content, source }), { surfaceOp: 'append' })
    }
    seed(
      [{ type: 'text', text: 'broken' }, { type: 'text', text: 'snapshot' }] as never,
      { kind: 'plugin', plugin: SOURCE } as never,
    )
    seed(
      [{ type: 'image', data: 'x', mimeType: 'image/png' }] as never,
      { kind: 'plugin', plugin: SOURCE } as never,
    )
    seed(
      [{ type: 'text', text: 'a notice' }] as never,
      { kind: 'plugin', plugin: SOURCE, form: 'notice', summary: 'notice' } as never,
    )
    seed(
      [{ type: 'text', text: 'unreadable' }] as never,
      { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: 'not-a-list' } as never,
    )
    seed(
      [{ type: 'text', text: 'null entry' }] as never,
      { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: [null] } as never,
    )
    seed(
      [{ type: 'text', text: 'empty name' }] as never,
      { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: [{ name: '', text: 'x' }] } as never,
    )

    send(agent, 'repair context')
    await waitForIdle(ctx, agent)

    expect(ownedEvents(agent)).toHaveLength(7)
    const replacement = ownedEvents(agent)[6]!
    expect(replacement.data.content).toEqual([{
      type: 'text',
      text: `${COMPLETE}\n\nMode: read-only.`,
    }])
    expect(replacement.data.source).toEqual({
      kind: 'plugin',
      plugin: SOURCE,
      form: 'snapshot',
      sections: [{ name: 'policy', text: 'Mode: read-only.' }],
    })
  })

  it('fails the turn on a strict-variable render failure and keeps serving turns', async () => {
    // A missing cwd variable must fail one turn without preventing a later valid turn.
    const adapter = new MockAdapter([textResponse('ok after rescue')])
    const ctx = await harness(adapter, 'In {{cwd}}.')
    await ctx.plugin(ContextSnapshot)
    const errors: Error[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errors.push(error)
    })
    const agent = ctx.agentLoop.create(SessionId('a-strict-variable'), { provider: 'mock', model: 'mock' })

    send(agent, 'hi')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(0) // the request was never sent
    expect(errors.map(error => error.message)).toEqual([
      'prompt variable "{{cwd}}" has no value for this assembly (context "deployment:persona")',
    ])
    const turnEnd = agent.session.events.find(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind).toBe('error')

    // The loop survived: a waterfall listener rescues {{cwd}} and the SAME
    // agent completes a real model turn.
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      assembly.variables['cwd'] = '/rescued'
      return next()
    })
    send(agent, 'again')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(ownedTexts(agent)).toEqual([`${COMPLETE}\n\nIn /rescued.`])
    const turnEnds = agent.session.events.filter(e => e.type === 'turn/end')
    expect(turnEnds).toHaveLength(2)
    expect(turnEnds[1]?.type === 'turn/end' && turnEnds[1].data.reason.kind).toBe('completed')
  })

  it('returns a rejected step decision without publishing', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    await ctx.plugin(ContextSnapshot)
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'Mode: read-only.' })
    // Registered after the plugin, so the rejection reaches the plugin's listener.
    ctx.on('agent/pre-step', async (_payload, next) => {
      await next()
      return { kind: 'reject' }
    })
    const agent = ctx.agentLoop.create(SessionId('a-rejected-step'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(0)
    expect(ownedEvents(agent)).toEqual([])
    const turnEnd = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind).toBe('blocked')
  })

  it('stops emitting after the plugin fiber is disposed', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const fiber = await ctx.plugin(ContextSnapshot)
    let mode = 'read-only'
    ctx.systemPrompt.context({ name: 'policy', order: 0, text: () => `Mode: ${mode}.` })
    const agent = ctx.agentLoop.create(SessionId('a-disposed'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(ownedEvents(agent)).toHaveLength(1)

    await fiber.dispose()
    mode = 'danger-full-access'
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(ownedEvents(agent)).toHaveLength(1)
    expect(adapter.requests[1]!.messages.some(message =>
      message.source.kind === 'plugin' && message.source.plugin === SOURCE
      && message.content.some(block => block.type === 'text' && block.text.includes('danger-full-access'))))
      .toBe(false)
  })
})
