import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHistoryPageRequest } from '@deepseek-ai/dsh-session-persistence'
import {
  apiRemoteSubagentOwnershipError,
  createApiRemoteAgentResolver,
  hasApiRemoteSubagentOwner,
  inspectApiRemoteSession,
  readApiRemoteSessionHistoryPage,
} from '@deepseek-ai/dsh-api-remotes'
import { readApiRemoteSessionHeader } from '../src/agent-lookup.ts'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const sid = (value: string): SessionId => value as SessionId

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1, cwd: '/proj' }
}

function projectless(meta: SessionHeader): SessionHeader {
  const copy = { ...meta }
  delete copy.cwd
  return copy
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

function providePersistence(
  ctx: Context,
  options: {
    list: () => Promise<SessionHeader[]>
    inspect: () => Promise<{ meta: SessionHeader; events: SessionEvent[] }>
    readHistoryPage?: (
      sessionId: SessionId,
      request: SessionHistoryPageRequest,
      signal?: AbortSignal,
    ) => Promise<{ meta: SessionHeader; events: SessionEvent[]; hasMore: boolean }>
  },
): void {
  ctx.provide('sessionPersistence', {
    ...options,
    locate: () => undefined,
  } as never)
}

describe('API Remote Agent resolver races', () => {
  it('classifies generic ownership and preserves the established rejection shape', async () => {
    const ctx = await createContext()
    const sessionId = sid('ownership')
    const parentId = sid('parent')
    const parent = {} as Agent
    const child = {} as Agent
    const get = vi.spyOn(ctx.agents, 'get').mockReturnValue(parent)
    const isOwnedBy = vi.spyOn(ctx.agents, 'isOwnedBy').mockReturnValue(true)

    expect(hasApiRemoteSubagentOwner(ctx, { header: { ...header(sessionId), origin: 'subagent' } }, child)).toBe(true)
    expect(hasApiRemoteSubagentOwner(ctx, { header: header(sessionId) }, undefined)).toBe(false)
    expect(hasApiRemoteSubagentOwner(ctx, { header: { ...header(sessionId), parentSession: parentId } }, undefined)).toBe(false)
    expect(hasApiRemoteSubagentOwner(ctx, { header: { ...header(sessionId), parentSession: parentId } }, child)).toBe(true)
    isOwnedBy.mockReturnValue(false)
    expect(hasApiRemoteSubagentOwner(ctx, { header: { ...header(sessionId), parentSession: parentId } }, child)).toBe(false)
    expect(get).toHaveBeenCalledWith(parentId)
    expect(apiRemoteSubagentOwnershipError(sessionId)).toEqual({
      code: 'agent-busy',
      message: `session "${sessionId}" is owned by subagent routing`,
      details: { reason: 'use subagent delivery for this child session' },
    })
    await ctx.fiber.dispose()
  })

  it('reads only project-backed cold session headers', async () => {
    await expect(readApiRemoteSessionHeader(new Context(), sid('not-configured'))).rejects.toThrow(
      'session persistence is not configured',
    )

    const absent = await createContext()
    providePersistence(absent, {
      list: () => Promise.resolve([]),
      inspect: () => Promise.resolve({ meta: header(sid('unused')), events: [] }),
    })
    await expect(readApiRemoteSessionHeader(absent, sid('absent'))).rejects.toThrow('session "absent" not found')
    await absent.fiber.dispose()

    const projectlessCtx = await createContext()
    const projectlessId = sid('projectless')
    const projectlessMeta = projectless(header(projectlessId))
    providePersistence(projectlessCtx, {
      list: () => Promise.resolve([projectlessMeta]),
      inspect: () => Promise.resolve({ meta: header(projectlessId), events: [] }),
    })
    await expect(readApiRemoteSessionHeader(projectlessCtx, projectlessId)).rejects.toThrow('session "projectless" not found')
    await projectlessCtx.fiber.dispose()

    const served = await createContext()
    const servedId = sid('served')
    const meta = header(servedId)
    providePersistence(served, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    await expect(readApiRemoteSessionHeader(served, servedId)).resolves.toEqual(meta)
    await served.fiber.dispose()
  })

  it('inspects cold sessions and rejects projectless or missing identities', async () => {
    await expect(inspectApiRemoteSession(new Context(), sid('not-configured'))).rejects.toThrow(
      'session persistence is not configured',
    )

    const absent = await createContext()
    providePersistence(absent, {
      list: () => Promise.resolve([]),
      inspect: () => Promise.resolve({ meta: header(sid('unused')), events: [] }),
    })
    await expect(inspectApiRemoteSession(absent, sid('absent'))).rejects.toThrow('session "absent" not found')
    await absent.fiber.dispose()

    const invalid = await createContext()
    const invalidId = sid('invalid-inspection')
    providePersistence(invalid, {
      list: () => Promise.resolve([header(invalidId)]),
      inspect: () => Promise.resolve({ meta: projectless(header(invalidId)), events: [] }),
    })
    await expect(inspectApiRemoteSession(invalid, invalidId)).rejects.toThrow('session "invalid-inspection" not found')
    await invalid.fiber.dispose()

    const served = await createContext()
    const servedId = sid('inspected')
    const meta = header(servedId)
    const events: SessionEvent[] = []
    providePersistence(served, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
    })
    const result = await inspectApiRemoteSession(served, servedId)
    expect(result).toEqual({ meta, events: [] })
    expect(result.events).not.toBe(events)
    await served.fiber.dispose()
  })

  it('reads native history pages and falls back to bounded inspection', async () => {
    await expect(readApiRemoteSessionHistoryPage(new Context(), sid('not-configured'), { maxMessages: 1 })).rejects.toThrow(
      'session persistence is not configured',
    )

    const absent = await createContext()
    providePersistence(absent, {
      list: () => Promise.resolve([]),
      inspect: () => Promise.resolve({ meta: header(sid('unused')), events: [] }),
    })
    await expect(readApiRemoteSessionHistoryPage(absent, sid('absent'), { maxMessages: 1 })).rejects.toThrow('session "absent" not found')
    await absent.fiber.dispose()

    const native = await createContext()
    const nativeId = sid('native-page')
    const nativeMeta = header(nativeId)
    const request = { beforeSeq: 7, maxMessages: 1, preferLatestCheckpoint: true }
    const readHistoryPage = vi.fn(async () => ({ meta: nativeMeta, events: [] as SessionEvent[], hasMore: true }))
    providePersistence(native, {
      list: () => Promise.resolve([nativeMeta]),
      inspect: () => Promise.resolve({ meta: nativeMeta, events: [] }),
      readHistoryPage,
    })
    await expect(readApiRemoteSessionHistoryPage(native, nativeId, request)).resolves.toEqual({
      meta: nativeMeta,
      events: [],
      hasMore: true,
    })
    expect(readHistoryPage).toHaveBeenCalledWith(nativeId, request, undefined)
    await native.fiber.dispose()

    const invalidNative = await createContext()
    const invalidNativeId = sid('invalid-native-page')
    const invalidNativeMeta = header(invalidNativeId)
    providePersistence(invalidNative, {
      list: () => Promise.resolve([invalidNativeMeta]),
      inspect: () => Promise.resolve({ meta: invalidNativeMeta, events: [] }),
      readHistoryPage: async () => ({ meta: projectless(invalidNativeMeta), events: [], hasMore: false }),
    })
    await expect(readApiRemoteSessionHistoryPage(invalidNative, invalidNativeId, { maxMessages: 1 })).rejects.toThrow(
      'session "invalid-native-page" not found',
    )
    await invalidNative.fiber.dispose()

    const fallback = await createContext()
    const fallbackId = sid('fallback-page')
    const fallbackMeta = header(fallbackId)
    providePersistence(fallback, {
      list: () => Promise.resolve([fallbackMeta]),
      inspect: () => Promise.resolve({ meta: fallbackMeta, events: [] }),
    })
    await expect(readApiRemoteSessionHistoryPage(fallback, fallbackId, { maxMessages: 1 })).resolves.toEqual({
      meta: fallbackMeta,
      events: [],
      hasMore: false,
    })
    await fallback.fiber.dispose()

    const invalidFallback = await createContext()
    const invalidFallbackId = sid('invalid-fallback-page')
    providePersistence(invalidFallback, {
      list: () => Promise.resolve([header(invalidFallbackId)]),
      inspect: () => Promise.resolve({ meta: projectless(header(invalidFallbackId)), events: [] }),
    })
    await expect(readApiRemoteSessionHistoryPage(invalidFallback, invalidFallbackId, { maxMessages: 1 })).rejects.toThrow(
      'session "invalid-fallback-page" not found',
    )
    await invalidFallback.fiber.dispose()
  })

  it('reuses a normal live Agent without attempting a cold resume', async () => {
    const ctx = await createContext()
    const sessionId = sid('live-ordinary')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
    const agent = stubAgent(ctx, session)
    vi.spyOn(ctx.agents, 'get').mockReturnValue(agent)
    const resume = vi.spyOn(ctx.agents, 'resume')
    const resolveAgent = createApiRemoteAgentResolver(ctx, {})

    await expect(resolveAgent(sessionId)).resolves.toEqual({ agent })
    expect(resume).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(ctx.typert.lookups.get('session')).toBeDefined() })
    await expect(ctx.typert.lookups.get('session')?.resolve(sessionId)).resolves.toBe(session)
    await ctx.fiber.dispose()
  })

  it('rejects an attached subagent before attempting a generic resume', async () => {
    const ctx = await createContext()
    const sessionId = sid('attached-subagent')
    ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
    const resume = vi.spyOn(ctx.agents, 'resume')

    await expect(createApiRemoteAgentResolver(ctx, {})(sessionId)).resolves.toMatchObject({
      error: { code: 'agent-busy' },
    })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('rechecks an ordinary Session published during a cold resume', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-recheck')
    const meta = header(sessionId)
    provideSession(ctx, meta)
    const attached = { header: meta, id: sessionId } as Session
    vi.spyOn(ctx.sessions, 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValue(attached)
    const agent = stubAgent(ctx, attached)
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent,
      dispose: () => Promise.resolve(),
    })

    await expect(createApiRemoteAgentResolver(ctx, {})(sessionId)).resolves.toEqual({ agent })
    expect(resume).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('continues a cold resume when no Session is published during the recheck', async () => {
    const ctx = await createContext()
    const sessionId = sid('no-publication-recheck')
    const meta = header(sessionId)
    provideSession(ctx, meta)
    const session = { id: sessionId, header: meta } as Session
    const agent = stubAgent(ctx, session)
    vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent,
      dispose: () => Promise.resolve(),
    })

    await expect(createApiRemoteAgentResolver(ctx, {})(sessionId)).resolves.toEqual({ agent })
    await ctx.fiber.dispose()
  })

  it('continues when the rechecked Session belongs to a non-subagent owner', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-owner-recheck')
    const parentId = sid('ordinary-owner')
    const meta = { ...header(sessionId), parentSession: parentId }
    provideSession(ctx, meta)
    const attached = { header: meta, id: sessionId } as Session
    vi.spyOn(ctx.sessions, 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValue(attached)
    const publishedAgent = stubAgent(ctx, attached)
    const parent = {} as Agent
    vi.spyOn(ctx.agents, 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(publishedAgent)
      .mockReturnValue(parent)
    vi.spyOn(ctx.agents, 'isOwnedBy').mockReturnValue(false)
    vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: publishedAgent,
      dispose: () => Promise.resolve(),
    })

    await expect(createApiRemoteAgentResolver(ctx, {})(sessionId)).resolves.toEqual({ agent: publishedAgent })
    await ctx.fiber.dispose()
  })

  it('returns an internal error when an ordinary cold resume fails', async () => {
    const ctx = await createContext()
    const sessionId = sid('failed-ordinary-resume')
    const meta = header(sessionId)
    provideSession(ctx, meta)
    const attached = { header: meta, id: sessionId } as Session
    vi.spyOn(ctx.sessions, 'get').mockReturnValue(attached)
    vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new Error('resume exploded'))

    await expect(createApiRemoteAgentResolver(ctx, {})(sessionId)).resolves.toEqual({
      error: {
        code: 'internal',
        message: `resume failed for session "${sessionId}": Error: resume exploded`,
        details: {},
      },
    })
    await ctx.fiber.dispose()
  })

  it('shares one cold resume and passes the current Host setup policy', async () => {
    const ctx = await createContext()
    const sessionId = sid('shared-cold-resume')
    const meta = header(sessionId)
    provideSession(ctx, meta)
    const session = ctx.sessions.prepare(sessionId, { meta: { cwd: '/proj' } })
    const agent = stubAgent(ctx, session)
    const agentSetup = vi.fn((_agentCtx: Context) => undefined)
    const setup = vi.fn((_session: { meta: SessionHeader }) => agentSetup)
    const agentOptions = vi.fn(() => ({ model: 'test-model' }))
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      await pending
      return { agent, dispose: () => Promise.resolve() }
    })
    const resolveAgent = createApiRemoteAgentResolver(ctx, { setup, agentOptions })

    const first = resolveAgent(sessionId)
    const second = resolveAgent(sessionId)
    await vi.waitFor(() => { expect(resume).toHaveBeenCalledOnce() })
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([{ agent }, { agent }])
    expect(agentOptions).toHaveBeenCalledOnce()
    expect(setup).toHaveBeenCalledWith({ meta })
    expect(resume).toHaveBeenCalledWith({
      resumeSessionId: sessionId,
      agentOptions: { model: 'test-model' },
      setup: agentSetup,
    })
    await ctx.fiber.dispose()
  })

  it('disposes a resumed session without a cwd before returning session-not-found', async () => {
    const ctx = await createContext()
    const sessionId = sid('missing-after-resume')
    const meta = header(sessionId)
    provideSession(ctx, meta)
    // The listing names it, but the log the resume loads places it in no
    // project. The authoritative read is the resumed session's own header.
    const detached = ctx.sessions.prepare(sessionId, { meta: { cwd: '/proj' } })
    Object.defineProperty(detached, 'header', {
      value: projectless(meta),
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
