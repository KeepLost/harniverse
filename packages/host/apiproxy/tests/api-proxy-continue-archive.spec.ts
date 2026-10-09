/** Continuing an imported archive into a new live session, and announcing archival imports. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { continuationSeedOf } from '@deepseek-ai/dsh-session-import'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { UnknownPresetError } from '@deepseek-ai/dsh-agent-presets'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`continue-${String(nextRpc++)}`), payload }
}

interface Harness {
  readonly ctx: Context
  readonly created: CreateAgentOptions[]
  readonly archived: SessionId[]
}

function workspace(id: string, path: string, sessionIds: SessionId[] = [], attach = vi.fn(() => Promise.resolve())): Workspace {
  return { id, path, sessionIds, attachSession: attach } as unknown as Workspace
}

async function composed(workspaces: readonly Workspace[] = [], failCreate?: Error): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const archived: SessionId[] = []
  const pendingSessionDeletionIds = new Set<SessionId>()
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return archived },
    pinnedSessionIds: [],
    list: () => workspaces,
    get: (id: string) => workspaces.find(candidate => candidate.id === id),
    get pendingSessionDeletionIds() { return [...pendingSessionDeletionIds] },
    beginSessionDeletion: (id: SessionId) => {
      pendingSessionDeletionIds.add(id)
      return Promise.resolve()
    },
    completeSessionDeletion: (id: SessionId) => {
      pendingSessionDeletionIds.delete(id)
      return Promise.resolve()
    },
    removeSessionReferences: () => Promise.resolve(),
  } as never)
  const created: CreateAgentOptions[] = []
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      if (failCreate !== undefined) throw failCreate
      created.push(options)
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, { id: session.id, session, status: 'idle', ctx: agentCtx })
      await options.setup?.(agentCtx)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('continuation sources are attached')),
  })
  return { ctx, created, archived }
}

function archiveEvents(sourceCwd?: string): SessionEvent[] {
  return [
    {
      type: 'import/record', seq: 0, time: 1,
      data: {
        source: { format: 'official-v4', artifactName: 'a.source.jsonl', sessionId: 'official-1', ...sourceCwd === undefined ? {} : { cwd: sourceCwd } },
        posture: { supervisionMode: 'supervised' },
      },
    },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'imported prompt' }] }),
    },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', seq: 4, time: 5, data: { title: 'Imported title', messageSeqs: [], source: { kind: 'user' } } },
    {
      type: 'user/message', seq: 5, time: 6, surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-session-import' }, content: [{ type: 'text', text: 'This session cannot execute.' }] }),
    },
  ]
}

function attachedArchive(ctx: Context, id: string, events = archiveEvents('/official/home'), cwd: string | null = '/import/target'): Session {
  return ctx.sessions.create(sid(id), { seed: events, meta: cwd === null ? {} : { cwd } })
}

/** The proxy with its optional continuation verb resolved (the full composition always serves it). */
function api(ctx: Context) {
  const proxy = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    cwd: '/defaults',
  })
  const continueArchive = proxy.sessions.continueArchive?.bind(proxy.sessions)
  if (continueArchive === undefined) throw new Error('the api proxy must serve session.continueArchive')
  return { ...proxy, sessions: { ...proxy.sessions, continueArchive } }
}

