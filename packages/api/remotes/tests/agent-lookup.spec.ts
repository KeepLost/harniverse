import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { createApiRemoteAgentResolver } from '@deepseek-ai/dsh-api-remotes'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const sid = (value: string): SessionId => value as SessionId

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1, cwd: '/proj' }
}

async function createContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/**
 * Provide a durable session whose listing is the resolver's pre-resume read.
 * `onRead` runs during that read, which is where a concurrent publish has to
 * land for the re-checks after it to mean anything.
 */
function provideSession(
  ctx: Context,
  meta: SessionHeader,
  onRead: () => void = () => undefined,
): void {
  ctx.provide('sessionPersistence', {
    list: () => {
      onRead()
      return Promise.resolve([meta])
    },
    inspect: () => Promise.resolve({ meta, events: [] as SessionEvent[] }),
    locate: () => undefined,
  } as never)
}

function stubAgent(ctx: Context, session: Session): Agent {
  return { id: session.id, session, status: 'idle', ctx } as Agent
}

describe('API Remote Agent resolver races', () => {
  it('disposes a resumed session without a cwd before returning session-not-found', async () => {
    const ctx = await createContext()
    const sessionId = sid('missing-after-resume')
    const meta = header(sessionId)
    provideSession(ctx, meta)
    // The listing names it, but the log the resume loads places it in no
    // project. The authoritative read is the resumed session's own header.
    const detached = ctx.sessions.prepare(sessionId, { meta: { cwd: '/proj' } })
    Object.defineProperty(detached, 'header', {
      value: { ...meta, cwd: undefined },
      configurable: true,
    })
    const detach = ctx.sessions.enter(detached)
    const dispose = vi.fn(() => {
      detach()
      return Promise.resolve()
    })
    vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: stubAgent(ctx, detached),
      dispose,
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'session-not-found', details: { sessionId } } })
    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('refuses a stored subagent identity before resuming it', async () => {
    const ctx = await createContext()
    const sessionId = sid('stored-subagent')
    // Owned by subagent routing in the durable header itself, with nothing
    // live and nothing published concurrently: the pre-resume read is the only
    // thing that can see this, and resuming it would hand a generic caller an
    // Agent that subagent routing owns.
    provideSession(ctx, { ...header(sessionId), origin: 'subagent' })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('resumes through a concurrently attached ordinary Session without optional defaults', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-attach-race')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
    })
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: sessionId })
    await ctx.fiber.dispose()
  })

  it('rejects a subagent Session published after the pre-resume read', async () => {
    const ctx = await createContext()
    const sessionId = sid('owned-attach-race')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => {
      ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
    })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reclassifies failed resumes after a live or attached subagent wins publication', async () => {
    for (const winner of ['agent', 'session'] as const) {
      const ctx = await createContext()
      const sessionId = sid(`owned-${winner}-resume-race`)
      const meta = header(sessionId)
      provideSession(ctx, meta)
      vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async () => {
        const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
        if (winner === 'agent') ctx.agents.register(stubAgent(ctx, session))
        throw new Error('session id already published')
      })

      const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

      expect(result).toMatchObject({ error: { code: 'agent-busy' } })
      await ctx.fiber.dispose()
    }
  })

  it('uses the shared cold-resume policy for the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-cold-resume')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
    })
    const agentCtx = ctx.extend()
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(agentCtx, published), dispose: () => Promise.resolve() }
    })
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    await expect(provider.resolve(sessionId)).resolves.toBe(agentCtx)
    await ctx.fiber.dispose()
  })

  it('applies the subagent ownership fence to the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-owned-subagent')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
    ctx.agents.register(stubAgent(ctx.extend(), session))
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    const resolution = provider.resolve(sessionId)
    await expect(resolution).rejects.toBeInstanceOf(TypertLookupFailure)
    await expect(resolution).rejects.toMatchObject({ failure: { code: 'agent-busy' } })
    await ctx.fiber.dispose()
  })
})
