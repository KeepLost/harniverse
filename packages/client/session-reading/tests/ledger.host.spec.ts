/** Host reading ledger: durable turn settlements, reader marks, the change signal, and disposal. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SessionReadingService from '../src/index.ts'
import type { SessionReadingRecord } from '../src/types.ts'

const benches: Context[] = []

afterEach(async () => {
  await Promise.all(benches.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Boot the session store and the reading service; every change signal lands in `changes`. */
async function bench(): Promise<{
  ctx: Context
  service: SessionReadingService
  fiber: Fiber
  changes: number[]
}> {
  const ctx = new Context()
  benches.push(ctx)
  await ctx.plugin(SessionStore).await()
  const changes: number[] = []
  ctx.on('sessionReading/changed', () => { changes.push(changes.length + 1) })
  const fiber = await ctx.plugin(SessionReadingService).await()
  return { ctx, service: ctx.sessionReading, fiber, changes }
}

/** Append one closed turn: `turn/start` followed by `turn/end` with the given reason. */
function closeTurn(session: Session, turn: number, reason: TurnEndReason = { kind: 'completed' }): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason })
}

const FAILED: TurnEndReason = { kind: 'error', error: { message: 'provider down', code: 'UNKNOWN' } }
const ABORTED: TurnEndReason = { kind: 'aborted', reason: 'cancelled' } as never

const completed = (sessionId: string, completedTurn: number, failed = false): SessionReadingRecord => ({
  sessionId: SessionId(sessionId),
  completedTurn,
  failed,
  readTurn: 0,
  manualUnread: false,
})

describe('session reading ledger', () => {
  it('binds the sessionReading namespace and gates list under observe and mark under operate', async () => {
    const { service } = await bench()
    expect(service.typertRemote.namespace).toBe('sessionReading')
    expect(remoteMethods(service)).toEqual([
      { method: 'list', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
      { method: 'mark', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.operate' },
    ])
  })

  it('starts empty and ignores events that do not close a turn', async () => {
    const { ctx, service, changes } = await bench()
    await expect(service.list()).resolves.toEqual({ records: [] })
    const session = ctx.sessions.create(SessionId('quiet'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    await expect(service.list()).resolves.toEqual({ records: [] })
    expect(changes).toEqual([])
  })

  it('records each durable turn settlement and announces it once', async () => {
    const { ctx, service, changes } = await bench()
    closeTurn(ctx.sessions.create(SessionId('one')), 1)
    closeTurn(ctx.sessions.create(SessionId('two')), 4)
    await expect(service.list()).resolves.toEqual({ records: [completed('one', 1), completed('two', 4)] })
    expect(changes).toEqual([1, 2])
  })

  it('keeps the failed bit of the latest settlement only', async () => {
    const { ctx, service } = await bench()
    const session = ctx.sessions.create(SessionId('flaky'))
    closeTurn(session, 1)
    closeTurn(session, 2, FAILED)
    await expect(service.list()).resolves.toEqual({ records: [completed('flaky', 2, true)] })
    closeTurn(session, 3, ABORTED)
    await expect(service.list()).resolves.toEqual({ records: [completed('flaky', 3)] })
  })

  it('keeps the highest settled turn of one log', async () => {
    const { ctx, service } = await bench()
    closeTurn(ctx.sessions.create(SessionId('ordered')), 7)
    closeTurn(ctx.sessions.get(SessionId('ordered')) as Session, 8)
    await expect(service.list()).resolves.toEqual({ records: [completed('ordered', 8)] })
  })

  it('restarts the record when a session id begins carrying another log', async () => {
    const { ctx, service, changes } = await bench()
    const detachFirstLog = ctx.sessions.enter(Session.create(SessionId('reused')))
    closeTurn(ctx.sessions.get(SessionId('reused')) as Session, 5)
    await service.mark(SessionId('reused'), 'read')
    detachFirstLog()
    changes.length = 0
    closeTurn(ctx.sessions.create(SessionId('reused')), 1, FAILED)
    await expect(service.list()).resolves.toEqual({ records: [completed('reused', 1, true)] })
    expect(changes).toEqual([1])
  })

  it('acknowledges the completed turn on read and announces only a real change', async () => {
    const { ctx, service, changes } = await bench()
    const session = ctx.sessions.create(SessionId('read'))
    closeTurn(session, 2)
    changes.length = 0
    await expect(service.mark(session.id, 'read')).resolves.toEqual({
      record: { ...completed('read', 2), readTurn: 2 },
    })
    await expect(service.mark(session.id, 'read')).resolves.toEqual({
      record: { ...completed('read', 2), readTurn: 2 },
    })
    expect(changes).toEqual([1])
    closeTurn(session, 3)
    await expect(service.list()).resolves.toEqual({ records: [{ ...completed('read', 3), readTurn: 2 }] })
  })

  it('arms a session without a record on unread and lowers the manual mark on read', async () => {
    const { ctx, service, changes } = await bench()
    ctx.sessions.create(SessionId('todo'))
    await expect(service.mark(SessionId('todo'), 'unread')).resolves.toEqual({
      record: { ...completed('todo', 0), manualUnread: true },
    })
    await expect(service.mark(SessionId('todo'), 'unread')).resolves.toEqual({
      record: { ...completed('todo', 0), manualUnread: true },
    })
    await expect(service.mark(SessionId('todo'), 'read')).resolves.toEqual({ record: completed('todo', 0) })
    expect(changes).toEqual([1, 2])
  })

  it('answers read for a session without a record with nothing stored and nothing announced', async () => {
    const { ctx, service, changes } = await bench()
    ctx.sessions.create(SessionId('unknown'))
    await expect(service.mark(SessionId('unknown'), 'read')).resolves.toEqual({ record: null })
    await expect(service.list()).resolves.toEqual({ records: [] })
    expect(changes).toEqual([])
  })

  it('hands out frozen copies that cannot edit the ledger', async () => {
    const { ctx, service } = await bench()
    closeTurn(ctx.sessions.create(SessionId('frozen')), 1)
    const { records } = await service.list()
    expect(Object.isFrozen(records)).toBe(true)
    expect(Object.isFrozen(records[0])).toBe(true)
  })

  it('stops following turn settlements once the plugin unloads', async () => {
    const { ctx, service, fiber, changes } = await bench()
    closeTurn(ctx.sessions.create(SessionId('watched')), 1)
    await fiber.dispose()
    changes.length = 0
    closeTurn(ctx.sessions.create(SessionId('late')), 1)
    await expect(service.list()).resolves.toEqual({ records: [completed('watched', 1)] })
    expect(changes).toEqual([])
  })
})
