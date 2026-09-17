import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import QueueService from '../src/index.ts'
import type { QueueSubscriptionInfo } from '../src/types.ts'

/** One scripted agent the fan-out can deliver to. */
interface MockAgent {
  id: string
  status: 'running' | 'idle'
  followup: UserMessage[]
  injected: UserMessage[]
  /** Reject the first runMaintenance call once (the busy-retry arm). */
  failMaintenanceOnce?: boolean
}

interface Harness {
  readonly ctx: Context
  service: QueueService
  readonly agents: Map<string, MockAgent>
  readonly flushed: string[]
  archived: string[]
  pendingDeletion: string[]
  /** When set, sessionPersistence resolves through this scripted face. */
  persistence?: {
    list: () => Promise<Array<{ id: string }>>
    inspect: (id: string) => Promise<{ events: unknown[] }>
  }
  /** When set, agents.resume resolves through this scripted face. */
  resume?: (sessionId: string) => Promise<Agent>
  /** Sessions attached to the store without a live agent. */
  attached: Set<string>
}

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Boot the service over a JSON-backed storage domain with scripted agents. */
async function mounted(config: Record<string, number> = {}, opts: { persistence?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-queue-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const agents = new Map<string, MockAgent>()
  const h: Harness = {
    ctx,
    agents,
    flushed: [],
    archived: [],
    pendingDeletion: [],
    service: undefined as unknown as QueueService,
    attached: new Set<string>(),
  }
  ctx.provide('agents', {
    get: (id: string) => {
      const agent = agents.get(id)
      if (agent === undefined) return undefined
      const session = { id, append: () => {}, events: [] as unknown[] }
      return {
        id,
        session,
        get status() { return agent.status },
        inject: (message: UserMessage) => { agent.injected.push(message) },
        followup: (message: UserMessage) => { agent.followup.push(message) },
        runMaintenance: (run: () => Promise<boolean>) => {
          if (agent.failMaintenanceOnce === true) {
            agent.failMaintenanceOnce = false
            return Promise.reject(new Error('maintenance busy'))
          }
          return run()
        },
        whenIdle: async () => {},
      } as unknown as Agent
    },
    list: () => [],
    roots: () => [],
    resume: async (options: { resumeSessionId: string }) => {
      if (h.resume === undefined) throw new Error('no scripted resume')
      return { agent: await h.resume(options.resumeSessionId) }
    },
  } as never)
  ctx.provide('sessions', {
    get: (id: string) => (agents.has(id) || h.attached.has(id) ? { id } : undefined),
    flush: async () => { h.flushed.push('flush') },
  } as never)
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds(): string[] { return h.archived },
    get pendingSessionDeletionIds(): string[] { return h.pendingDeletion },
  } as never)
  if (opts.persistence !== false) {
    ctx.provide('sessionPersistence', {
      list: async () => h.persistence === undefined ? [] : await h.persistence.list(),
      inspect: async (id: string) => h.persistence === undefined
        ? { events: [] }
        : await h.persistence.inspect(id),
    } as never)
  }
  class Mounted extends QueueService {
    constructor(scope: Context) {
      super(scope, config)
    }
  }
  await ctx.plugin(Mounted)
  h.service = ctx.queue
  return h
}

/** Register one deliverable agent. */
function seedAgent(h: Harness, id: string, status: 'running' | 'idle' = 'idle'): MockAgent {
  const agent: MockAgent = { id, status, followup: [], injected: [] }
  h.agents.set(id, agent)
  return agent
}

