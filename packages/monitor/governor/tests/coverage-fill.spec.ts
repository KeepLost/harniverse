import { describe, expect, it } from 'vitest'
import { MeteringEngine } from '../src/sampler.ts'
import { QuotaBook } from '../src/quota.ts'
import type { QuotaOverrideStore } from '../src/quota.ts'
import { parseSsOutput } from '../src/net.ts'
import { readHostMemory, readHostNet, readProcFds, scanBuckets } from '../src/proc.ts'
import type { ProcInternals } from '../src/proc.ts'

const PAGE = 4096
const STAT = (pid: number, pgrp: number, session: number, utime: number, stime: number): string =>
  [String(pid), '(cmd)', 'S', '1', String(pgrp), String(session), ...Array<string>(7).fill('0'), String(utime), String(stime), ...Array<string>(6).fill('0'), '999', ...Array<string>(10).fill('0')].join(' ')

/** Fixture with stat present but every detail read failing. */
const sparseInternals: ProcInternals = {
  readFile: async (path) => {
    if (path === '/proc/31/stat') return STAT(31, 31, 31, 5, 5)
    throw new Error('ENOENT')
  },
  readDir: async (path) => {
    if (path === '/proc') return ['31']
    throw new Error('ENOENT')
  },
  readLink: async () => {
    throw new Error('ENOENT')
  },
  statfs: async () => ({ bavail: 1, bsize: 4_096 }),
}

describe('coverage fill: proc and net arms', () => {
  it('scanBuckets tolerates pids whose detail reads all fail', async () => {
    const buckets = await scanBuckets(new Set([31]), new Set(), sparseInternals)
    expect(buckets.get('pgid:31')).toMatchObject({ cpuTicks: 10, rssBytes: 0, readBytes: 0, fdCount: 0, hasSocket: false })
  })

  it('readProcFds covers the default readLink and the vanished-link catch', async () => {
    const fds = await readProcFds(process.pid)
    expect(fds.count).toBeGreaterThan(0)
    const broken: ProcInternals = {
      readFile: async () => {
        throw new Error('ENOENT')
      },
      readDir: async (path) => {
        if (path === '/proc/5/fd') return ['0']
        throw new Error('ENOENT')
      },
      readLink: async () => {
        throw new Error('ENOENT')
      },
      statfs: async () => ({ bavail: 1, bsize: 4_096 }),
    }
    await expect(readProcFds(5, broken)).resolves.toMatchObject({ count: 1, hasSocket: false })
  })

  it('readHostMemory and readHostNet reject malformed tables to undefined', async () => {
    expect(await readHostMemory(async () => 'nothing here')).toBeUndefined()
    expect(await readHostNet(async () => 'Inter-|\n face\n stray-line-without-colon\n lo: bad fields\n')).toMatchObject({ rxBytes: 0, txBytes: 0 })
  })

  it('parseSsOutput tolerates header rows without a peer column', () => {
    const peerless = parseSsOutput('ESTAB 0 0 only:three\n\t users:(("y",pid=5,fd=1)) cubic')
    expect(peerless.get(5)).toMatchObject({ bytesSent: 0, bytesReceived: 0 })
    expect(peerless.get(5)?.peers).toEqual([])
  })

  it('parseSsOutput skips blank lines, tab-indented info lines, and wildcard peers', () => {
    const text = [
      'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'ESTAB 0 0 1.2.3.4:5 5.6.7.8:9 users:(("t",pid=9,fd=1))',
      '',
      '\t cubic bytes_sent:7 bytes_received:8',
      'LISTEN 0 0 0.0.0.0:80 * users:(("t2",pid=10,fd=2))',
      '\t cubic bytes_sent:1',
    ].join('\n')
    const stats = parseSsOutput(text)
    expect(stats.get(9)).toEqual({ bytesSent: 7, bytesReceived: 8, peers: ['5.6.7.8:9'] })
    expect(stats.get(10)).toEqual({ bytesSent: 1, bytesReceived: 0, peers: [] })
  })
})

