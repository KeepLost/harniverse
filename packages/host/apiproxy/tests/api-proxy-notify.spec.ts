/**
 * Page-presence routing of `session/notify` frames: the page token bound on
 * mux open plus `events.adopt` declarations route detected occurrences to
 * the owning page's live streams only — the most recent declarer wins, a
 * closed owner stream falls back to the previous declarer, a session without
 * an adopting page is not delivered, and a page's whole-set replacement moves
 * its delivery with it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

type NotifyFrame = Extract<MuxFrame, { type: 'session/notify' }>

const turnEnd = (session: Session): { type: 'turn/end'; seq: number; time: number; data: { turn: number; reason: { kind: 'completed' } } } => ({
  type: 'turn/end', seq: session.seq, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } },
})

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
  } as Agent
  ctx.agents.register(agent)
  return { ctx, session }
}

const api = (ctx: Context) => createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

/** One adopted mux stream plus its frame log and a settle helper. */
async function openPage(
  proxy: ReturnType<typeof api>,
  page: string,
  sessionId: SessionId,
): Promise<{ frames: MuxFrame[]; done: Promise<void>; abort: () => void }> {
  const abort = new AbortController()
  const frames: MuxFrame[] = []
  const done = (async () => {
    for await (const envelope of proxy.events.mux(
      { rpcId: RpcId(`t-${page}`), payload: { page, since: { [sessionId]: -1 } } },
      abort.signal,
    )) {
      frames.push(envelope.payload)
    }
  })()
  return { frames, done, abort: () => { abort.abort() } }
}

/** Wait until the stream machinery has delivered everything pushed so far. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 20) })

describe('session/notify page-presence routing', () => {
  it('delivers a detected occurrence only to the adopting page', async () => {
    const { ctx, session } = await harness()
    const proxy = api(ctx)
    const owner = await openPage(proxy, 'p1', session.id)
    const other = await openPage(proxy, 'p2', session.id)
    await proxy.events.adopt({ rpcId: RpcId('t-adopt-1'), payload: { page: 'p1', sessionIds: [session.id] } })
    ctx.emit('session/event', session, turnEnd(session))
    await settle()
    owner.abort()
    other.abort()
    await owner.done
    await other.done
    const notify = owner.frames.filter((frame): frame is NotifyFrame => frame.type === 'session/notify')
    expect(notify).toHaveLength(1)
    expect(notify[0]).toMatchObject({ sessionId: session.id, kind: 'completion', sourceKey: `session:${session.id}` })
    expect(other.frames.some(frame => frame.type === 'session/notify')).toBe(false)
  })

  it('routes to the most recent declarer while both pages are live', async () => {
    const { ctx, session } = await harness()
    const proxy = api(ctx)
    const first = await openPage(proxy, 'p1', session.id)
    const second = await openPage(proxy, 'p2', session.id)
    await proxy.events.adopt({ rpcId: RpcId('t-adopt-a'), payload: { page: 'p1', sessionIds: [session.id] } })
    await proxy.events.adopt({ rpcId: RpcId('t-adopt-b'), payload: { page: 'p2', sessionIds: [session.id] } })
    ctx.emit('session/event', session, turnEnd(session))
    await settle()
    first.abort()
    second.abort()
    await first.done
    await second.done
    expect(first.frames.some(frame => frame.type === 'session/notify')).toBe(false)
    expect(second.frames.filter(frame => frame.type === 'session/notify')).toHaveLength(1)
  })

  it('falls back to the previous declarer after the owner stream closes', async () => {
    const { ctx, session } = await harness()
    const proxy = api(ctx)
    const first = await openPage(proxy, 'p1', session.id)
    const second = await openPage(proxy, 'p2', session.id)
    await proxy.events.adopt({ rpcId: RpcId('t-adopt-a'), payload: { page: 'p1', sessionIds: [session.id] } })
    await proxy.events.adopt({ rpcId: RpcId('t-adopt-b'), payload: { page: 'p2', sessionIds: [session.id] } })
    ctx.emit('session/event', session, turnEnd(session))
    await settle()
    expect(second.frames.some(frame => frame.type === 'session/notify')).toBe(true)
    second.abort()
    await second.done
    ctx.emit('session/event', session, turnEnd(session))
    await settle()
    first.abort()
    await first.done
    expect(first.frames.filter(frame => frame.type === 'session/notify')).toHaveLength(1)
  })

  it('drops the occurrence when no page adopted the session', async () => {
    const { ctx, session } = await harness()
    const proxy = api(ctx)
    const page = await openPage(proxy, 'p1', session.id)
    ctx.emit('session/event', session, turnEnd(session))
    await settle()
    page.abort()
    await page.done
    expect(page.frames.some(frame => frame.type === 'session/notify')).toBe(false)
    // The raw event still flows: presence gates only notifications.
    expect(page.frames.some(frame => frame.type === 'session/event')).toBe(true)
  })

  it('moves delivery with a whole-set replacement and clears an empty declaration', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    const proxy = api(ctx)
    const page = await openPage(proxy, 'p1', session.id)
    await proxy.events.adopt({ rpcId: RpcId('t-adopt-a'), payload: { page: 'p1', sessionIds: [session.id] } })
    await proxy.events.adopt({ rpcId: RpcId('t-adopt-b'), payload: { page: 'p1', sessionIds: [other.id] } })
    ctx.emit('session/event', session, turnEnd(session))
    await settle()
    expect(page.frames.some(frame => frame.type === 'session/notify')).toBe(false)
    ctx.emit('session/event', other, turnEnd(other))
    await settle()
    page.abort()
    await page.done
    expect(page.frames.filter(frame => frame.type === 'session/notify')).toHaveLength(1)
    expect(page.frames.find(frame => frame.type === 'session/notify')).toMatchObject({ sessionId: other.id })
  })
})
