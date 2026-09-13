import { describe, expect, it } from 'vitest'
import { MeteringEngine } from '../src/sampler.ts'
import type { SamplerOptions } from '../src/types.ts'
import type { ResourceSample } from '../src/types.ts'

const PAGE = 4096

/** Fake /proc backing one command tree with mutable counters. */
function fakeProcWorld(initial: { rssPages: number; utime: number; readKb: number; writeKb: number; socket: boolean }) {
  const state = { ...initial }
  let clock = 1_000
  const files = new Map<string, string>()
  const dirs = new Map<string, string[]>([['/proc', ['700']]])
  const refresh = (): void => {
    files.set('/proc/700/stat', ['700', '(cmd)', 'S', '1', '700', '700', ...Array<string>(7).fill('0'), String(state.utime), '0', ...Array<string>(6).fill('0'), '999', ...Array<string>(10).fill('0')].join(' '))
    files.set('/proc/700/statm', `100 ${state.rssPages} 10 5 0 200 0`)
    files.set('/proc/700/io', `rchar: 1\nwchar: 2\nread_bytes: ${state.readKb * 1024}\nwrite_bytes: ${state.writeKb * 1024}\n`)
    dirs.set('/proc/700/fd', state.socket ? ['0'] : [])
    if (state.socket) files.set('/proc/700/fd/0', 'socket:[5]')
  }
  refresh()
  let ssCalls = 0
  const options = {
    now: () => clock,
    internals: {
      readFile: async (path: string) => {
        const content = files.get(path)
        if (content === undefined) throw new Error(`ENOENT ${path}`)
        return content
      },
      readDir: async (path: string) => {
        const entries = dirs.get(path)
        if (entries === undefined) throw new Error(`ENOENT ${path}`)
        return [...entries]
      },
      readLink: async (path: string) => {
        const link = files.get(path)
        if (link === undefined) throw new Error(`ENOENT ${path}`)
        return link
      },
      statfs: async () => ({ bavail: 10, bsize: 4096 }),
    },
    execSs: () => {
      ssCalls += 1
      const sent = 3_000 * ssCalls
      const received = 6_000 * ssCalls
      return `State Recv-Q Send-Q Local Peer Process\nESTAB 0 0 1.2.3.4:5 9.9.9.9:443 users:(("cmd",pid=700,fd=0))\n\t cubic bytes_sent:${sent} bytes_acked:${sent} bytes_received:${received}\n`
    },
  }
  return {
    options,
    state,
    advance: (delta: { rssPages?: number; utime?: number; readKb?: number; writeKb?: number; ms?: number }): void => {
      state.rssPages += delta.rssPages ?? 0
      state.utime += delta.utime ?? 0
      state.readKb += delta.readKb ?? 0
      state.writeKb += delta.writeKb ?? 0
      clock += delta.ms ?? 1_000
      refresh()
    },
  }
}

function fakeHandle(terminateCalls = { count: 0 }): { pid: number; terminate(): void } {
  return {
    pid: 700,
    terminate: () => {
      terminateCalls.count += 1
    },
  }
}

function baseOptions(world: ReturnType<typeof fakeProcWorld>): SamplerOptions {
  return {
    ...world.options,
    effectiveLimitBytes: () => Number.MAX_SAFE_INTEGER,
    globalLimitBytes: () => Number.MAX_SAFE_INTEGER,
  }
}