describe('sessions.continueArchive', () => {
  it('seeds a lineage-free continuation in the workspace that owns the archive', async () => {
    const attach = vi.fn(() => Promise.resolve())
    const owner = workspace('workspace-owner', '/owner/path', [sid('archive-1')], attach)
    const { ctx, created } = await composed([owner])
    const archive = attachedArchive(ctx, 'archive-1')
    const response = await api(ctx).sessions.continueArchive(request({ sessionId: archive.id }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const childId = response.result.value.sessionId
    expect(childId).toMatch(/^session-[0-9a-f-]{36}$/u)
    expect(response.result.value).not.toHaveProperty('agentProfile')
    // The origin note mints a fresh message identity per derivation.
    const seed = continuationSeedOf(archive.events)
    expect(created[0]).toMatchObject({ sessionId: childId, meta: { cwd: '/owner/path', seedLength: seed.length } })
    expect(created[0]?.seed?.slice(1)).toEqual(seed.slice(1))
    const child = ctx.sessions.get(childId)!
    expect(child.header.parentSession).toBeUndefined()
    expect(child.events.map(event => event.type)).toEqual([
      'user/message', 'turn/start', 'user/message', 'turn/end', 'session/title', 'session/end-seed',
    ])
    expect(JSON.stringify(child.deriveMessages())).toContain('imported prompt')
    expect(attach).toHaveBeenCalledExactlyOnceWith(childId)
    await ctx.fiber.dispose()
  })

  it('lands in an explicitly chosen workspace', async () => {
    const attach = vi.fn(() => Promise.resolve())
    const chosen = workspace('workspace-chosen', '/chosen/path', [], attach)
    const { ctx, created } = await composed([workspace('workspace-owner', '/owner/path', [sid('archive-1')]), chosen])
    attachedArchive(ctx, 'archive-1')
    const response = await api(ctx).sessions.continueArchive(request({ sessionId: sid('archive-1'), workspaceId: 'workspace-chosen' as never }))
    expect(response.result.ok).toBe(true)
    expect(created[0]?.meta).toMatchObject({ cwd: '/chosen/path' })
    expect(attach).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('falls back to the archive cwd, then the deployment default, without a workspace', async () => {
    const { ctx, created } = await composed()
    attachedArchive(ctx, 'archive-cwd')
    attachedArchive(ctx, 'archive-loose', archiveEvents(), null)
    const proxy = api(ctx)
    expect((await proxy.sessions.continueArchive(request({ sessionId: sid('archive-cwd') }))).result.ok).toBe(true)
    expect((await proxy.sessions.continueArchive(request({ sessionId: sid('archive-loose') }))).result.ok).toBe(true)
    expect(created.map(options => options.meta?.cwd)).toEqual(['/import/target', '/defaults'])
    await ctx.fiber.dispose()
  })

  it('refuses unknown workspaces, ordinary sessions, unknown sessions, and unusable seeds', async () => {
    const { ctx, created } = await composed()
    attachedArchive(ctx, 'archive-1')
    const native = ctx.sessions.create(sid('native'), { meta: { cwd: '/p' } })
    native.append('turn/start', { turn: 1 })
    const broken = archiveEvents()
    broken.push({ ...broken[2]!, seq: 6, sourceEventSeqs: [0] } as SessionEvent)
    attachedArchive(ctx, 'archive-broken', broken)
    const proxy = api(ctx)
    expect((await proxy.sessions.continueArchive(request({ sessionId: sid('archive-1'), workspaceId: 'missing' as never }))).result)
      .toEqual({ ok: false, error: { code: 'workspace-not-found', message: 'workspace "missing" not found', details: { workspaceId: 'missing' } } })
    expect((await proxy.sessions.continueArchive(request({ sessionId: native.id }))).result)
      .toEqual({ ok: false, error: { code: 'fork-unavailable', message: 'session "native" is not an imported archive', details: { sessionId: 'native' } } })
    expect((await proxy.sessions.continueArchive(request({ sessionId: sid('archive-broken') }))).result)
      .toEqual({ ok: false, error: { code: 'fork-unavailable', message: 'session "archive-broken" cannot be continued: TypeError: continuation seed cannot reference dropped event 0', details: { sessionId: 'archive-broken' } } })
    ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    expect((await proxy.sessions.continueArchive(request({ sessionId: sid('nowhere') }))).result).toMatchObject({ ok: false, error: { code: 'session-not-found', details: { sessionId: 'nowhere' } } })
    expect(created).toEqual([])
    await ctx.fiber.dispose()
  })

  it('reports an unreadable source as internal', async () => {
    const { ctx } = await composed()
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([{ version: 0, id: sid('cold'), createdAt: 1, cwd: '/p' } satisfies SessionHeader]),
      inspect: () => Promise.reject(new Error('disk gone')),
    } as never)
    const result = (await api(ctx).sessions.continueArchive(request({ sessionId: sid('cold') }))).result
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(!result.ok && result.error.message).toMatch(/^continuation source unavailable for session "cold": /u)
    await ctx.fiber.dispose()
  })

  it('refuses a workspace-archived source like fork does', async () => {
    const { ctx, archived } = await composed()
    attachedArchive(ctx, 'archive-1')
    archived.push(sid('archive-1'))
    expect((await api(ctx).sessions.continueArchive(request({ sessionId: sid('archive-1') }))).result)
      .toMatchObject({ ok: false, error: { code: 'agent-busy', details: { reason: 'SESSION_ARCHIVED' } } })
    await ctx.fiber.dispose()
  })

  it('composes the requested agent preset and echoes it', async () => {
    const { ctx, created } = await composed()
    attachedArchive(ctx, 'archive-1')
    const mounted: string[] = []
    ctx.provide('agentPresets', {
      resolve: (id: string | undefined) => Promise.resolve({ id: id ?? 'default' }),
      mount: (_agentCtx: Context, id: string) => {
        mounted.push(id)
        return Promise.resolve()
      },
    } as never)
    const result = (await api(ctx).sessions.continueArchive(request({ sessionId: sid('archive-1'), agentProfile: 'coder' }))).result
    expect(result).toMatchObject({ ok: true, value: { agentProfile: 'coder' } })
    expect(created[0]?.meta).toMatchObject({ agentProfile: 'coder' })
    expect(mounted).toEqual(['coder'])
    await ctx.fiber.dispose()
  })

  it('maps preset refusals and creation failures', async () => {
    const preset = await composed()
    attachedArchive(preset.ctx, 'archive-1')
    preset.ctx.provide('agentPresets', {
      resolve: (id: string | undefined) => Promise.reject(new UnknownPresetError(id ?? '', ['default'])),
    } as never)
    expect((await api(preset.ctx).sessions.continueArchive(request({ sessionId: sid('archive-1'), agentProfile: 'ghost' }))).result)
      .toMatchObject({ ok: false, error: { code: 'agent-preset-not-found', details: { agentPreset: 'ghost', available: ['default'] } } })
    await preset.ctx.fiber.dispose()

    const failing = await composed([], new Error('factory down'))
    attachedArchive(failing.ctx, 'archive-1')
    expect((await api(failing.ctx).sessions.continueArchive(request({ sessionId: sid('archive-1') }))).result)
      .toEqual({ ok: false, error: { code: 'internal', message: 'failed to continue session "archive-1": Error: factory down', details: {} } })
    await failing.ctx.fiber.dispose()
  })

  it('reports a continuation that could not join its workspace', async () => {
    const owner = workspace('workspace-owner', '/owner/path', [sid('archive-1')], vi.fn(() => Promise.reject(new Error('full'))))
    const { ctx } = await composed([owner])
    attachedArchive(ctx, 'archive-1')
    const result = (await api(ctx).sessions.continueArchive(request({ sessionId: sid('archive-1') }))).result
    expect(result).toMatchObject({ ok: false, error: { code: 'workspace-attach-failed', details: { workspaceId: 'workspace-owner' } } })
    await ctx.fiber.dispose()
  })
})

describe('archival import announcements', () => {
  it('announces a settled import as a non-blank session row', async () => {
    const { ctx } = await composed()
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const next = stream.next()
    ctx.emit('session/imported', { version: 0, id: sid('session-imported-a-b'), createdAt: 1, cwd: '/import/target' })
    expect((await next).value).toMatchObject({
      payload: { type: 'host/session-added', sessionId: 'session-imported-a-b', blank: false, cwd: '/import/target' },
    })
    abort.abort()
    await ctx.fiber.dispose()
  })

  it('never lists an archive without turns as the reusable blank session', async () => {
    const { ctx } = await composed()
    const archive = attachedArchive(ctx, 'archive-empty', [archiveEvents()[0]!])
    ctx.agents.register({ id: archive.id, session: archive, status: 'idle', ctx } as Agent)
    const listed = await api(ctx).sessions.list(request({}))
    expect(listed.result.ok && listed.result.value.items.find(item => item.sessionId === archive.id)).toMatchObject({ blank: false })
    await ctx.fiber.dispose()
  })
})
