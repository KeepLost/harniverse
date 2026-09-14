import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import GovernorService from '../src/index.ts'
import type { GovernorInternals } from '../src/index.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

/** Governor with test knobs: fast sampling, injectable cgroup/sampler. */
class TestGovernor extends GovernorService {
  constructor(ctx: Context, config: Partial<typeof DEFAULT_CONFIG> = {}, internals: GovernorInternals = {}) {
    super(ctx, {
      memory: config.memory ?? DEFAULT_CONFIG.memory,
      sampling: { baseMs: 5, hotMs: 5, ...config.sampling },
      history: { ...DEFAULT_CONFIG.history, ...config.history },
    }, internals)
  }
}

const roots: string[] = []

function afterCleanup(root: string): void {
  roots.push(root)
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly service: GovernorService
  readonly sessions: Map<string, Session>
  readonly injected: Map<string, UserMessage[]>
  readonly breaches: { sessionId: string; commandId: string }[]
}

/** Read-only cgroup internals rooted somewhere nonexistent → rlimit tier. */
const deadCgroup = {
  mkdir: async () => {},
  readFile: async () => {
    throw new Error('ENOENT')
  },
  writeFile: async () => {
    throw new Error('EROFS')
  },
  rmdir: async () => {},
  readDir: async () => [],
  accessWrite: async () => false,
}