describe('MeteringEngine', () => {
  it('tracks, samples with cpu/io deltas, and settles into views', async () => {
    const world = fakeProcWorld({ rssPages: 10, utime: 100, readKb: 1, writeKb: 2, socket: false })
    const engine = new MeteringEngine(baseOptions(world))
    engine.track('c1', 's1', 'shell', fakeHandle() as never)
    const first = await engine.tick()
    expect(first.liveCommandCount).toBe(1)
    expect(first.sessionRss.get('s1')).toBe(10 * PAGE)
    // The first tick only baselines CPU and IO deltas.
    const firstSample = engine.viewsOf('s1')[0]?.samples[0]
    expect(firstSample?.cpuTicks).toBe(0)
    world.advance({ utime: 25, readKb: 3, writeKb: 4 })
    await engine.tick()
    const view = engine.viewsOf('s1')[0]
    const samples: readonly ResourceSample[] = view?.samples ?? []
    expect(samples).toHaveLength(2)
    expect(samples[1]).toMatchObject({ cpuTicks: 25, rssBytes: 10 * PAGE, readBytes: 3 * 1024, writeBytes: 4 * 1024, fdCount: 0 })
    const settled = engine.settle('c1')
    expect(settled?.exitedAt).toBeDefined()
    expect(settled?.totalCpuTicks).toBe(25)
    expect(settled?.totalReadBytes).toBe(3 * 1024)
    expect(engine.liveCount).toBe(0)
    expect(engine.settle('c1')).toBeUndefined()
  })

  it('attributes TCP bytes only while tree members own sockets', async () => {
    const world = fakeProcWorld({ rssPages: 5, utime: 0, readKb: 0, writeKb: 0, socket: true })
    const engine = new MeteringEngine(baseOptions(world))
    engine.track('c1', 's1', 'shell', fakeHandle() as never)
    await engine.tick()
    world.advance({})
    await engine.tick()
    const view = engine.viewsOf('s1')[0]
    const sample = view?.samples.at(-1)
    expect(sample?.netTxBytes).toBe(3_000)
    expect(sample?.netRxBytes).toBe(6_000)
    // Socket gone: attribution resets and later samples carry no net fields.
    world.state.socket = false
    world.advance({})
    await engine.tick()
    expect(engine.viewsOf('s1')[0]?.samples.at(-1)?.netTxBytes).toBeUndefined()
  })

  it('reports session and global overages only after sustained ticks and terminates the largest command', async () => {
    const world = fakeProcWorld({ rssPages: 100, utime: 0, readKb: 0, writeKb: 0, socket: false })
    const calls = { count: 0 }
    const options: SamplerOptions = {
      ...world.options,
      effectiveLimitBytes: () => 90 * PAGE,
      globalLimitBytes: () => 200 * PAGE,
    }
    const engine = new MeteringEngine(options)
    engine.track('big', 's1', 'shell', fakeHandle(calls) as never)
    await engine.tick()
    expect((await engine.tick()).overages).toHaveLength(0)
    const third = await engine.tick()
    expect(third.overages).toEqual([{ sessionId: 's1', scope: 'session', limitBytes: 90 * PAGE, observedBytes: 100 * PAGE }])
    expect(calls.count).toBe(0)
    const breach = { kind: 'session-quota' as const, sessionId: 's1', commandId: 'big', peakBytes: 100 * PAGE, limitBytes: 90 * PAGE, at: 3_000 }
    engine.recordBreach(breach)
    engine.terminate('big')
    expect(calls.count).toBe(1)
    expect(engine.breachFor('big')).toEqual(breach)
    expect(engine.breachFor('other')).toBeUndefined()
  })

  it('caps the ring and exposes recent breaches newest-first', async () => {
    const world = fakeProcWorld({ rssPages: 1, utime: 0, readKb: 0, writeKb: 0, socket: false })
    const engine = new MeteringEngine(baseOptions(world))
    engine.track('c1', 's1', 'shell', fakeHandle() as never)
    for (let index = 0; index < 130; index += 1) {
      world.advance({ utime: 1 })
      await engine.tick()
    }
    expect(engine.viewsOf('s1')[0]?.samples.length).toBeLessThanOrEqual(120)
    engine.recordBreach({ kind: 'memory-limit', sessionId: 's1', commandId: 'c1', at: 1 })
    engine.recordBreach({ kind: 'session-quota', sessionId: 's2', commandId: 'c2', at: 2 })
    expect(engine.recentBreaches()[0]?.commandId).toBe('c2')
  })

  it('buckets terminal commands by POSIX session id', async () => {
    const world = fakeProcWorld({ rssPages: 2, utime: 0, readKb: 0, writeKb: 0, socket: false })
    const engine = new MeteringEngine(baseOptions(world))
    engine.track('t1', 's1', 'terminal', fakeHandle() as never)
    const result = await engine.tick()
    expect(result.sessionRss.get('s1')).toBe(2 * PAGE)
    engine.settle('t1')
    expect(engine.viewsOf('s1')).toHaveLength(1)
  })
})