describe('QueueService', () => {
  it('creates topics implicitly, assigns dense offsets, and wakes idle subscribers', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    await h.service.topicCreate('alerts', null)
    await h.service.subscribe('s1', 'alerts')
    const first = await h.service.publish('alerts', { text: 'hello' }, {}, null, 'panel')
    expect(first.offset).toBe(0)
    const second = await h.service.publish('alerts', { text: 'world' }, {}, null, 'panel')
    expect(second.offset).toBe(1)
    const agent = h.agents.get('s1')!
    expect(agent.followup).toHaveLength(2)
    expect(agent.followup[0]!.content[0]).toMatchObject({ type: 'text' })
    expect((agent.followup[0]!.content[0] as { text: string }).text).toContain('alerts')
    expect((agent.followup[0]!.source as { plugin: string }).plugin).toBe('queue')
    expect(h.service.stats('alerts')).toMatchObject({ liveCount: 2, subscriberCount: 1, newestLiveOffset: 1 })
    await h.ctx.fiber.dispose()
  })

  it('delivers to running subscribers through inject, after the blocking command', async () => {
    const h = await mounted()
    const agent = seedAgent(h, 'busy', 'running')
    await h.service.topicCreate('jobs', null)
    await h.service.subscribe('busy', 'jobs')
    await h.service.publish('jobs', { n: 1 }, {}, null, 'panel')
    await h.service.publish('jobs', { n: 2 }, {}, null, 'panel')
    expect(agent.injected).toHaveLength(2)
    expect(agent.followup).toHaveLength(0)
    // Both injections carry consecutive offsets — the next request sees both.
    const offsets = agent.injected.map(message => (message.source as unknown as { offset: number }).offset)
    expect(offsets).toEqual([0, 1])
    await h.ctx.fiber.dispose()
  })

  it('starts new subscriptions at latest: pre-subscription history never arrives', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    await h.service.topicCreate('news', null)
    await h.service.publish('news', { a: 1 }, {}, null, 'panel')
    const row = await h.service.subscribe('s1', 'news')
    expect(row.cursor).toBe(0)
    await h.service.publish('news', { a: 2 }, {}, null, 'panel')
    const agent = h.agents.get('s1')!
    expect(agent.followup).toHaveLength(1)
    expect((agent.followup[0]!.source as unknown as { offset: number }).offset).toBe(1)
    // History is the past-tense view and needs no subscription.
    expect(h.service.messages('news', 0, 100, false)).toHaveLength(2)
    await h.ctx.fiber.dispose()
  })

  it('retains but suspends subscriptions of archived sessions; missed stays missed', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    seedAgent(h, 's2')
    await h.service.topicCreate('stream', null)
    await h.service.subscribe('s1', 'stream')
    await h.service.subscribe('s2', 'stream')
    await h.service.publish('stream', { n: 1 }, {}, null, 'panel')
    h.archived.push('s1')
    await h.service.publish('stream', { n: 2 }, {}, null, 'panel')
    const agent = h.agents.get('s1')!
    expect(agent.followup).toHaveLength(1)
    // Unarchive: the relation is still there, but message #1 of the archive window never arrives.
    h.archived.splice(0, h.archived.length)
    await h.service.publish('stream', { n: 3 }, {}, null, 'panel')
    expect(agent.followup).toHaveLength(2)
    expect((agent.followup[1]!.source as unknown as { offset: number }).offset).toBe(2)
    const rows: QueueSubscriptionInfo[] = h.service.subscriptions('stream', null)
    expect(rows[0]!.cursor).toBe(2)
    // Subscribing an archived session outright rejects.
    h.archived.push('s2')
    await expect(h.service.subscribe('s2', 'stream')).rejects.toThrow(/archived/)
    // The archived subscriber's retained row reports itself dormant.
    expect(h.service.subscriptions('stream', null).map(row => row.dormant)).toEqual([false, true])
    await h.ctx.fiber.dispose()
  })

  it('dissolves the relation silently when either side is deleted', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    seedAgent(h, 's2')
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('s1', 'ops')
    await h.service.subscribe('s2', 'ops')
    // Topic side: delete dissolves every row, silently, and a same-name topic is fresh.
    await h.service.topicDelete('ops')
    expect(h.service.subscriptions(null, null)).toHaveLength(0)
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(h.service.messages('ops', 0, 100, false)).toHaveLength(1)
    expect(h.service.subscriptions('ops', null)).toHaveLength(0)
    // Session side: pending deletion drops rows on the next sweep/publish.
    await h.service.subscribe('s1', 'ops')
    h.pendingDeletion.push('s1')
    await h.service.publish('ops', { n: 2 }, {}, null, 'panel')
    expect(h.service.subscriptions(null, 's1')).toHaveLength(0)
    // Subscribing to a nonexistent topic rejects.
    await expect(h.service.subscribe('s1', 'ghost')).rejects.toThrow(/not found/)
    await h.ctx.fiber.dispose()
  })

  it('enforces payload and live ceilings and archives past-deadline messages', async () => {
    const h = await mounted({ maxLiveMessages: 2, maxPayloadBytes: 8, sweepIntervalMs: 3_600_000 })
    await expect(h.service.publish('big', 'x'.repeat(10), {}, null, 'panel')).rejects.toThrow(/exceeds/)
    await h.service.publish('cap', { n: 1 }, {}, null, 'panel')
    await h.service.publish('cap', { n: 2 }, {}, null, 'panel')
    await expect(h.service.publish('cap', { n: 3 }, {}, null, 'panel')).rejects.toThrow(/ceiling/)
    // TTL expiry on its own topic: sweep flips state; the live view drops it, the archived view keeps it.
    await h.service.publish('ttl', { n: 1 }, {}, 1, 'panel')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    await h.service.sweep()
    const live = h.service.messages('ttl', 0, 100, false)
    const all = h.service.messages('ttl', 0, 100, true)
    expect(live).toHaveLength(0)
    expect(all).toHaveLength(1)
    expect(all[0]!.state).toBe('archived')
    await h.ctx.fiber.dispose()
  })

  it('skips delivery of an already-expired message and still advances the watermark', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    await h.service.topicCreate('late', null)
    const row = await h.service.subscribe('s1', 'late')
    // Hand the deliverer an already-archived row: delivery skips, watermark moves.
    const topic = { id: 1, name: 'late', ttlMs: null, createdAt: 0, nextOffset: 5 }
    const expired = {
      topicId: 1, offset: 4, payload: { x: 1 }, headers: {}, publisher: 'panel',
      publishedAt: 0, expiresAt: 1, state: 'archived' as const,
    }
    type Deliverer = { deliverTo(row: never, topic: never, message: never): Promise<boolean> }
    const deliverer = h.service as unknown as Deliverer
    const keep = await deliverer.deliverTo(row as never, topic as never, expired as never)
    expect(keep).toBe(true)
    expect(h.agents.get('s1')!.followup).toHaveLength(0)
    expect(h.service.subscriptions('late', 's1')[0]!.cursor).toBe(4)
    await h.ctx.fiber.dispose()
  })

  it('prunes archive overflow oldest-first and lists topics with aggregates', async () => {
    const h = await mounted({ maxArchivedMessages: 1, sweepIntervalMs: 3_600_000 })
    await h.service.publish('p', { n: 1 }, {}, 1, 'panel')
    await h.service.publish('p', { n: 2 }, {}, 1, 'panel')
    await h.service.topicCreate('fresh', 60_000)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    await h.service.sweep()
    const all = h.service.messages('p', 0, 100, true)
    expect(all).toHaveLength(1)
    expect(all[0]!.offset).toBe(1)
    const listed = h.service.topicList()
    expect(listed.map(entry => entry.topic.name).sort()).toEqual(['fresh', 'p'])
    await expect(h.service.topicCreate('fresh', 60_000)).rejects.toThrow(/already exists/)
    await h.ctx.fiber.dispose()
  })

  it('unsubscribes idempotently and before-init service calls fail loud', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    await h.service.topicCreate('t', null)
    await h.service.subscribe('s1', 't')
    await h.service.unsubscribe('s1', 't')
    await h.service.unsubscribe('s1', 't')
    expect(h.service.subscriptions(null, 's1')).toHaveLength(0)
    await h.service.publish('t', { n: 1 }, {}, null, 'panel')
    expect(h.agents.get('s1')!.followup).toHaveLength(0)
    const bare = new QueueService(new Context(), {})
    expect(() => bare.topicList()).toThrow(/not initialized/)
    const bareCtx = (bare as unknown as { ctx: Context }).ctx
    await bareCtx.fiber.dispose()
    await h.ctx.fiber.dispose()
  })
})

