import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type QueueService from '../src/index.ts'
import { apply } from '../src/tool.ts'

interface Captured {
  name: string
  execute: (args: Record<string, unknown>, exec: { agent?: unknown }) => Promise<unknown>
  render: (args: unknown, value: Record<string, unknown>) => Array<{ type: string; text: string }>
}

/** Mount the tool plugin over a scripted queue service face. */
async function mounted(queue: Partial<QueueService>): Promise<Captured[]> {
  const ctx = new Context()
  const captured: Captured[] = []
  ctx.provide('queue', queue as QueueService)
  ctx.provide('tools', {
    register: (tool: {
      name: string
      execute: Captured['execute']
      output: { render: Captured['render'] }
    }) => {
      captured.push({ name: tool.name, execute: tool.execute, render: tool.output.render })
      return () => {}
    },
  } as never)
  apply(ctx)
  await Promise.resolve()
  return captured
}

const agent = { session: { id: 'session-self' } }

describe('queue tools', () => {
  it('queue-topic lists, inspects in both directions, and deletes', async () => {
    const deleted: string[] = []
    const tools = await mounted({
      topicList: () => [],
      stats: () => ({ topic: { id: 1, name: 'ops', ttlMs: null, createdAt: 0, nextOffset: 3 }, liveCount: 2, archivedCount: 0, subscriberCount: 1, oldestLiveOffset: 0, newestLiveOffset: 1 }),
      subscriptions: (topic: string | null, sessionId: string | null) => [{ sessionId: sessionId ?? 'x', topicId: 1, cursor: 1, subscribedAt: 0, lastDeliveredAt: null, topic: topic ?? '' } as never],
      topicDelete: async (name: string) => { deleted.push(name) },
    })
    const topicTool = tools.find(tool => tool.name === 'queue-topic')!
    const listed = await topicTool.execute({ action: 'list' }, { agent }) as { kind: string }
    expect(listed.kind).toBe('topics')
    const byTopic = await topicTool.execute({ action: 'inspect', topic: 'ops' }, { agent }) as { kind: string }
    expect(byTopic.kind).toBe('topic-subscribers')
    const bySelf = await topicTool.execute({ action: 'inspect', session: 'current' }, { agent }) as { kind: string; detail: string }
    expect(bySelf.kind).toBe('session-topics')
    expect(bySelf.detail).toContain('session-self')
    const byId = await topicTool.execute({ action: 'inspect', session: 'other' }, { agent }) as { detail: string }
    expect(byId.detail).toContain('other')
    const byNone = await topicTool.execute({ action: 'inspect' }, { agent }) as { detail: string }
    expect(byNone.detail).toContain('session-self')
    await topicTool.execute({ action: 'delete', topic: 'ops' }, { agent })
    expect(deleted).toEqual(['ops'])
    await expect(topicTool.execute({ action: 'delete' }, { agent })).rejects.toThrow(/requires topic/)
  })

  it('queue-history reads through the cursor-free view', async () => {
    const tools = await mounted({
      messages: () => [{ offset: 0, state: 'live' as const }],
    })
    const history = tools.find(tool => tool.name === 'queue-history')!
    const result = await history.execute({ topic: 'ops' }, { agent }) as { kind: string; detail: string }
    expect(result.kind).toBe('history')
    expect(result.detail).toContain('ops')
  })

  it('queue-subscription binds only the calling session', async () => {
    const subscribed: [string, string][] = []
    const unsubscribed: [string, string][] = []
    const tools = await mounted({
      subscribe: async (sessionId: string, topic: string) => {
        subscribed.push([sessionId, topic])
        return { sessionId, topicId: 1, cursor: 4, subscribedAt: 0, lastDeliveredAt: null }
      },
      unsubscribe: async (sessionId: string, topic: string) => { unsubscribed.push([sessionId, topic]) },
    })
    const sub = tools.find(tool => tool.name === 'queue-subscription')!
    const on = await sub.execute({ action: 'subscribe', topic: 'ops' }, { agent }) as { kind: string; cursor: number }
    expect(on.kind).toBe('subscribed')
    expect(on.cursor).toBe(4)
    const off = await sub.execute({ action: 'unsubscribe', topic: 'ops' }, { agent }) as { kind: string }
    expect(off.kind).toBe('unsubscribed')
    expect(subscribed).toEqual([['session-self', 'ops']])
    expect(unsubscribed).toEqual([['session-self', 'ops']])
    await expect(sub.execute({ action: 'subscribe', topic: 'ops' }, {})).rejects.toThrow(/session context/)
  })

  it('queue-publish stamps the calling session as publisher', async () => {
    const published: [string, unknown, string][] = []
    const tools = await mounted({
      publish: async (topic: string, payload: unknown, _headers: unknown, ttlMs: number | null, publisher: string) => {
        published.push([topic, payload, publisher])
        return { topicId: 1, offset: 7, payload, headers: {}, publisher, publishedAt: 0, expiresAt: ttlMs ?? 0, state: 'live' as const }
      },
    })
    const publish = tools.find(tool => tool.name === 'queue-publish')!
    const result = await publish.execute({ topic: 'ops', payload: { n: 1 } }, { agent }) as { kind: string; offset: number }
    expect(result.kind).toBe('published')
    expect(result.offset).toBe(7)
    expect(published).toEqual([['ops', { n: 1 }, 'session-self']])
    const anonymous = await publish.execute({ topic: 'ops', payload: {} }, {}) as { kind: string }
    expect(anonymous.kind).toBe('published')
    await expect(publish.execute({ topic: 'ops' }, { agent })).rejects.toThrow(/payload/)
  })

  it('renders every tool output arm', async () => {
    const tools = await mounted({
      subscriptions: () => [] as never,
      stats: () => ({}) as never,
      topicList: () => [],
      topicDelete: async () => {},
    })
    // The registry receives the rendered tool; pull render from the captured raw shape.
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const topic = byName.get('queue-topic')!
    expect(topic.render({}, { kind: 'topics', detail: 'x' })[0]!.text).toBe('topics: x')
    expect(topic.render({}, { kind: 'deleted' })[0]!.text).toBe('deleted')
    const history = byName.get('queue-history')!
    expect(history.render({}, { kind: 'history', detail: 'd' })[0]!.text).toContain('history')
    expect(history.render({}, { kind: 'history' })[0]!.text).toBe('history')
    const sub = byName.get('queue-subscription')!
    expect(sub.render({}, { kind: 'subscribed', topic: 'ops', cursor: 2 })[0]!.text).toContain('subscribed')
    expect(sub.render({}, { kind: 'unsubscribed', topic: 'ops' })[0]!.text).toContain('unsubscribed')
    // Fallback arms: absent topic/cursor/expiry render the neutral blanks.
    expect(sub.render({}, { kind: 'subscribed' })[0]!.text).toContain('cursor 0')
    expect(sub.render({}, { kind: 'unsubscribed' })[0]!.text).toContain('unsubscribed from')
    const publish = byName.get('queue-publish')!
    expect(publish.render({}, { kind: 'published', topic: 'ops', offset: 3, expiresAt: 9 })[0]!.text).toContain('#3')
    expect(publish.render({}, { kind: 'published' })[0]!.text).toContain('#0')
  })

  it('queue-topic inspect without a topic resolves the calling session (requireSelf cover)', async () => {
    const tools = await mounted({
      subscriptions: () => [] as never,
      stats: () => ({}) as never,
      topicList: () => [],
      topicDelete: async () => {},
    })
    const topicTool = tools.find(tool => tool.name === 'queue-topic')!
    await expect(topicTool.execute({ action: 'inspect' }, {})).rejects.toThrow(/session context/)
    const viFn = vi.fn()
    expect(viFn).not.toHaveBeenCalled()
  })
})
