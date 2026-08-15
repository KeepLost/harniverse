import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('delete-request'), payload }
}

const targetId = SessionId('delete-me')
const target: SessionHeader = { version: 0, id: targetId, createdAt: 1, cwd: '/tmp' }

async function harness(records = [{ header: target, live: false, persisted: true }]) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserQuestionService)
  ctx.provide('subagents', { drainContinuableDescendants: vi.fn(() => Promise.resolve()) } as never)
  const removeSessionReferences = vi.fn(() => Promise.resolve())
  const pendingSessionDeletionIds = new Set<SessionId>()
  const beginSessionDeletion = vi.fn(async (id: SessionId) => { pendingSessionDeletionIds.add(id) })
  const completeSessionDeletion = vi.fn(async (id: SessionId) => { pendingSessionDeletionIds.delete(id) })
  ctx.provide('workspaceRegistry', {
    list: () => [],
    archivedSessionIds: [],
    get pendingSessionDeletionIds() { return [...pendingSessionDeletionIds] },
    beginSessionDeletion,
    completeSessionDeletion,
    removeSessionReferences,
  } as never)
  const deleteStored = vi.fn(async () => {
    const record = records.find(candidate => candidate.header.id === targetId && candidate.persisted)
    if (record === undefined) return false
    record.persisted = false
    return true
  })
  ctx.provide('sessionPersistence', {
    list: vi.fn(() => Promise.resolve(records.filter(record => record.persisted).map(record => record.header))),
    delete: deleteStored,
  } as never)
  ctx.provide('sessionQuery', { listSessions: vi.fn(() => Promise.resolve(records)) } as never)
  const deleteCheckpoint = vi.fn(() => Promise.resolve())
  ctx.provide('sessionProjectionCache', { delete: deleteCheckpoint } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: '/tmp',
  })
  return { ctx, api, removeSessionReferences, deleteStored, deleteCheckpoint }
}

describe('session.delete', () => {
  it('cleans derived references, deletes the cold log, and publishes durable removal', async () => {
    const { ctx, api, removeSessionReferences, deleteStored, deleteCheckpoint } = await harness()
    const controller = new AbortController()
    const host = api.events.host(request({}), controller.signal)[Symbol.asyncIterator]()
    const nextFrame = host.next()

    const response = await api.sessions.delete(request({ sessionId: targetId }))

    expect(response.result).toEqual({
      ok: true,
      value: { deleted: true, attachmentsRetained: true },
    })
    expect(deleteCheckpoint).toHaveBeenCalledWith(target)
    expect(removeSessionReferences).toHaveBeenCalledWith(targetId)
    expect(deleteStored).toHaveBeenCalledWith(targetId)
    expect(deleteCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(deleteStored.mock.invocationCallOrder[0]!)
    expect(deleteStored.mock.invocationCallOrder[0]).toBeLessThan(removeSessionReferences.mock.invocationCallOrder[0]!)
    await expect(nextFrame).resolves.toMatchObject({
      value: { payload: { type: 'host/session-removed', sessionId: targetId } },
    })
    controller.abort()
    await host.return?.()
    await ctx.fiber.dispose()
  })

  it('requires a cold leaf session before mutating any store', async () => {
    const childId = SessionId('child')
    const child: SessionHeader = { version: 0, id: childId, createdAt: 2, parentSession: targetId }
    const fixture = await harness([
      { header: target, live: false, persisted: true },
      { header: child, live: false, persisted: true },
    ])
    const withChild = await fixture.api.sessions.delete(request({ sessionId: targetId }))
    expect(withChild.result).toMatchObject({
      ok: false,
      error: { code: 'session-has-children', details: { sessionId: targetId, childSessionIds: [childId] } },
    })
    expect(fixture.deleteStored).not.toHaveBeenCalled()

    await fixture.ctx.agents.create({ sessionId: SessionId('live'), agentOptions: { provider: 'mock', model: 'mock' } })
    const live = await fixture.api.sessions.delete(request({ sessionId: SessionId('live') }))
    expect(live.result).toMatchObject({ ok: false, error: { code: 'agent-busy' } })
    expect(fixture.deleteStored).not.toHaveBeenCalled()
    await fixture.ctx.fiber.dispose()
  })

  it('keeps workspace references when the authoritative delete fails', async () => {
    const fixture = await harness()
    fixture.deleteStored.mockRejectedValueOnce(new Error('disk unavailable'))

    const failed = await fixture.api.sessions.delete(request({ sessionId: targetId }))

    expect(failed.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(fixture.deleteCheckpoint).toHaveBeenCalledWith(target)
    expect(fixture.removeSessionReferences).not.toHaveBeenCalled()
    await fixture.ctx.fiber.dispose()
  })

  it('converges derived cleanup when a prior authoritative delete already committed', async () => {
    const fixture = await harness()
    fixture.removeSessionReferences.mockRejectedValueOnce(new Error('workspace unavailable'))
    const first = await fixture.api.sessions.delete(request({ sessionId: targetId }))
    expect(first.result).toMatchObject({ ok: false, error: { code: 'internal' } })

    const retried = await fixture.api.sessions.delete(request({ sessionId: targetId }))

    expect(retried.result).toEqual({
      ok: true,
      value: { deleted: true, attachmentsRetained: true },
    })
    expect(fixture.deleteStored).toHaveBeenCalledTimes(1)
    expect(fixture.removeSessionReferences).toHaveBeenCalledTimes(2)
    await fixture.ctx.fiber.dispose()
  })

  it('rejects an identity that was never persisted or journaled', async () => {
    const fixture = await harness([])

    const response = await fixture.api.sessions.delete(request({ sessionId: SessionId('never-existed') }))

    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(fixture.deleteStored).not.toHaveBeenCalled()
    expect(fixture.removeSessionReferences).not.toHaveBeenCalled()
    await fixture.ctx.fiber.dispose()
  })
})