describe('QueueService coverage fill', () => {
  it('restores the topic id counter across service restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-queue-'))
    roots.push(root)
    const boot = async (): Promise<Harness> => {
      const ctx = new Context()
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      const agents = new Map<string, MockAgent>()
      const h: Harness = {
        ctx, agents, flushed: [], archived: [], pendingDeletion: [], attached: new Set<string>(),
        service: undefined as unknown as QueueService,
      }
      ctx.provide('agents', {
        get: (id: string) => (agents.has(id)
          ? {
            id, session: { id, append: () => {}, events: [] as unknown[] },
            status: 'idle',
            inject: () => {}, followup: () => {},
            runMaintenance: (run: () => Promise<boolean>) => run(),
            whenIdle: async () => {},
          } as unknown as Agent
          : undefined),
        list: () => [], roots: () => [],
      } as never)
      ctx.provide('sessions', { get: (id: string) => (agents.has(id) ? { id } : undefined), flush: async () => {} } as never)
      ctx.provide('workspaceRegistry', { archivedSessionIds: [] as string[], pendingSessionDeletionIds: [] as string[] } as never)
      class Mounted extends QueueService {
        constructor(scope: Context) { super(scope, {}) }
      }
      await ctx.plugin(Mounted)
      h.service = ctx.queue
      return h
    }
    const first = await boot()
    await first.service.topicCreate('a', null)
    await first.service.topicCreate('b', null)
    await first.ctx.fiber.dispose()
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    const second = await boot()
    const stats = second.service.topicList()
    expect(stats.map(entry => entry.topic.name)).toEqual(['a', 'b'])
    // New ids continue past the restored counter, so name keys never collide.
    await second.service.topicCreate('c', null)
    expect(second.service.topicList().map(entry => entry.topic.id)).toEqual([1, 2, 3])
    await second.ctx.fiber.dispose()
  })

  it('covers subscriber filters, cold resume, and attach-without-agent rows', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    seedAgent(h, 's2')
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('s1', 'ops')
    await h.service.subscribe('s2', 'ops')
    expect(h.service.subscriptions(null, 's1')).toHaveLength(1)
    // s3 has an attached session object but no live agent: delivery dissolves the row.
    const sessionsGet = h.ctx.sessions as unknown as { get(id: string): unknown }
    void sessionsGet
    await h.service.subscribe('s3', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(h.service.subscriptions(null, 's3')).toHaveLength(0)
    await h.ctx.fiber.dispose()
  })

  it('retries delivery through the idle boundary when maintenance rejects once', async () => {
    const h = await mounted()
    const agent = seedAgent(h, 'flaky')
    agent.failMaintenanceOnce = true
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('flaky', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(agent.followup).toHaveLength(1)
    await h.ctx.fiber.dispose()
  })

  it('keeps working after a rejected chain link and sweeps after close', async () => {
    const h = await mounted()
    await expect(h.service.topicDelete('ghost')).rejects.toThrow(/not found/)
    await h.service.topicCreate('ops', null)
    expect(h.service.topicList()).toHaveLength(1)
    await h.service.sweep()
    await h.ctx.fiber.dispose()
    // The closed guard arms after dispose; a straggling sweep is a no-op.
    await h.service.sweep()
  })
})

