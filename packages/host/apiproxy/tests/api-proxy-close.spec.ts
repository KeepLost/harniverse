import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('close-request'), payload }
}

function drainMock() {
  return vi.fn((_agents: readonly Agent[]) => Promise.resolve())
}

async function harness(): Promise<{
  ctx: Context
  drain: ReturnType<typeof drainMock>
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserQuestionService)
  const drain = drainMock()
  ctx.provide('subagents', { drainContinuableDescendants: drain } as never)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  return { ctx, drain }
}

const defaults = {
  defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
  cwd: '/tmp',
}

describe('session.close', () => {
  it('drains descendants, reaches quiescence, and reports detach without durable removal', async () => {
    const { ctx, drain } = await harness()
    const lifecycle: string[] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.on('session/disposed', () => { lifecycle.push('detached') })
    ctx.on('session/closed', () => { throw new Error('observer failed') })
    ctx.on('session/closed', () => { lifecycle.push('closed') })
    const sessionId = SessionId('close-me')
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    const api = createApiProxy(ctx, defaults)
    const controller = new AbortController()
    const host = api.events.host(request({}), controller.signal)[Symbol.asyncIterator]()
    const nextFrame = host.next()

    const response = await api.sessions.close(request({ sessionId }))

    expect(response.result).toEqual({ ok: true, value: { closed: true } })
    expect(drain).toHaveBeenCalledWith([handle.agent])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(lifecycle).toEqual(['detached', 'closed'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session/closed listener threw'))
    await expect(nextFrame).resolves.toMatchObject({
      value: { payload: { type: 'host/session-status', sessionId, running: false } },
    })
    controller.abort()
    await host.return?.()
    await ctx.fiber.dispose()
  })

  it('joins concurrent closes and rejects missing or session-backed subagent identities', async () => {
    const { ctx, drain } = await harness()
    const closed = vi.fn()
    ctx.on('session/closed', closed)
    const api = createApiProxy(ctx, defaults)
    const ordinaryId = SessionId('close-twice')
    await ctx.agents.create({ sessionId: ordinaryId, agentOptions: { provider: 'mock', model: 'mock' } })

    const [first, second] = await Promise.all([
      api.sessions.close(request({ sessionId: ordinaryId })),
      api.sessions.close(request({ sessionId: ordinaryId })),
    ])
    expect(first.result).toEqual({ ok: true, value: { closed: true } })
    expect(second.result).toEqual({ ok: true, value: { closed: true } })
    expect(drain).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledWith({ sessionId: ordinaryId })

    const missing = await api.sessions.close(request({ sessionId: SessionId('missing') }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(closed).toHaveBeenCalledOnce()

    const childId = SessionId('session-backed-child')
    await ctx.agents.create({
      sessionId: childId,
      meta: { parentSession: SessionId('parent'), origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const refused = await api.sessions.close(request({ sessionId: childId }))
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'agent-busy' } })
    expect(ctx.agents.get(childId)).toBeDefined()
    expect(closed).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('reports the admission fence while close is draining descendants', async () => {
    const { ctx, drain } = await harness()
    const gate = Promise.withResolvers<undefined>()
    drain.mockImplementation(() => gate.promise)
    const sessionId = SessionId('closing-status')
    await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    const api = createApiProxy(ctx, defaults)

    const closing = api.sessions.close(request({ sessionId }))
    await vi.waitFor(() => { expect(drain).toHaveBeenCalledOnce() })
    const status = await api.sessions.status(request({ sessionId }))
    expect(status.result).toMatchObject({
      ok: true,
      value: { sessionId, attached: true, closing: true },
    })

    gate.resolve(undefined)
    await expect(closing).resolves.toMatchObject({ result: { ok: true } })
    await ctx.fiber.dispose()
  })
})
