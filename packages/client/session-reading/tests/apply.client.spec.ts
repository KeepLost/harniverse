// @vitest-environment jsdom
/**
 * Session-reading browser half on a real cordis Context with fake slot,
 * sessions, and Remote faces: the plugin publishes the ledger as the
 * `useSessionReading` root hook, re-reads it on the forwarded change signal
 * and on reconnect, re-evaluates on window focus and document visibility, and
 * withdraws everything with its fiber (HMR safety).
 */
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SlotRegistry, type ConversationSnapshot, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReadingAction, SessionReadingRecord } from '../src/types.ts'
import type { SessionReadingRemote, SessionReadingState } from '../src/client/controller.ts'

/** The transcript facts the controller reads: which turns ended and whether the window loaded. */
type Transcript = Pick<ConversationSnapshot, 'turnEnds' | 'openState'>
import { apply, inject } from '../src/client/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

const sid = (id: string): SessionId => id as SessionId

/** Minimal observable cell the fake sessions feed publishes through. */
function cell<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): T => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next: T): void => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

interface Bench {
  ctx: Context
  fiber: Fiber
  hook: () => SessionReadingState | undefined
  /** The fake Host ledger; tests edit it in place to simulate Host changes. */
  ledger: SessionReadingRecord[]
  listeners: Map<string, () => void>
  list: Mock<SessionReadingRemote['list']>
  mark: Mock<SessionReadingRemote['mark']>
  select: (sessionId: SessionId | undefined) => void
}

/** Mount the plugin over fake faces seeded with `records` and expose the published root hook. */
async function bench(records: readonly SessionReadingRecord[] = []): Promise<Bench> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  let host: SlotRendererHost | undefined
  ctx.slots.install({ renderRoot: (captured) => { host = captured; return null } })
  // One root render hands the registry's renderer host to the test.
  ctx.slots.register({ name: 'root' } as never, () => null)
  ctx.slots.renderSlot('root', {})
  const listeners = new Map<string, () => void>()
  const remote = {
    $on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    }),
  }
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
      Object.assign(this, remote)
    }
  }
  // The fake Host ledger: marks apply the way the real service stores them.
  const ledger: SessionReadingRecord[] = [...records]
  const namespace = {
    list: vi.fn<SessionReadingRemote['list']>(() => Promise.resolve({ ok: true as const, value: { records: [...ledger] } })),
    mark: vi.fn<SessionReadingRemote['mark']>((sessionId: SessionId, action: SessionReadingAction) => {
      const row = ledger.find(candidate => candidate.sessionId === sessionId)
      const stored = action === 'unread'
        ? { ...(row ?? record(sessionId)), manualUnread: true }
        : row === undefined ? undefined : { ...row, manualUnread: false, readTurn: row.completedTurn }
      if (stored !== undefined && row === undefined) ledger.push(stored)
      else if (stored !== undefined && row !== undefined) ledger[ledger.indexOf(row)] = stored
      return Promise.resolve({ ok: true as const, value: { record: stored ?? null } })
    }),
  }
  const list = cell<{ current: SessionId | undefined }>({ current: undefined })
  const transcript = cell<Transcript>({ turnEnds: new Map([[1, 1]]), openState: 'open' })
  new RemoteService(ctx)
  ctx.provide('remote.sessionReading', namespace)
  ctx.provide('sessions', { list, binding: () => ({ session: transcript }) })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    fiber,
    ledger,
    listeners,
    list: namespace.list,
    mark: namespace.mark,
    select: (sessionId) => { list.set({ current: sessionId }) },
    hook: () => host?.root.getSnapshot().hooks.sessionReading?.getSnapshot() as SessionReadingState | undefined,
  }
}

/** Let every pending promise chain settle before the next assertion. */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round++) await Promise.resolve()
}

const record = (sessionId: string): SessionReadingRecord => ({
  sessionId: sid(sessionId),
  completedTurn: 1,
  failed: false,
  readTurn: 0,
  manualUnread: false,
})

/** Pin the page's visibility and focus facts the plugin reads from the document. */
function page(options: { visible: boolean; focused: boolean }): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => options.visible ? 'visible' : 'hidden' })
  vi.spyOn(document, 'hasFocus').mockReturnValue(options.focused)
}

describe('session-reading browser half', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'sessions', 'remote', 'remote.sessionReading'])
  })

  it('publishes the Host ledger as the useSessionReading root hook', async () => {
    const b = await bench([record('done')])
    page({ visible: false, focused: false })
    await settle()
    expect(b.hook()?.unread).toEqual({ done: { failed: false } })
    page({ visible: true, focused: true })
    b.select(sid('done'))
    b.hook()?.report(sid('done'), true)
    await settle()
    expect(b.mark).toHaveBeenCalledExactlyOnceWith(sid('done'), 'read')
    b.hook()?.mark(sid('other'), 'unread')
    expect(b.mark).toHaveBeenLastCalledWith(sid('other'), 'unread')
  })

  it('re-reads the ledger on the forwarded change signal and on reconnect', async () => {
    const b = await bench()
    await settle()
    expect(b.list).toHaveBeenCalledTimes(1)
    const changed = b.listeners.get('sessionReading/changed')
    expect(changed).toBeDefined()
    changed?.()
    expect(b.list).toHaveBeenCalledTimes(2)
    b.ctx.emit('connection/reset')
    await settle()
    expect(b.list).toHaveBeenCalledTimes(3)
  })

  it('re-evaluates when the window focus or the document visibility moves', async () => {
    const b = await bench([record('done')])
    page({ visible: true, focused: false })
    b.select(sid('done'))
    await settle()
    b.hook()?.report(sid('done'), true)
    expect(b.mark).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('focus'))
    expect(b.mark).not.toHaveBeenCalled()
    page({ visible: false, focused: true })
    window.dispatchEvent(new Event('blur'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(b.mark).not.toHaveBeenCalled()
    page({ visible: true, focused: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(b.mark).toHaveBeenCalledExactlyOnceWith(sid('done'), 'read')
  })

  it('withdraws the root hook and every subscription with its fiber', async () => {
    const b = await bench()
    await settle()
    expect(b.hook()).toBeDefined()
    await b.fiber.dispose()
    expect(b.hook()).toBeUndefined()
    expect(b.listeners.size).toBe(0)
    const reads = b.list.mock.calls.length
    b.ctx.emit('connection/reset')
    page({ visible: true, focused: true })
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('blur'))
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(b.list).toHaveBeenCalledTimes(reads)
    expect(b.mark).not.toHaveBeenCalled()
  })
})
