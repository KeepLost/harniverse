import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Automatic-continuation edges: config defaults through a direct (schema-bypass)
 * apply, the identical-rewrite no-op, foreign-session isolation, the cap's
 * warn-once behavior, and a queued next-turn message or failing followup.
 */

const DEFAULT_MESSAGE = 'This is an automatic system-injected continuation, not a user request. Continue working on incomplete TODO items. If all TODO items are complete, mark every item `completed` before stopping.'

async function harness(
  adapter: MockAdapter,
  config: Partial<Pick<ToolTodo.Config, 'autoContinueIncomplete' | 'autoContinueMessage' | 'maxAutoContinueTurns'>> = {},
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true, ...config })
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

function continuations(agent: Agent) {
  return agent.session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'tool-todo'
    && event.data.source.form === 'system-injection')
}

/** A registered stand-in agent carrying a real Session and a controllable inbox. */
function fakeAgent(session: Session, nextTurn: unknown[], followup: () => void = () => {}): Agent {
  const agent = {
    id: session.id,
    session,
    inbox: { nextTurn },
    followup,
  } as unknown as Agent
  return agent
}

function emitTodoWrite(ctx: Context, session: Session, todos: TodoItem[]): void {
  const event = session.append('todo/write', { todos })
  ctx.emit('session/event', session, event)
}

function emitTurnStopping(ctx: Context, agent: Agent): void {
  ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
}

describe('tool-todo automatic continuation edges', () => {
  it('apply() defaults autoContinueIncomplete to false and registers no continuation listeners', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    ToolTodo.apply(ctx, { allowParallelInProgress: true })

    const session = Session.create(SessionId('direct-apply-defaults'))
    const followup = vi.fn()
    const agent = fakeAgent(session, [], followup)
    ctx.agents.register(agent)
    emitTodoWrite(ctx, session, [{ content: 'a', status: 'pending' }])
    emitTurnStopping(ctx, agent)

    expect(followup).not.toHaveBeenCalled()
  })

  it('apply() defaults the continuation message and turn cap (schema bypass)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'task', status: 'in_progress' }] }),
      textResponse('stopped midway'),
      toolCallResponse('call-2', 'todo_write', { todos: [{ content: 'task', status: 'completed' }] }),
      textResponse('all done'),
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ToolTodo.apply(ctx, { allowParallelInProgress: true, autoContinueIncomplete: true })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('direct-apply-default-message'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const queued = continuations(agent)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.type === 'user/message' && queued[0].data.content).toEqual([
      { type: 'text', text: DEFAULT_MESSAGE },
    ])
  })

  it('an identical rewrite is a no-op and keeps the consecutive counter', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'task', status: 'in_progress' }] }),
      textResponse('first stop'),
      toolCallResponse('call-2', 'todo_write', { todos: [{ content: 'task', status: 'in_progress' }] }),
      textResponse('second stop'),
      toolCallResponse('call-3', 'todo_write', { todos: [{ content: 'task', status: 'completed' }] }),
      textResponse('finished'),
    ])
    const ctx = await harness(adapter, { autoContinueIncomplete: true, maxAutoContinueTurns: 3 })
    const agent = ctx.agentLoop.create(SessionId('identical-rewrite'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(continuations(agent)).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(3)
  })

  it('ignores session events from foreign sessions', async () => {
    const adapter = new MockAdapter([textResponse('stopped')])
    const ctx = await harness(adapter, { autoContinueIncomplete: true, maxAutoContinueTurns: 1 })
    const agent = ctx.agentLoop.create(SessionId('own-session'), { provider: 'mock', model: 'mock' })

    const unknown = Session.create(SessionId('never-registered'))
    const unknownEvent = unknown.append('todo/write', { todos: [{ content: 'foreign', status: 'in_progress' }] })
    ctx.emit('session/event', unknown, unknownEvent)

    const twin = Session.create(agent.session.id)
    const twinEvent = twin.append('todo/write', { todos: [{ content: 'foreign', status: 'in_progress' }] })
    ctx.emit('session/event', twin, twinEvent)

    agent.session.append('todo/write', { todos: [{ content: 'own', status: 'in_progress' }] })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests[0]!.messages.map(message => JSON.stringify(message.content)).join('')).not.toContain('foreign')
    const queued = continuations(agent)
    expect(queued).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'todo/write'
      && event.data.todos.some(todo => todo.content === 'foreign'))).toBe(false)
  })

  it('leaves a session without any todo history untouched at turn-stopping', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter, { autoContinueIncomplete: true })
    const agent = ctx.agentLoop.create(SessionId('todo-less'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(continuations(agent)).toHaveLength(0)
  })

  it('a queued next-turn message wins over an injected continuation', async () => {
    const ctx = await harness(new MockAdapter([]), { autoContinueIncomplete: true })
    const session = Session.create(SessionId('queued-next-turn'))
    const followup = vi.fn()
    const nextTurn: unknown[] = []
    const agent = fakeAgent(session, nextTurn, followup)
    ctx.agents.register(agent)
    emitTodoWrite(ctx, session, [{ content: 'unfinished', status: 'in_progress' }])

    nextTurn.push(createUserMessage({ content: [{ type: 'text', text: 'already waiting' }], source: { kind: 'user' } }))
    emitTurnStopping(ctx, agent)
    expect(followup).not.toHaveBeenCalled()

    nextTurn.splice(0, nextTurn.length)
    emitTurnStopping(ctx, agent)
    expect(followup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      content: [{ type: 'text', text: DEFAULT_MESSAGE }],
    }))
  })

  it('warns once while the cap keeps blocking later stops', async () => {
    const ctx = await harness(new MockAdapter([]), { autoContinueIncomplete: true, maxAutoContinueTurns: 1 })
    const session = Session.create(SessionId('cap-warn-once'))
    const followup = vi.fn()
    const agent = fakeAgent(session, [], followup)
    ctx.agents.register(agent)
    emitTodoWrite(ctx, session, [{ content: 'never finished', status: 'pending' }])
    const warn = vi.fn()
    ctx.logger.warn = warn as never

    emitTurnStopping(ctx, agent)
    expect(followup).toHaveBeenCalledTimes(1)

    emitTurnStopping(ctx, agent)
    emitTurnStopping(ctx, agent)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'tool-todo: stopped automatic continuation after 1 consecutive turns for agent "cap-warn-once"',
    )
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('contains a failing followup: the counter rolls back and the next stop retries', async () => {
    const ctx = await harness(new MockAdapter([]), { autoContinueIncomplete: true })
    const session = Session.create(SessionId('failing-followup'))
    const failing = vi.fn(() => { throw new Error('inbox closed') })
    const agent = fakeAgent(session, [], failing)
    ctx.agents.register(agent)
    emitTodoWrite(ctx, session, [{ content: 'unfinished', status: 'pending' }])
    const warn = vi.fn()
    ctx.logger.warn = warn as never

    emitTurnStopping(ctx, agent)
    expect(failing).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'tool-todo: could not queue automatic continuation for agent "failing-followup": Error: inbox closed',
    )

    const working = vi.fn()
    agent.followup = working
    emitTurnStopping(ctx, agent)
    expect(working).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      content: [{ type: 'text', text: DEFAULT_MESSAGE }],
    }))
  })
})
