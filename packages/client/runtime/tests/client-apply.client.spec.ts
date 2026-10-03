/**
 * Runtime plugin browser-half apply: slots + object services mounting over the
 * connection handle, stream-loop sink wiring into the object layer, and the
 * fiber-scoped loop teardown.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionSinks } from '@deepseek-ai/dsh-api-remotes/client'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-host-apiproxy/api'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as RuntimeClient from '../src/client/index.ts'
import type { ConversationNodeDefinition } from '../src/client/contract/conversation.ts'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionRuntime } from '../src/client/sessions/service.ts'
import type { WorkspaceRuntime } from '../src/client/workspaces/service.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

interface Bench {
  ctx: Context
  api: FakeApiClient
  sinks: ConnectionSinks | undefined
  stopped: number
  switchMachine(api: FakeApiClient, id?: string): Promise<void>
}

async function mount(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const api = new FakeApiClient()
  let target: import('@deepseek-ai/dsh-api-remotes/client').MachineTarget = { kind: 'host' }
  let currentApi = api
  const targetListeners = new Set<() => void>()
  const bench: Bench = { ctx, api, sinks: undefined, stopped: 0,
    switchMachine(next, id) {
      currentApi = next
      target = id === undefined ? { kind: 'host' } : { kind: 'remote', id }
      const disposed = bench.sinks?.onTargetChange?.()
      for (const listener of targetListeners) listener()
      return Promise.resolve(disposed)
    },
  }
  const handle: ConnectionHandle = {
    target: {
      getSnapshot: () => target,
      subscribe: (listener) => { targetListeners.add(listener); return () => { targetListeners.delete(listener) } },
    },
    captureApi: () => currentApi,
    switchTarget: async () => {},
    health: { getSnapshot: () => 'bypass', subscribe: () => () => {} },
    api,
    isLoopback: true,
    upload: () => new Promise<never>(() => {}),
    authentication: {
      getSnapshot: () => ({ kind: 'bypass' }),
      subscribe: () => () => {},
      validate: () => true,
    },
    hostDescription: {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    },
    rpc: {
      call: () => Promise.reject(new Error('unexpected generic RPC call')),
    },
    start: (sinks) => {
      bench.sinks = sinks
      return { stop: () => { bench.stopped += 1 } }
    },
  }
  ctx.reflect.provide('connection', handle)
  ctx.reflect.provide('remote', {})
  ctx.reflect.provide('remote.commands', fakeRemote().commands)
  await ctx.plugin(RuntimeClient).await()
  return bench
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('runtime client apply', () => {
  it('replaces colliding machine data and scopes through stable observable services', async () => {
    const bench = await mount()
    const sessions = bench.ctx.get('sessions') as SessionRuntime
    const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
    const list = sessions.list
    const workspaceList = workspaces.list
    const emptyProvide = sessions.currentProvideInfo.getSnapshot()
    bench.sinks?.onHostEnvelope?.({ rpcId: 'local' as never, payload: { type: 'host/session-added', sessionId: 'same', blank: true } as never })
    await flushMicrotasks()
    sessions.open('same' as never)
    const local = sessions.binding('same' as never)!
    const remote = new FakeApiClient()
    await bench.switchMachine(remote, 'remote')
    expect(sessions.list).toBe(list)
    expect(workspaces.list).toBe(workspaceList)
    expect(list.getSnapshot()).toMatchObject({ ids: [], current: undefined, phase: 'pending' })
    expect(workspaceList.getSnapshot()).toMatchObject({ items: [], phase: 'pending' })
    expect(sessions.currentProvideInfo.getSnapshot()).not.toBe(emptyProvide)
    expect(bench.sinks?.muxSince?.()).toEqual({})
    expect(sessions.binding('same' as never)).toBeUndefined()
    bench.sinks?.onHostEnvelope?.({ rpcId: 'remote' as never, payload: { type: 'host/session-added', sessionId: 'same', blank: true } as never })
    await flushMicrotasks()
    sessions.open('same' as never)
    expect(sessions.binding('same' as never)?.session).not.toBe(local.session)
    expect(sessions.sessionOf(local.ctx)).toBeUndefined()
    await bench.switchMachine(bench.api)
    expect(list.getSnapshot().ids).toEqual([])
    await bench.ctx.fiber.dispose()
  })

  it('fences a pending create and baseline when a new machine reuses their ids', async () => {
    const bench = await mount()
    const oldCreate = Promise.withResolvers<ReturnType<typeof ok<{ sessionId: never }>>>()
    bench.api.onCreate = () => oldCreate.promise
    const sessions = bench.ctx.get('sessions') as SessionRuntime
    const create = sessions.create().catch((error: unknown) => error)
    const staleList = Promise.withResolvers<ReturnType<typeof ok<{ items: never[] }>>>()
    bench.api.onList = () => staleList.promise
    const refresh = sessions.refresh()
    const remote = new FakeApiClient()
    await bench.switchMachine(remote, 'remote')
    oldCreate.resolve(ok({ sessionId: 'same' as never }))
    staleList.resolve(ok({ items: [{ sessionId: 'stale', blank: true }] as never[] }))
    await refresh
    expect(await create).toBeInstanceOf(Error)
    await flushMicrotasks()
    expect(sessions.list.getSnapshot().ids).toEqual([])
    expect(remote.callsOf('session.create')).toEqual([])
    await bench.ctx.fiber.dispose()
  })

  it('rejects a late Workspace create after its machine has been retired', async () => {
    const bench = await mount()
    const pending = Promise.withResolvers<Awaited<ReturnType<FakeApiClient['onWorkspaceCreate']>>>()
    bench.api.onWorkspaceCreate = () => pending.promise
    const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
    const create = workspaces.create({ path: '/local' }).catch((error: unknown) => error)
    await bench.switchMachine(new FakeApiClient(), 'remote')
    pending.resolve(ok({ created: true, workspace: {
      workspaceId: 'same' as never, path: '/local', title: 'local', sessionIds: [], createdAt: '0', updatedAt: '0',
    } }))
    expect(await create).toBeInstanceOf(Error)
    expect(workspaces.list.getSnapshot().items).toEqual([])
    await bench.ctx.fiber.dispose()
  })

  it('waits for old session effects to dispose while publishing empty machine state immediately', async () => {
    const bench = await mount()
    bench.sinks?.onHostEnvelope?.({ rpcId: 'local' as never, payload: { type: 'host/session-added', sessionId: 'same', blank: true } as never })
    await flushMicrotasks()
    const sessions = bench.ctx.get('sessions') as SessionRuntime
    const scope = sessions.scope('same' as never)!
    const disposing = Promise.withResolvers<undefined>()
    const disposed = Promise.withResolvers<undefined>()
    scope.effect(() => () => {
      expect(sessions.sessionOf(scope)).toBeUndefined()
      expect(() => sessions.scopeOf(scope)).toThrow('retired machine')
      disposing.resolve(undefined)
      return disposed.promise
    }, 'test: deferred cleanup')
    let settled = false
    const switched = bench.switchMachine(new FakeApiClient(), 'remote').then(() => { settled = true })
    await disposing.promise
    expect(sessions.list.getSnapshot().ids).toEqual([])
    expect(settled).toBe(false)
    disposed.resolve(undefined)
    await switched
    expect(sessions.scope('same' as never)).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('mounts slots, Sessions, and Workspaces and fans host frames into both managers', async () => {
    const bench = await mount()
    expect(bench.ctx.get('slots') !== undefined).toBe(true)
    // The built-in 'root' declaration ships with this package's SlotRegistry
    // (the SlotMap 'root' merge lives here).
    expect(bench.ctx.slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
    const sessions = bench.ctx.get('sessions')
    const workspaces = bench.ctx.get('workspaces')
    expect(sessions !== undefined).toBe(true)
    expect(workspaces !== undefined).toBe(true)
    // The bound the wire schema enforces, not a per-connection negotiation.
    expect((sessions as SessionRuntime).searchResultLimit).toBe(SESSION_SEARCH_RESULT_LIMIT)
    if (workspaces === undefined) throw new Error('WorkspaceRuntime missing after runtime apply')
    expect(bench.sinks).toBeDefined()

    // Frame sinks reach the object layer: a host session-added lands in the list store.
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r1' as never,
      payload: { type: 'host/session-added', blank: true, sessionId: 's-new' } as never,
    })
    await Promise.resolve()
    expect((sessions as { list: { getSnapshot(): { ids: string[] } } }).list.getSnapshot().ids).toContain('s-new')
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r-workspace' as never,
      payload: {
        type: 'host/workspace-changed',
        workspace: {
          workspaceId: 'w-new', path: '/w/new', title: 'new', sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      } as never,
    })
    await Promise.resolve()
    expect(workspaces.list.getSnapshot().items[0]?.workspaceId).toBe('w-new')
    // Mux sink and onConnected route without throwing (manager semantics own the behavior).
    bench.sinks?.onMuxEnvelope?.({ rpcId: 'r2' as never, payload: { type: 'stream/error', message: 'x' } as never })
    bench.sinks?.onConnected?.({ bootId: 'boot' as never, version: '0', cwd: '/f', attachedSessions: 0, canOpenPath: true }, { kind: 'bypass' })
  })

  it('selects the recent Workspace once when the first baselines have no current session', async () => {
    const bench = await mount()
    bench.api.onWorkspaceList = () => Promise.resolve(ok({
      items: [{
        workspaceId: 'w-recent', path: '/w/recent', title: 'recent', sessionIds: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never[],
      pinnedSessionIds: [],
    }))
    bench.api.onList = () => Promise.resolve(ok({ items: [] }))

    bench.sinks?.onConnected?.({ bootId: 'boot' as never, version: '0', cwd: '/f', attachedSessions: 0, canOpenPath: true }, { kind: 'bypass' })
    await flushMicrotasks()

    const sessions = bench.ctx.get('sessions') as SessionRuntime
    const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
    expect(bench.api.callsOf('session.create')).toEqual([{ workspaceId: 'w-recent' }])
    expect(sessions.list.getSnapshot().current).toBe('fk-new')

    sessions.clear()
    await workspaces.refresh()
    await flushMicrotasks()
    expect(sessions.list.getSnapshot().current).toBeUndefined()
    expect(bench.api.callsOf('session.create')).toHaveLength(1)
  })

  it('wires registry changes into resident Sessions during the runtime apply pass', async () => {
    const bench = await mount()
    const sessions = bench.ctx.get('sessions') as SessionRuntime
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r-registry' as never,
      payload: { type: 'host/session-added', blank: true, sessionId: 's-registry' } as never,
    })
    await flushMicrotasks()
    expect(sessions.binding('s-registry' as never)).toBeDefined()
    const rebuild = vi.spyOn(Session.prototype, 'rebuildConversationRegistry')
    const definition: ConversationNodeDefinition<null> = {
      kind: 'registry-probe',
      target: 'chat',
      match: () => null,
      start: () => null,
      update: context => context.state,
      buildViewNode: () => null,
    }

    bench.ctx.conversationEvents.register(definition)
    await flushMicrotasks()

    expect(rebuild).toHaveBeenCalledOnce()
    rebuild.mockRestore()
  })

  it('stops the stream loop when the plugin fiber unloads', async () => {
    const bench = await mount()
    const fiber = [...bench.ctx.registry.values()].find(f => f.name?.includes('client'))
    // Dispose the whole tree: the ctx.effect teardown must call loop.stop exactly once.
    await bench.ctx.fiber.dispose()
    expect(bench.stopped).toBe(1)
    void fiber
  })
})
