import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const request = <T>(payload: T) => ({ rpcId: RpcId('status-test'), payload })

function valueOf<T>(response: { result: { ok: true; value: T } | { ok: false } }): T {
  if (!response.result.ok) throw new Error('expected successful response')
  return response.result.value
}

async function harness(): Promise<{ ctx: Context; session: Session; agent: Agent; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('status-test')
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx,
  } as Agent
  ctx.agents.register(agent)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
  return { ctx, session, agent, api }
}

describe('session.status', () => {
  it('discovers the canonical API registry and exposes prompt operations', async () => {
    const { ctx, session, agent, api } = await harness()
    Object.assign(agent, { followup: vi.fn() })
    const described = valueOf(await api.api!.describe(request({})))
    expect(described.version).toBe(1)
    expect(described.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'goal.edit', stability: 'stable' }),
      expect.objectContaining({ method: 'settings.update', stability: 'deprecated', replacement: 'settings.mutate' }),
      expect.objectContaining({ method: 'operation.get', effect: 'read' }),
    ]))

    const accepted = valueOf(await api.sessions.prompt(request({
      sessionId: session.id,
      mode: 'queue',
      content: [{ type: 'text', text: 'operation test' }],
    })))
    expect(accepted.operationId).toMatch(/^operation:/)
    const operation = valueOf(await api.operations!.get(request({ operationId: accepted.operationId, sessionId: session.id })))
    expect(operation).toMatchObject({
      operationId: accepted.operationId,
      kind: 'session.prompt',
      status: 'accepted',
      sessionId: session.id,
      messageId: accepted.messageId,
    })
    await ctx.fiber.dispose()
  })

  it('returns the post-mutation delivery state when steering one queued message', async () => {
    const { ctx, session, agent, api } = await harness()
    const message = createUserMessage({ content: [{ type: 'text', text: 'steer me' }], source: { kind: 'user' } })
    agent.inbox.append('next-turn', message)
    Object.assign(agent, {
      steer: vi.fn((input: typeof message) => { agent.inbox.append('next-step', input) }),
    })

    const updated = valueOf(await api.sessions.updateQueue(request({
      sessionId: session.id,
      itemId: message.id,
      action: { kind: 'steer' },
    })))
    expect(updated).toEqual({
      accepted: true,
      messageId: message.id,
      status: { state: 'queued', delivery: 'steer' },
    })
    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.inbox.nextStep).toEqual([message])
    await ctx.fiber.dispose()
  })

  it('returns one boot-fenced snapshot of durable and process-local state', async () => {
    const { ctx, session, agent, api } = await harness()
    const message = createUserMessage({
      content: [{ type: 'text', text: 'queued work' }],
      source: { kind: 'user' },
    })
    agent.inbox.append('next-turn', message)

    let settleJob!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'pnpm test',
      owner: agent,
      run: () => ({
        cancel: () => {},
        done: new Promise<JobOutcome>((resolve) => { settleJob = resolve }),
        readOutput: () => '',
      }),
    })

    const questionAbort = new AbortController()
    const asked = ctx.userQuestions.ask({
      agent,
      signal: questionAbort.signal,
      questions: [{ id: 'target', question: 'Choose a target', options: [{ label: 'Code' }] }],
    })
    await Promise.resolve()

    const described = valueOf(await api.host.describe(request({})))
    const status = valueOf(await api.sessions.status(request({ sessionId: session.id })))
    expect(status).toMatchObject({
      sessionId: session.id,
      bootId: described.bootId,
      attached: true,
      running: true,
      closing: false,
      lastSeq: 0,
      queue: [{ id: message.id, placement: 'queued' }],
      jobs: [{ kind: 'bash', label: 'pnpm test', status: 'running' }],
      interactions: [{ payload: { type: 'question/requested', sessionId: session.id } }],
    })
    const job = status.jobs[0]
    expect(job?.operationId).toBe('job:bash-1')
    const jobOperation = valueOf(await api.operations!.get(request({
      operationId: job?.operationId ?? '', sessionId: session.id,
    })))
    expect(jobOperation).toMatchObject({
      operationId: 'job:bash-1', kind: 'job', status: 'running', sessionId: session.id, jobId: 'bash-1',
    })
    expect(valueOf(await api.host.describe(request({}))).bootId).toBe(described.bootId)

    questionAbort.abort()
    await expect(asked).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    settleJob({ status: 'completed' })
    const nextBoot = await harness()
    expect(valueOf(await nextBoot.api.host.describe(request({}))).bootId).not.toBe(described.bootId)
    await nextBoot.ctx.fiber.dispose()
    await ctx.fiber.dispose()
  })
})
