import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CgroupRoot } from '../src/cgroup.ts'
import { readFreeBytes, readHostMemory, readHostNet, readProcIo, readProcMemory, scanBuckets } from '../src/proc.ts'
import { parseSsOutput } from '../src/net.ts'
import { MeteringEngine } from '../src/sampler.ts'
import { unionPeers } from '../src/net.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('default internals against the real filesystem', () => {
  it('reads this process through the default /proc internals', async () => {
    const memory = await readProcMemory(process.pid)
    expect(memory.rssBytes).toBeGreaterThan(0)
    const io = await readProcIo(process.pid)
    expect(io.readBytes).toBeGreaterThanOrEqual(0)
    const buckets = await scanBuckets(new Set([process.ppid]), new Set())
    expect(buckets.size).toBeGreaterThanOrEqual(0)
    const host = await readHostMemory()
    expect(host?.memTotalBytes).toBeGreaterThan(0)
    const net = await readHostNet()
    expect(net?.rxBytes).toBeGreaterThan(0)
    const free = await readFreeBytes(process.cwd())
    expect(free).toBeGreaterThan(0)
    await expect(readProcMemory(-1)).resolves.toMatchObject({ rssBytes: 0 })
  })

  it('exercises the default cgroup internals over a writable temp root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-governor-default-'))
    dirs.push(dir)
    const root = new CgroupRoot(dir)
    // A temp directory is writable, so the tier-C machinery engages for real.
    expect(await root.probe()).toBe(true)
    await root.ensureParent(123_456)
    await root.ensureSession('real-session', 65_432)
    await root.attach(4242, 'real-session')
    // Plain filesystems carry no kernel-populated events until written.
    expect(await root.readOomKills('real-session')).toBeUndefined()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(`${dir}/dsh/s-real-session/memory.events`, 'low 0\noom 1\noom_kill 2\n')
    expect(await root.readOomKills('real-session')).toBe(2)
    expect(await root.readPeak('real-session')).toBeUndefined()
    await root.cleanupSession('real-session')
    await root.sweep()
  })

  it('parses ss output against the live socket table', async () => {
    const engine = new MeteringEngine({
      effectiveLimitBytes: () => Number.MAX_SAFE_INTEGER,
      globalLimitBytes: () => Number.MAX_SAFE_INTEGER,
    })
    engine.track('c', 's', 'shell', { pid: process.pid, terminate: () => {} } as never)
    const result = await engine.tick()
    expect(result.t).toBeGreaterThan(0)
    expect(unionPeers([{ bytesSent: 0, bytesReceived: 0, peers: ['a'] }])).toEqual(['a'])
    expect(parseSsOutput('')).toEqual(new Map())
  })

  it('falls back to a dead cgroup root without throwing', async () => {
    const root = new CgroupRoot('/nonexistent-governor-root')
    expect(await root.probe()).toBe(false)
    await root.ensureParent(1)
    await root.ensureSession('s', 1)
    await root.attach(1, 's')
    await expect(root.readOomKills('s')).resolves.toBeUndefined()
    await expect(root.readPeak('s')).resolves.toBeUndefined()
    await root.cleanupSession('s')
    await root.sweep()
  })
})
