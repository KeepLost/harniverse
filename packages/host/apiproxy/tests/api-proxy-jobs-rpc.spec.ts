/**
 * Human follow/stop carrier paths of the host ApiProxy: `jobs.follow` returns
 * the registry ring window (offset passthrough included) without touching the
 * consuming `read` cursor, `jobs.kill` forwards the human stop with
 * `{ reported: false }` so the owner's completion notice still flows, and the
 * session/registry fences answer with their own error codes.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { JobsApi, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '../src/api-proxy.ts'

/**
 * A stream producer whose pending output the test emits and whose settlement
 * the test drives. `readOutput` drains a pending queue, so the ring grows only
 * between follows.
 */
function producer(label = 'tail -f build.log') {
  let settle!: (outcome: JobOutcome) => void
  const pending: string[] = []
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      readOutput: () => pending.splice(0).join(''),
    }),
  }
  return {
    spec,
    emit: (text: string): void => { pending.push(text) },
    settle: (outcome: JobOutcome) => { settle(outcome) },
  }
}

async function harness(withRegistry: boolean): Promise<{ ctx: Context; session: Session; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  if (withRegistry) {
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('api-proxy-jobs-rpc-test')
  }
  // An empty persistence listing keeps unknown ids on the session-not-found
  // branch of the cold-resume fence (attached sessions never read it).
  ctx.provide('sessionPersistence', {
    list: async () => [],
    locate: () => undefined,
  } as never)
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
  } as Agent
  ctx.agents.register(agent)
  return { ctx, session, agent }
}

/** The composed proxy's jobs face; one proxy per context (its question provider registers once). */
function jobsFace(ctx: Context): JobsApi {
  const proxy = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  if (proxy.jobs === undefined) throw new Error('composed proxy did not expose the jobs face')
  return proxy.jobs
}

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`jobs-rpc-${String(nextRpc++)}`), payload }
}

describe('jobs.follow', () => {
  it('returns the ring window from offset 0 and continues from nextOffsetBytes', async () => {
    const { ctx, session, agent } = await harness(true)
    const jobs = jobsFace(ctx)
    const p = producer()
    const jobId = ctx.jobs.start({ ...p.spec, owner: agent })
    p.emit('line-1\n')

    const first = await jobs.follow(request({ sessionId: session.id, jobId }))
    if (!first.result.ok) throw new Error(`follow failed: ${first.result.error.message}`)
    expect(first.result.value).toEqual({
      text: 'line-1\n', nextOffsetBytes: 7, truncated: false, totalBytes: 7, status: 'running',
    })

    p.emit('line-2\n')
    const second = await jobs.follow(request({
      sessionId: session.id, jobId, offsetBytes: first.result.value.nextOffsetBytes,
    }))
    if (!second.result.ok) throw new Error(`follow failed: ${second.result.error.message}`)
    expect(second.result.value).toEqual({
      text: 'line-2\n', nextOffsetBytes: 14, truncated: false, totalBytes: 14, status: 'running',
    })
  })

  it('never calls the consuming read cursor', async () => {
    const { ctx, session, agent } = await harness(true)
    const jobs = jobsFace(ctx)
    const p = producer()
    const jobId = ctx.jobs.start({ ...p.spec, owner: agent })
    p.emit('line-1\n')
    const read = vi.spyOn(ctx.jobs, 'read')

    await jobs.follow(request({ sessionId: session.id, jobId }))
    expect(read).not.toHaveBeenCalled()
  })

  it('answers job-unavailable without the registry and for an unknown job', async () => {
    const { ctx, session, agent } = await harness(true)
    const jobs = jobsFace(ctx)
    const unknown = await jobs.follow(request({ sessionId: session.id, jobId: JobId('bash-404') }))
    expect(unknown.result).toEqual({
      ok: false,
      error: { code: 'job-unavailable', message: expect.any(String), details: {} }, // oxlint-disable-line typescript/no-unsafe-assignment
    })

    const bare = await harness(false)
    const absent = await jobsFace(bare.ctx).follow(request({ sessionId: bare.session.id, jobId: JobId('bash-1') }))
    expect(absent.result.ok).toBe(false)
    if (!absent.result.ok) expect(absent.result.error.code).toBe('job-unavailable')
    void agent
  })

  it('answers session-not-found for an unknown session', async () => {
    const { ctx } = await harness(true)
    const result = await jobsFace(ctx).follow(request({
      sessionId: SessionId('session-none'), jobId: JobId('bash-1'),
    }))
    expect(result.result).toEqual({
      ok: false,
      error: { code: 'session-not-found', message: expect.any(String), details: { sessionId: 'session-none' } }, // oxlint-disable-line typescript/no-unsafe-assignment
    })
  })
})

describe('jobs.kill', () => {
  it('forwards the human stop without claiming the terminal report', async () => {
    const { ctx, session, agent } = await harness(true)
    const jobs = jobsFace(ctx)
    const p = producer()
    const jobId = ctx.jobs.start({ ...p.spec, owner: agent })
    const kill = vi.spyOn(ctx.jobs, 'kill')

    const result = await jobs.kill(request({ sessionId: session.id, jobId }))
    expect(result.result).toEqual({ ok: true, value: { result: 'requested' } })
    expect(kill).toHaveBeenCalledExactlyOnceWith(jobId, agent, { reported: false })
  })

  it('reports already-finished for a settled job', async () => {
    const { ctx, session, agent } = await harness(true)
    const jobs = jobsFace(ctx)
    const p = producer()
    const jobId = ctx.jobs.start({ ...p.spec, owner: agent })
    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })

    const result = await jobs.kill(request({ sessionId: session.id, jobId }))
    expect(result.result).toEqual({ ok: true, value: { result: 'already-finished' } })
  })

  it('answers job-unavailable without the registry and session-not-found for an unknown session', async () => {
    const { ctx, session } = await harness(false)
    const absent = await jobsFace(ctx).kill(request({ sessionId: session.id, jobId: JobId('bash-1') }))
    expect(absent.result.ok).toBe(false)
    if (!absent.result.ok) expect(absent.result.error.code).toBe('job-unavailable')

    const composed = await harness(true)
    const unknown = await jobsFace(composed.ctx).kill(request({
      sessionId: SessionId('session-none'), jobId: JobId('bash-1'),
    }))
    expect(unknown.result).toEqual({
      ok: false,
      error: { code: 'session-not-found', message: expect.any(String), details: { sessionId: 'session-none' } }, // oxlint-disable-line typescript/no-unsafe-assignment
    })
  })
})