describe('coverage fill: sampler arms', () => {
  function world() {
    const files = new Map<string, string>()
    const dirs = new Map<string, string[]>()
    let clock = 1_000
    let netReads = 0
    const refresh = (socket: boolean, utime: number): void => {
      files.set('/proc/44/stat', STAT(44, 44, 44, utime, 0))
      files.set('/proc/44/statm', '10 3 1 1 0 9 0')
      files.set('/proc/44/io', 'read_bytes: 0\nwrite_bytes: 0\n')
      dirs.set('/proc', ['44'])
      dirs.set('/proc/44/fd', socket ? ['0'] : [])
      if (socket) files.set('/proc/44/fd/0', 'socket:[7]')
    }
    return {
      refresh,
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
        readLink: async (path: string) => {
          const link = files.get(path)
          if (link === undefined) throw new Error('ENOENT')
          return link
        },
        statfs: async () => ({ bavail: 1, bsize: 4_096 }),
      } satisfies ProcInternals,
      now: () => clock,
      tick: () => {
        clock += 5
      },
    }
  }

  it('ignores duplicate tracks, unknown settles and terminates, and serves settledViews', async () => {
    const w = world()
    w.refresh(false, 10)
    const engine = new MeteringEngine({
      internals: w.internals,
      now: w.now,
      effectiveLimitBytes: () => Number.MAX_SAFE_INTEGER,
      globalLimitBytes: () => Number.MAX_SAFE_INTEGER,
    })
    const handle = { pid: 44, terminate: () => {} }
    engine.track('dup', 's', 'shell', handle as never)
    engine.track('dup', 's', 'shell', handle as never)
    expect(engine.liveCount).toBe(1)
    expect(engine.settle('missing')).toBeUndefined()
    engine.terminate('missing')
    const view = engine.settle('dup')
    expect(view).toBeDefined()
    expect(engine.settledViews()).toHaveLength(1)
    engine.track('dup2', 's', 'shell', { pid: -1, terminate: () => {} } as never)
    // A dead pid never joins the scan sets; ticks stay empty but total.
    await engine.tick()
    expect(engine.viewsOf('s').length).toBeGreaterThanOrEqual(2)
  })

  it('omits host sentinels when their reads fail', async () => {
    const w = world()
    w.refresh(false, 10)
    const failing: ProcInternals = {
      ...w.internals,
      statfs: async () => {
        throw new Error('ESTALE')
      },
      readFile: async (path) => {
        if (path === '/proc/net/dev') throw new Error('ENOENT')
        return w.internals.readFile(path)
      },
    }
    const engine = new MeteringEngine({
      internals: failing,
      effectiveLimitBytes: () => Number.MAX_SAFE_INTEGER,
      globalLimitBytes: () => Number.MAX_SAFE_INTEGER,
    })
    engine.track('c', 's', 'shell', { pid: 44, terminate: () => {} } as never)
    await engine.tick()
    w.tick()
    const result = await engine.tick()
    expect(result.hostFreeBytes).toBeUndefined()
    expect(result.hostNet).toBeUndefined()
  })

  it('exercises the settled-cap and breach-cap splices and unknown-command breaches', () => {
    const engine = new MeteringEngine({
      effectiveLimitBytes: () => Number.MAX_SAFE_INTEGER,
      globalLimitBytes: () => Number.MAX_SAFE_INTEGER,
    })
    const handle = { pid: -1, terminate: () => {} }
    for (let index = 0; index < 205; index += 1) {
      engine.track(`c${String(index)}`, 's', 'shell', handle as never)
      engine.settle(`c${String(index)}`)
    }
    expect(engine.settledViews().length).toBeLessThanOrEqual(200)
    for (let index = 0; index < 205; index += 1) {
      engine.recordBreach({ kind: 'memory-limit', sessionId: 's', commandId: `b${String(index)}`, at: index })
    }
    expect(engine.recentBreaches().length).toBeLessThanOrEqual(200)
    // A breach naming a command the engine never saw attaches to nothing.
    engine.recordBreach({ kind: 'session-quota', sessionId: 's', commandId: 'ghost', at: 1 })
    expect(engine.breachFor('ghost')).toBeDefined()
  })

  it('runs the default clock, default sustained ticks, and socket baseline reset', async () => {
    const w = world()
    w.refresh(false, 10)
    const engine = new MeteringEngine({
      internals: w.internals,
      effectiveLimitBytes: () => PAGE,
      globalLimitBytes: () => PAGE,
    })
    const handle = { pid: 44, terminate: () => {} }
    engine.track('c', 's', 'shell', handle as never)
    // Default sustainedTicks argument; no overage at huge limits.
    const first = await engine.tick()
    expect(first.overages).toEqual([])
    // Socket appears without a baseline, then vanishes, then reappears.
    w.refresh(true, 10)
    w.tick()
    await engine.tick()
    w.refresh(false, 10)
    w.tick()
    await engine.tick()
    w.refresh(true, 10)
    w.tick()
    const third = await engine.tick()
    expect(third.sessionRss.get('s')).toBeGreaterThan(0)
    // Two successive host reads yield a delta carried on the tick result.
    expect(third.hostNet).toEqual({ rxBytes: 100, txBytes: 50 })
  })
})

describe('coverage fill: quota arms', () => {
  it('loads to empty without a store and survives a rejecting store', async () => {
    const bare = new QuotaBook(() => 1_000)
    expect(bare.load()).toEqual([])
    const store: QuotaOverrideStore = {
      entries: function* () {
        yield ['x', { sessionId: 'x', memoryBytes: 1, updatedAt: 1, reason: 'r' }]
      },
      put: async () => {
        throw new Error('disk full')
      },
      delete: async () => true,
    }
    const book = new QuotaBook(() => 1_000, store)
    expect(book.load()).toHaveLength(1)
    await expect(book.commit('y', 1, 'tool')).rejects.toThrow('disk full')
    // The queue swallowed the rejection; further operations still resolve.
    await expect(book.clear('x')).resolves.toBe(true)
  })
})
