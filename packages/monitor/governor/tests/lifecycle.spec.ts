import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import GovernorService from '../src/index.ts'
import type { GovernorInternals } from '../src/index.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

/** Writable in-memory cgroup internals so the service resolves tier C. */
function writableCgroup() {
  const files = new Map<string, string>()
  const dirs = new Set<string>(['/cg'])
  return {
    files,
    internals: {
      mkdir: async (path: string) => {
        const segments = path.split('/').filter(Boolean)
        let prefix = ''
        for (const segment of segments) {
          prefix += `/${segment}`
          dirs.add(prefix)
        }
      },
      readFile: async (path: string) => {
        const content = files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      writeFile: async (path: string, text: string) => {
        files.set(path, text)
      },
      rmdir: async (path: string) => {
        dirs.delete(path)
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${path}/`)) files.delete(key)
        }
      },
      readDir: async (path: string) => {
        const children: string[] = []
        for (const dir of dirs) {
          if (!dir.startsWith(`${path}/`)) continue
          const rest = dir.slice(path.length + 1)
          const entry = rest.split('/')[0]
          if (entry !== undefined && !children.includes(entry)) children.push(entry)
        }
        return children
      },
      accessWrite: async () => true,
    },
  }
}

/** /proc fixture whose single command tree is mutable per test. */
function procFixture(initial: { rssPages: number }) {
  const state = { ...initial }
  let clock = 1_000
  let netReads = 0
  const files = new Map<string, string>([
    ['/proc/700/stat', ['700', '(cmd)', 'S', '1', '700', '700', ...Array<string>(7).fill('0'), '10', '0', ...Array<string>(6).fill('0'), '999', ...Array<string>(10).fill('0')].join(' ')],
    ['/proc/700/statm', `100 ${state.rssPages} 10 5 0 200 0`],
    ['/proc/700/io', 'read_bytes: 0\nwrite_bytes: 0\n'],
  ])
  const dirs = new Map<string, string[]>([['/proc', ['700']], ['/proc/700/fd', []]])
  const refresh = (): void => {
    files.set('/proc/700/statm', `100 ${state.rssPages} 10 5 0 200 0`)
  }
  return {
    state,
    internals: {
      readFile: async (path: string) => {
        if (path === '/proc/net/dev') {
          netReads += 1
          return `Inter-| Receive | Transmit\n face |bytes\n eth0: ${String(100 * netReads)} 0 0 0 0 0 0 0 ${String(50 * netReads)} 0 0 0 0 0 0 0\n`
        }
        const content = files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      readDir: async (path: string) => {
        const entries = dirs.get(path)
        if (entries === undefined) throw new Error('ENOENT')
        return [...entries]
      },
      readLink: async () => {
        throw new Error('ENOENT')
      },
      statfs: async () => ({ bavail: 100, bsize: 4_096 }),
    },
    now: () => clock,
    advance: (rssPages: number): void => {
      state.rssPages = rssPages
      clock += 5
      refresh()
    },
    bumpClock: (): void => {
      clock += 5
    },
  }
}

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Boot the governor over fake /proc + writable cgroup with fast sampling. */
async function boot(memoryLimit: number, proc: ReturnType<typeof procFixture>, cgroup: ReturnType<typeof writableCgroup>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-governor-life-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const sessions = new Map<string, Session>()
  ctx.provide('agents', {
    get: (id: string) => sessions.get(id) === undefined ? undefined : { id, session: sessions.get(id) },
    list: () => [],
    roots: () => [],
  } as never)
  const internals: GovernorInternals = {
    cgroup: cgroup.internals,
    sampler: { internals: proc.internals, now: proc.now },
  }
  // A settings service stub so installSettingsSection attaches its hooks.
  ctx.provide('settings', {
    register: () => ({
      get: () => ({
        memory: { limit: memoryLimit },
        sampling: { baseMs: 5, hotMs: 5 },
        history: { persist: false, resolutionMs: 5_000, retentionMs: 60_000 },
      }),
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }),
  } as never)
  class G extends GovernorService {
    constructor(scope: Context) {
      super(scope, { ...DEFAULT_CONFIG, memory: { limit: memoryLimit }, sampling: { baseMs: 5, hotMs: 5 } }, internals)
    }
  }
  await ctx.plugin(G)
  const create = (id: string): Session => {
    const session = ctx.sessions.create(SessionId(id))
    sessions.set(id, session)
    return session
  }
  const track = (sessionId: string, commandId: string): void => {
    ctx.emit('subprocess/spawned', {
      correlation: { sessionId, commandId, kind: 'shell' },
      handle: { pid: 700, terminate: () => {} },
    } as never)
  }
  const settle = (sessionId: string, commandId: string): void => {
    ctx.emit('subprocess/exited', {
      correlation: { sessionId, commandId, kind: 'shell' },
      handle: { pid: 700 },
      outcome: { exitCode: 0, signal: null },
    } as never)
  }
  return { ctx, service: ctx.governor, create, track, settle, cgroup }
}

describe('GovernorService lifecycle', () => {
  it('resolves tier cgroup and attaches metered spawns with explicit quotas', async () => {
    const proc = procFixture({ rssPages: 1 })
    const cgroup = writableCgroup()
    const boot_ = await boot(1_000_000, proc, cgroup)
    const session = boot_.create('s1')
    await boot_.service.adjustQuota('s1', 500_000, 'board')
    boot_.track('s1', 'c1')
    expect(cgroup.files.get('/sys/fs/cgroup/dsh/s-s1/memory.max')).toBe('500000')
    expect(cgroup.files.get('/sys/fs/cgroup/dsh/memory.max')).toBe('1000000')
    expect(boot_.service.overview().tier).toBe('cgroup')
    expect(boot_.service.limitsFor('s1')).toEqual({ maxMemoryBytes: 500_000 })
    void session
    await boot_.ctx.fiber.dispose()
  })

  it('kills the largest offender after sustained global overage and records the breach', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const proc = procFixture({ rssPages: 100 })
    const cgroup = writableCgroup()
    const boot_ = await boot(90 * 4096, proc, cgroup)
    boot_.create('s1')
    const terminated: string[] = []
    boot_.ctx.emit('subprocess/spawned', {
      correlation: { sessionId: 's1', commandId: 'big', kind: 'shell' },
      handle: { pid: 700, terminate: () => { terminated.push('big') } },
    } as never)
    const breaches: unknown[] = []
    boot_.ctx.on('governor/breach', (breach) => { breaches.push(breach) })
    // Three sustained ticks over budget trigger the watchdog kill.
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(terminated.length).toBeGreaterThan(0)
    expect(breaches.length).toBeGreaterThan(0)
    const breach = boot_.service.breachFor('big')
    expect(breach?.kind).toBe('memory-limit')
    expect(boot_.service.breaches()[0]?.commandId).toBe('big')
    // The hot cadence engaged (rss above 70% of the budget).
    await vi.advanceTimersByTimeAsync(10)
    await boot_.ctx.fiber.dispose()
  })

  it('persists history rows through ticks and answers session samples', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const proc = procFixture({ rssPages: 2 })
    const cgroup = writableCgroup()
    const boot_ = await boot(1_000_000, proc, cgroup)
    boot_.create('s1')
    boot_.track('s1', 'c1')
    await vi.advanceTimersByTimeAsync(20)
    const views = boot_.service.sessionSamples('s1')
    expect(views[0]?.samples.length).toBeGreaterThan(0)
    boot_.settle('s1', 'c1')
    expect(boot_.service.sessionSamples('s1')[0]?.exitedAt).toBeDefined()
    await boot_.ctx.fiber.dispose()
  })

  it('reloads the global budget through the admin verb and re-applies leaves', async () => {
    const proc = procFixture({ rssPages: 1 })
    const cgroup = writableCgroup()
    const boot_ = await boot(1_000_000, proc, cgroup)
    boot_.create('s1')
    await boot_.service.adjustQuota('s1', 500_000, 'board')
    await boot_.service.reload()
    expect(boot_.service.configGet().globalLimitBytes).toBe(1_000_000)
    expect(boot_.service.overview().tier).toBe('cgroup')
    // The Remote read wrappers answer directly.
    expect(boot_.service.sessionQuotaGet('s1').quotaBytes).toBe(500_000)
    await expect(boot_.service.sessionQuotaAdjust('s1', 600_000)).resolves.toMatchObject({ quotaBytes: 600_000 })
    await boot_.ctx.fiber.dispose()
  })

  it('tracks terminal spawns through their own events and settles them', async () => {
    const proc = procFixture({ rssPages: 2 })
    const cgroup = writableCgroup()
    const boot_ = await boot(1_000_000, proc, cgroup)
    boot_.ctx.emit('subprocess/terminal-spawned', {
      correlation: { sessionId: 't1', commandId: 'pty-1', kind: 'terminal' },
      handle: { pid: 700, terminate: () => {} },
    } as never)
    boot_.ctx.emit('subprocess/terminal-exited', {
      correlation: { sessionId: 't1', commandId: 'pty-1', kind: 'terminal' },
      handle: { pid: 700 },
      outcome: { exitCode: 0, signal: null },
    } as never)
    expect(boot_.service.sessionSamples('t1')[0]?.exitedAt).toBeDefined()
    await boot_.ctx.fiber.dispose()
  })

  it('reports a pool session in the overview and kills the largest of two offenders', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const proc = procFixture({ rssPages: 100 })
    const cgroup = writableCgroup()
    const boot_ = await boot(90 * 4096, proc, cgroup)
    boot_.create('pool-session')
    boot_.ctx.emit('subprocess/spawned', {
      correlation: { sessionId: 'pool-session', commandId: 'large', kind: 'shell' },
      handle: { pid: 700, terminate: () => {} },
    } as never)
    boot_.ctx.emit('subprocess/spawned', {
      correlation: { sessionId: 'pool-session', commandId: 'small', kind: 'shell' },
      handle: { pid: -1, terminate: () => {} },
    } as never)
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(10)
    }
    // Post-tick overview carries the host sentinels (fixture /proc/net/dev + statfs).
    expect(boot_.service.overview().hostFreeBytes).toBeGreaterThan(0)
    const driver = boot_.service as unknown as { tick(): Promise<void> }
    await driver.tick()
    await driver.tick()
    expect(boot_.service.overview().hostNetRxBytes).toBeGreaterThan(0)
    process.stdout.write(`POOLDBG breaches=${JSON.stringify(boot_.service.breaches())} overview-pre=${JSON.stringify(boot_.service.overview().liveRssBytes)}\n`)
    const overview = boot_.service.overview()
    const row = overview.sessions.find(item => item.sessionId === 'pool-session')
    expect(row?.quota.shared).toBe(true)
    expect(boot_.service.breachFor('large')?.kind).toBe('memory-limit')
    await boot_.ctx.fiber.dispose()
  })

  it('sweeps history past retention and skips rows inside the resolution window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const proc = procFixture({ rssPages: 2 })
    const cgroup = writableCgroup()
    const root = await mkdtemp(join(tmpdir(), 'dsh-governor-sweep-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('agents', { get: () => undefined, list: () => [], roots: () => [] } as never)
    // Seeded before the plugin so the HMR sweep replays session/created.
    ctx.sessions.create(SessionId('s1'))
    class G extends GovernorService {
      constructor(scope: Context) {
        super(scope, {
          memory: { limit: 1_000_000 },
          sampling: { baseMs: 3_600_000, hotMs: 3_600_000 },
          history: { persist: true, resolutionMs: 5, retentionMs: 0 },
        }, { cgroup: cgroup.internals, sampler: { internals: proc.internals, now: proc.now } })
      }
    }
    await ctx.plugin(G)
    ctx.emit('subprocess/spawned', {
      correlation: { sessionId: 's1', commandId: 'c1', kind: 'shell' },
      handle: { pid: 700, terminate: () => {} },
    } as never)
    // Durable history writes settle on the real event loop, so drive the tick
    // loop directly instead of fake-timer advances.
    const service = ctx.governor as unknown as {
      tickCount: number
      closed: boolean
      sweep(): Promise<void>
      tick(): Promise<void>
      config: { history: { resolutionMs: number } }
    }
    for (let step = 0; step < 3; step += 1) {
      proc.bumpClock()
      await service.tick()
    }
    expect(ctx.governor.sessionSamples('s1')[0]?.samples.length).toBeGreaterThanOrEqual(2)
    // The resolution window skips persisting rows inside the interval.
    service.config.history.resolutionMs = 1_000_000_000
    proc.bumpClock()
    await service.tick()
    // The periodic sweep fires on the 120th tick and retires expired rows.
    service.tickCount = 119
    proc.bumpClock()
    await service.tick()
    await service.sweep()
    // A row newer than the retention window survives the sweep.
    const history = (ctx.governor as unknown as { history: { put(k: string, v: unknown): Promise<void> } }).history
    await history.put('s1|fresh|9999', { sessionId: 's1', commandId: 'fresh', t: Date.now() + 10_000, cpuTicks: 0, rssBytes: 0, readBytes: 0, writeBytes: 0 })
    const mutableConfig = service.config as unknown as { history: { retentionMs: number } }
    mutableConfig.history.retentionMs = 3_600_000
    await service.sweep()
    await ctx.fiber.dispose()
    service.closed = true
    await expect(service.tick()).resolves.toBeUndefined()
  })
})
