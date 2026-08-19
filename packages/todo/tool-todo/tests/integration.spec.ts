import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop integration: a scripted mock model drives the REAL todo_write tool
 * through the agent loop, exercising the same execution paths a live model would — the
 * tool/call + tool/result session events AND the todo/write event the tool
 * appends. Only the model is mocked; the tool and the session log are real.
 */
async function harness(
  adapter: MockAdapter,
  config: Partial<Pick<ToolTodo.Config, 'autoContinueIncomplete' | 'autoContinueMessage' | 'maxAutoContinueTurns'>> = {},
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, {
    allowParallelInProgress: true,
    ...config,
  })
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

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

describe('todo_write tool through the agent loop', () => {
  it('model calls todo_write: a tool/call, a non-error tool/result, and a todo/write snapshot land', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', {
        todos: [
          { content: 'read the code', status: 'in_progress' },
          { content: 'write the fix', status: 'pending' },
        ],
      }, 'Planning the work.'),
      textResponse('Plan recorded.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-todo'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan a two-step task' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    expect(findEvent(log, 'tool/call').data.name).toBe('todo_write')
    expect(findEvent(log, 'tool/result').data.message.content[0].isError).toBe(false)

    const todoEvent = findEvent(log, 'todo/write')
    expect(todoEvent.data.todos).toEqual([
      { content: 'read the code', status: 'in_progress' },
      { content: 'write the fix', status: 'pending' },
    ])
  })

  it('a second todo_write replaces the list (last-write-wins on the log)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'step one', status: 'in_progress' }] }),
      toolCallResponse('call-2', 'todo_write', {
        todos: [
          { content: 'step one', status: 'completed' },
          { content: 'step two', status: 'in_progress' },
        ],
      }),
      textResponse('Done planning.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-todo-2'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan then update' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const todoEvents = agent.session.events.filter(e => e.type === 'todo/write')
    expect(todoEvents).toHaveLength(2)
    expect(findEvent(agent.session.events, 'todo/write', 'last').data.todos).toEqual([
      { content: 'step one', status: 'completed' },
      { content: 'step two', status: 'in_progress' },
    ])
  })

  it('queues a plugin user message after a stopped turn with incomplete todos', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'finish the task', status: 'in_progress' }] }),
      textResponse('I stopped before finishing.'),
      toolCallResponse('call-2', 'todo_write', { todos: [{ content: 'finish the task', status: 'completed' }] }),
      textResponse('The task is complete.'),
    ])
    const ctx = await harness(adapter, {
      autoContinueIncomplete: true,
      autoContinueMessage: 'Continue the incomplete TODO items.',
    })
    const agent = ctx.agentLoop.create(SessionId('it-todo-continuation'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'finish the task' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const continuationMessages = agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'tool-todo')
    expect(continuationMessages).toHaveLength(1)
    const continuation = continuationMessages[0]
    if (continuation?.type !== 'user/message') throw new Error('missing continuation message')
    expect(continuation.data.content).toEqual([
      { type: 'text', text: 'Continue the incomplete TODO items.' },
    ])
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(agent.session.events.findLast(event => event.type === 'todo/write')?.data.todos).toEqual([
      { content: 'finish the task', status: 'completed' },
    ])
  })

  it('stops automatic continuation at the configured consecutive-turn limit', async () => {
    const adapter = new MockAdapter([
      textResponse('first stop'),
      textResponse('second stop'),
      textResponse('third stop'),
    ])
    const ctx = await harness(adapter, {
      autoContinueIncomplete: true,
      maxAutoContinueTurns: 2,
    })
    const agent = ctx.agentLoop.create(SessionId('it-todo-continuation-limit'), { provider: 'mock', model: 'mock' })
    agent.session.append('todo/write', { todos: [{ content: 'never finished', status: 'pending' }] })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the task' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(3)
    expect(agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'tool-todo')).toHaveLength(2)
  })
})
