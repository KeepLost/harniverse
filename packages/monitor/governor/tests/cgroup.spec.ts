import { describe, expect, it } from 'vitest'
import { CgroupRoot } from '../src/cgroup.ts'
import type { CgroupInternals } from '../src/cgroup.ts'

/** In-memory cgroup filesystem with POSIX-ish failure modes. */
function fakeCgroup(): { internals: CgroupInternals; files: Map<string, string>; writable: { value: boolean } } {
  const files = new Map<string, string>()
  const dirs = new Set<string>(['/cg'])
  const writable = { value: true }
  const internals: CgroupInternals = {
    mkdir: async (path) => {
      if (!writable.value) throw new Error('EROFS')
      const segments = path.split('/').filter(Boolean)
      let prefix = ''
      for (const segment of segments) {
        prefix += `/${segment}`
        dirs.add(prefix)
      }
    },
    readFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error('ENOENT')
      return content
    },
    writeFile: async (path, text) => {
      if (!writable.value) throw new Error('EROFS')
      files.set(path, text)
    },
    rmdir: async (path) => {
      if (!writable.value || !dirs.has(path)) throw new Error('EBUSY')
      dirs.delete(path)
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${path}/`)) files.delete(key)
      }
    },
    readDir: async (path) => {
      const children: string[] = []
      for (const dir of dirs) {
        if (!dir.startsWith(`${path}/`)) continue
        const rest = dir.slice(path.length + 1)
        const entry = rest.split('/')[0]
        if (entry !== undefined && !children.includes(entry)) children.push(entry)
      }
      return children
    },
    accessWrite: async () => writable.value,
  }
  return { internals, files, writable }
}

describe('CgroupRoot', () => {
  it('probes false and turns every operation into a no-op', async () => {
    const { internals, files, writable } = fakeCgroup()
    writable.value = false
    const root = new CgroupRoot('/cg', internals)
    expect(await root.probe()).toBe(false)
    await root.ensureParent(1_000)
    await root.ensureSession('s1', 500)
    await root.attach(42, 's1')
    await root.cleanupSession('s1')
    await root.sweep()
    expect(files.size).toBe(0)
  })

  it('ensures the parent with the global budget and swap off', async () => {
    const { internals, files } = fakeCgroup()
    const root = new CgroupRoot('/cg', internals)
    await root.ensureParent(9_000)
    expect(files.get('/cg/dsh/memory.max')).toBe('9000')
    expect(files.get('/cg/dsh/memory.swap.max')).toBe('0')
  })

  it('degrades to non-writable when writes start failing', async () => {
    const { internals, files, writable } = fakeCgroup()
    const root = new CgroupRoot('/cg', internals)
    writable.value = true
    await root.probe()
    writable.value = false
    await root.ensureParent(9_000)
    expect(files.size).toBe(0)
    expect(await root.probe()).toBe(false)
  })

  it('creates session leaves with quotas and attaches processes', async () => {
    const { internals, files } = fakeCgroup()
    const root = new CgroupRoot('/cg', internals)
    await root.ensureSession('abc-1', 5_000)
    expect(files.get('/cg/dsh/s-abc-1/memory.max')).toBe('5000')
    await root.attach(77, 'abc-1')
    expect(files.get('/cg/dsh/s-abc-1/cgroup.procs')).toBe('77')
    await root.attach(88, undefined)
    expect(files.get('/cg/dsh/cgroup.procs')).toBe('88')
  })

  it('rejects unsafe session ids without touching the filesystem', async () => {
    const { internals, files } = fakeCgroup()
    const root = new CgroupRoot('/cg', internals)
    await root.ensureSession('../escape', 1)
    await root.attach(1, '../escape')
    await expect(root.readOomKills('../escape')).resolves.toBeUndefined()
    await expect(root.readPeak('../escape')).resolves.toBeUndefined()
    expect([...files.keys()].some(key => key.includes('escape'))).toBe(false)
  })

  it('reads oom events and peaks from session leaves', async () => {
    const { internals, files } = fakeCgroup()
    const root = new CgroupRoot('/cg', internals)
    await root.ensureSession('s9', 5_000)
    files.set('/cg/dsh/s-s9/memory.events', 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 2\n')
    files.set('/cg/dsh/s-s9/memory.peak', '123456789\n')
    expect(await root.readOomKills('s9')).toBe(2)
    expect(await root.readPeak('s9')).toBe(123_456_789)
    files.set('/cg/dsh/s-s9/memory.events', 'low 0\n')
    expect(await root.readOomKills('s9')).toBe(0)
    files.set('/cg/dsh/s-s9/memory.peak', 'garbage')
    expect(await root.readPeak('s9')).toBeUndefined()
  })

  it('cleans up session leaves and sweeps everything at boot', async () => {
    const { internals, files } = fakeCgroup()
    const root = new CgroupRoot('/cg', internals)
    await root.ensureSession('gone', 5_000)
    await root.ensureSession('stay', 5_000)
    await root.cleanupSession('gone')
    expect(files.get('/cg/dsh/s-gone/memory.max')).toBeUndefined()
    expect(files.get('/cg/dsh/s-stay/memory.max')).toBe('5000')
    // A stale leaf from a previous boot; the boot sweep removes every leaf.
    await root.ensureSession('stale', 1)
    await root.sweep()
    expect([...files.keys()].some(key => key.includes('stale'))).toBe(false)
    expect([...files.keys()].some(key => key.includes('s-stay'))).toBe(false)
  })
})