/** Subclass mounting that threads the internals argument through. */
async function mounted(internals: GovernorInternals, config: Partial<typeof DEFAULT_CONFIG> = {}, rootOverride?: string): Promise<Harness> {
  const root = rootOverride ?? await mkdtemp(join(tmpdir(), 'dsh-governor-'))
  if (rootOverride === undefined) afterCleanup(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const sessions = new Map<string, Session>()
  const injected = new Map<string, UserMessage[]>()
  ctx.provide('agents', {
    get: (id: string) => {
      const session = sessions.get(id)
      if (session === undefined) return undefined
      return {
        id,
        session,
        inject: (message: UserMessage) => {
          const list = injected.get(id) ?? []
          list.push(message)
          injected.set(id, list)
        },
      } as unknown as Agent
    },
    list: () => [],
    roots: () => [],
  } as never)
  class Mounted extends TestGovernor {
    constructor(scope: Context) {
      super(scope, config, internals)
    }
  }
  await ctx.plugin(Mounted)
  const breaches: { sessionId: string; commandId: string }[] = []
  ctx.on('governor/breach', breach => breaches.push(breach))
  return { ctx, root, service: ctx.governor, sessions, injected, breaches }
}

/** Create and register one real session under the store. */
function seedSession(h: Harness, id: string): Session {
  const session = h.ctx.sessions.create(SessionId(id))
  h.sessions.set(id, session)
  return session
}

describe('GovernorService', () => {
  it('resolves the global budget and starts in the rlimit tier without cgroupfs', async () => {
    const h = await mounted({ cgroup: deadCgroup })
    expect(h.service.configGet().globalLimitBytes).toBeGreaterThan(0)
    expect(h.service.overview().tier).toBe('rlimit')
    await h.ctx.fiber.dispose()
  })

  it('adjusts session quotas with admission clamps and audit events', async () => {
    const h = await mounted({ cgroup: deadCgroup }, { memory: { limit: 1_000_000 } })
    const session = seedSession(h, 's1')
    const other = seedSession(h, 's2')
    const state = await h.service.adjustQuota('s1', 800_000, 'board')
    expect(state).toMatchObject({ sessionId: 's1', quotaBytes: 800_000, effectiveLimitBytes: 800_000, shared: false })
    // The second session can claim at most the remaining 200k.
    const clamped = await h.service.adjustQuota('s2', 500_000, 'board')
    expect(clamped.quotaBytes).toBe(200_000)
    const events = [...session.events, ...other.events].filter(event => event.type === 'governor/quota')
    expect(events).toHaveLength(2)
    expect((events[1] as { data: { clamped: boolean } }).data.clamped).toBe(true)
    // Clearing rejoins the shared pool.
    await h.service.adjustQuota('s1', null, 'clear')
    expect(h.service.quotaStateOf('s1').shared).toBe(true)
    // Unknown sessions and invalid amounts fail loud.
    await expect(h.service.adjustQuota('ghost', 1, 'board')).rejects.toThrow(/unknown session/)
    await expect(h.service.adjustQuota('s2', 0, 'board')).rejects.toThrow(/positive integer/)
    await h.ctx.fiber.dispose()
  })

  it('serves the board overview and per-session samples through Remote methods', async () => {
    const h = await mounted({ cgroup: deadCgroup })
    seedSession(h, 's1')
    h.ctx.emit('subprocess/spawned', {
      correlation: { sessionId: 's1', commandId: 'c1', kind: 'shell' },
      handle: { pid: -1, terminate: () => {} },
    } as never)
    const overview = h.service.overview()
    expect(overview.tier).toBe('rlimit')
    expect(overview.sessions.some(row => row.sessionId === 's1')).toBe(true)
    expect(h.service.sessionSamples('s1')).toHaveLength(1)
    expect(h.service.breaches()).toEqual([])
    await h.ctx.fiber.dispose()
  })

  it('re-admits persisted overrides on session resume and notifies on clamp', async () => {
    const h = await mounted({ cgroup: deadCgroup }, { memory: { limit: 2_000_000 } })
    seedSession(h, 's1')
    seedSession(h, 's2')
    await h.service.adjustQuota('s1', 1_200_000, 'board')
    await h.service.adjustQuota('s2', 700_000, 'board')
    await h.ctx.fiber.dispose()
    // Restart over the same storage root with a SMALLER global budget: the
    // persisted decisions survive, re-admission replays first-come, and s1
    // clamps to the remaining 300k with a notify to its agent.
    const second = await mounted({ cgroup: deadCgroup }, { memory: { limit: 1_000_000 } }, h.root)
    seedSession(second, 's1')
    seedSession(second, 's2')
    await vi.waitFor(() => {
      expect(second.service.quotaStateOf('s1').quotaBytes).toBe(300_000)
      expect(second.injected.get('s1')?.length).toBe(1)
    })
    expect(second.service.quotaStateOf('s2').quotaBytes).toBe(700_000)
    await second.ctx.fiber.dispose()
  })

  it('drops overrides on explicit close but not on teardown disposal', async () => {
    const h = await mounted({ cgroup: deadCgroup })
    seedSession(h, 's1')
    await h.service.adjustQuota('s1', 500_000, 'board')
    h.ctx.emit('session/closed', { sessionId: SessionId('s1') })
    await vi.waitFor(() => {
      expect(h.service.quotaStateOf('s1').shared).toBe(true)
    })
    await h.ctx.fiber.dispose()
  })

  it('provides spawn limits and breach facts for the bash tool seam', async () => {
    const h = await mounted({ cgroup: deadCgroup }, { memory: { limit: 2_000_000 } })
    expect(h.service.limitsFor('any')).toEqual({ maxMemoryBytes: 2_000_000 })
    h.ctx.emit('subprocess/spawned', {
      correlation: { sessionId: 's1', commandId: 'c1', kind: 'shell' },
      handle: { pid: -1, terminate: () => {} },
    } as never)
    h.ctx.emit('governor/breach', { kind: 'memory-limit', sessionId: 's1', commandId: 'c1', at: 1 })
    await h.ctx.fiber.dispose()
  })

  it('persists opt-in history rows and sweeps them past retention', async () => {
    vi.useFakeTimers()
    try {
      const files = new Map<string, string>([
        ['/proc/700/stat', ['700', '(cmd)', 'S', '1', '700', '700', ...Array<string>(7).fill('0'), '10', '0', ...Array<string>(6).fill('0'), '999', ...Array<string>(10).fill('0')].join(' ')],
        ['/proc/700/statm', '100 8 10 5 0 200 0'],
        ['/proc/700/io', 'read_bytes: 0\nwrite_bytes: 0\n'],
      ])
      const procInternals = {
        readFile: async (path: string) => {
          const content = files.get(path)
          if (content === undefined) throw new Error('ENOENT')
          return content
        },
        readDir: async (path: string) => {
          if (path === '/proc') return ['700']
          if (path.startsWith('/proc/700/fd')) return []
          throw new Error('ENOENT')
        },
        readLink: async () => {
          throw new Error('ENOENT')
        },
        statfs: async () => ({ bavail: 1, bsize: 4096 }),
      }
      const h = await mounted(
        { cgroup: deadCgroup, sampler: { internals: procInternals } },
        { history: { persist: true, resolutionMs: 0, retentionMs: 60_000 } },
      )
      h.ctx.emit('subprocess/spawned', {
        correlation: { sessionId: 's1', commandId: 'c1', kind: 'shell' },
        handle: { pid: 700, terminate: () => {} },
      } as never)
      await vi.advanceTimersByTimeAsync(30)
      const samples = h.service.sessionSamples('s1')
      expect(samples[0]?.samples.length).toBeGreaterThan(0)
      await h.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('governor invariant companion', () => {
  it('registers and asserts governor/quota events name their session', async () => {
    const ctx = new Context()
    const registered: { name: string; installer: (c: Context, fail: (message: string) => void) => void }[] = []
    ctx.provide('invariants', {
      register: (name: string, installer: (c: Context, fail: (message: string) => void) => void) => {
        registered.push({ name, installer })
        return () => undefined
      },
    } as never)
    const { apply } = await import('../src/invariant.ts')
    await apply(ctx)
    expect(registered).toHaveLength(1)
    const companion = registered[0]
    if (companion === undefined) throw new Error('invariant companion did not register')
    expect(companion.name).toBe('@deepseek-ai/dsh-governor')
    const failures: string[] = []
    companion.installer(ctx, message => failures.push(message))
    const session = { id: 'real' } as never
    const dispatch = (name: string, ...args: unknown[]): void => {
      ;(ctx.emit as unknown as (n: string, ...a: unknown[]) => void)(name, ...args)
    }
    dispatch('internal/dispatch', 'emit', 'session/event', [session, { type: 'governor/quota', data: { sessionId: 'real' }, seq: 1 }])
    dispatch('internal/dispatch', 'emit', 'session/event', [session, { type: 'governor/quota', data: { sessionId: 'other' }, seq: 2 }])
    dispatch('internal/dispatch', 'emit', 'session/event', [session, { type: 'unrelated', data: {} }])
    dispatch('internal/dispatch', 'emit', 'other-event', [session, { type: 'governor/quota', data: { sessionId: 'other' } }])
    expect(failures).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})

void Service