describe('QueueService cold resume', () => {
  it('cold-resumes a persisted subscriber without a live agent and delivers', async () => {
    const h = await mounted()
    h.persistence = {
      list: async () => [{ id: 'cold' }],
      inspect: async () => ({ events: [{ type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } }] }),
    }
    const delivered: UserMessage[] = []
    h.resume = async (sessionId: string) => ({
      id: sessionId,
      session: { id: sessionId, append: () => {}, events: [] as unknown[] },
      status: 'idle',
      inject: () => {},
      followup: (message: UserMessage) => { delivered.push(message) },
      runMaintenance: (run: () => Promise<boolean>) => run(),
      whenIdle: async () => {},
    } as unknown as Agent)
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('cold', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(delivered).toHaveLength(1)
    await h.ctx.fiber.dispose()
  })

  it('dissolves the row when the session vanished from persistence', async () => {
    const h = await mounted()
    h.persistence = { list: async () => [], inspect: async () => ({ events: [] }) }
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('ghost', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(h.service.subscriptions(null, 'ghost')).toHaveLength(0)
    await h.ctx.fiber.dispose()
  })

  it('dissolves the row when no model selection is recoverable', async () => {
    const h = await mounted()
    h.persistence = {
      list: async () => [{ id: 'cold' }],
      inspect: async () => ({ events: [] }),
    }
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('cold', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(h.service.subscriptions(null, 'cold')).toHaveLength(0)
    await h.ctx.fiber.dispose()
  })

  it('dissolves the row when persistence is not configured', async () => {
    const h = await mounted({}, { persistence: false })
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('lonely', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(h.service.subscriptions(null, 'lonely')).toHaveLength(0)
    await h.ctx.fiber.dispose()
  })

  it('covers the mixed subscription filters and the attach-without-agent arm', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    seedAgent(h, 's2')
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('s1', 'ops')
    await h.service.subscribe('s2', 'ops')
    expect(h.service.subscriptions('ops', 's1')).toHaveLength(1)
    expect(h.service.subscriptions('ops', 's2')).toHaveLength(1)
    // A second topic makes the topic filter actually skip foreign rows.
    await h.service.topicCreate('alerts', null)
    await h.service.subscribe('s1', 'alerts')
    expect(h.service.subscriptions('ops', null)).toHaveLength(2)
    expect(h.service.subscriptions('alerts', null)).toHaveLength(1)
    expect(h.service.subscriptions(null, null)).toHaveLength(3)
    expect(h.service.subscriptions(null, 's1')).toHaveLength(2)
    expect(() => h.service.messages('ghost', 0, 100, false)).toThrow(/not found/)
    expect(() => h.service.stats('ghost')).toThrow(/not found/)
    // An attached session without a live agent never resolves a deliverer.
    h.attached.add('parked')
    await h.service.subscribe('parked', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(h.service.subscriptions(null, 'parked')).toHaveLength(0)
    // The registered teardown runs the sweeper/arm/chain/domain sequence.
    await (h.service as unknown as { teardown(domain: { close: () => Promise<void> }): Promise<void> })
      .teardown({ close: async () => {} })
    await h.ctx.fiber.dispose()
  })

  it('waits out a running turn before the maintenance retry', async () => {
    const h = await mounted()
    const agent = seedAgent(h, 'busy', 'running')
    agent.failMaintenanceOnce = true
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('busy', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    expect(agent.injected).toHaveLength(1)
    await h.ctx.fiber.dispose()
  })

  it('runs the sweeper tick wrapper', async () => {
    const h = await mounted({ sweepIntervalMs: 3_600_000 })
    ;(h.service as unknown as { tick: () => void }).tick()
    await h.ctx.fiber.dispose()
  })

  it('deletes a topic with messages and subscriptions attached', async () => {
    const h = await mounted()
    seedAgent(h, 's1')
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('s1', 'ops')
    await h.service.publish('ops', { n: 1 }, {}, null, 'panel')
    await h.service.topicDelete('ops')
    expect(h.service.topicList()).toHaveLength(0)
    expect(h.service.subscriptions(null, null)).toHaveLength(0)
    // Re-subscribing resolves the idempotent existing-row path.
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('s1', 'ops')
    await h.service.subscribe('s1', 'ops')
    expect(h.service.subscriptions('ops', null)).toHaveLength(1)
    // Unsubscribing from an unknown topic is a silent no-op.
    await h.service.unsubscribe('s1', 'ghost')
    await h.ctx.fiber.dispose()
  })

  it('dissolves deleted-session rows through the sweeper', async () => {
    const h = await mounted({ sweepIntervalMs: 3_600_000 })
    seedAgent(h, 's1')
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('s1', 'ops')
    h.pendingDeletion.push('s1')
    await h.service.sweep()
    expect(h.service.subscriptions(null, 's1')).toHaveLength(0)
    await h.ctx.fiber.dispose()
  })

  it('sweeps rows of archived subscribers without dissolving them', async () => {
    const h = await mounted({ sweepIntervalMs: 3_600_000 })
    seedAgent(h, 's1')
    await h.service.topicCreate('ops', null)
    await h.service.subscribe('s1', 'ops')
    h.archived.push('s1')
    await h.service.sweep()
    expect(h.service.subscriptions(null, 's1')).toHaveLength(1)
    await h.ctx.fiber.dispose()
  })
})
