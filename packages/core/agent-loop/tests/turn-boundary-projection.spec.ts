import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

/** Boot the loop over a composition that carries the projection registry. */
async function makeProjectionContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, {
    agents: [{ id: 'main', sessionId: SessionId('projection-owner'), model: 'mock' }],
  })
  return ctx
}

/** A store-backed session so every append drives the registry eagerly. */
function liveSession(ctx: Context, id: string): Session {
  return ctx.sessions.create(SessionId(id))
}

describe('turn-boundary projection', () => {
  it('registers its unit when the loop boots over a projection registry', async () => {
    const ctx = await makeProjectionContext()
    expect(ctx.sessionProjections.snapshot(liveSession(ctx, 'projection-detached')).values.turnBoundary)
      .toEqual({ openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 })
    await ctx.fiber.dispose()
  })

  it('leaves compositions without the registry unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, {
      agents: [{ id: 'main', sessionId: SessionId('projection-less'), model: 'mock' }],
    })
    expect(ctx.get('sessionProjections')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('folds turn and step boundaries from an arbitrary session log', async () => {
    const ctx = await makeProjectionContext()
    const session = liveSession(ctx, 'projection-fold')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    expect(ctx.sessionProjections.snapshot(session).values.turnBoundary).toEqual({
      openTurnStartSeq: 0,
      lastStepStartSeq: 1,
      lastStepBoundary: { kind: 'start', seq: 1 },
      lastTurn: 1,
    })

    session.append('step/end', { turn: 1, step: 0 })
    session.append('todo/write', { todos: [] })
    expect(ctx.sessionProjections.snapshot(session).values.turnBoundary).toEqual({
      openTurnStartSeq: 0,
      lastStepStartSeq: 1,
      lastStepBoundary: { kind: 'end', seq: 2 },
      lastTurn: 1,
    })

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(ctx.sessionProjections.snapshot(session).values.turnBoundary).toEqual({
      openTurnStartSeq: null,
      lastStepStartSeq: 1,
      lastStepBoundary: { kind: 'end', seq: 2 },
      lastTurn: 1,
    })
    await ctx.fiber.dispose()
  })
})
