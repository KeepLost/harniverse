import { describe, expect, it } from 'vitest'
import type { ProcInternals } from '../src/proc.ts'
import { parseProcStat } from '../src/proc.ts'
import { readFreeBytes, readHostMemory, readHostNet, readProcFds, readProcIo, readProcMemory, scanBuckets } from '../src/proc.ts'

/** Build a fake /proc tree from per-pid fixture maps. */
function fakeProc(
  files: Record<string, string>,
  dirs: Record<string, string[]> = {},
  statfsResult?: { bavail: number; bsize: number },
): ProcInternals {
  return {
    readFile: async (path) => {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT ${path}`)
      return content
    },
    readDir: async (path) => {
      const entries = dirs[path]
      if (entries === undefined) throw new Error(`ENOENT ${path}`)
      return entries
    },
    readLink: async (path) => {
      const link = files[path]
      if (link === undefined) throw new Error(`ENOENT ${path}`)
      return link
    },
    statfs: async () => {
      if (statfsResult === undefined) throw new Error('ESTALE')
      return statfsResult
    },
  }
}

/** Kernel stat layout built token-wise: fields 3.. map to rest[0..]. */
const STAT_LINE = (pid: number, pgrp: number, session: number, utime = 10, stime = 5): string =>
  [`${pid}`, '(a comm)', 'S', '1', String(pgrp), String(session), ...Array<string>(7).fill('0'), String(utime), String(stime), ...Array<string>(6).fill('0'), '123456', ...Array<string>(10).fill('0')].join(' ')

describe('parseProcStat', () => {
  it('parses fields after a comm containing spaces and parentheses', () => {
    const stat = parseProcStat(['12', '(python3 (venv))', 'S', '1', '12', '12', ...Array<string>(7).fill('0'), '20', '10', ...Array<string>(6).fill('0'), '99', ...Array<string>(10).fill('0')].join(' '))
    expect(stat).toEqual({ pid: 12, pgrp: 12, session: 12, state: 'S', utime: 20, stime: 10, starttime: 99 })
  })

  it('returns undefined for malformed lines', () => {
    expect(parseProcStat('nonsense')).toBeUndefined()
    expect(parseProcStat('12 (comm) X no numbers here')).toBeUndefined()
  })
})

describe('scanBuckets', () => {
  it('aggregates pgid and sid buckets with memory, io, and fd details', async () => {
    const internals = fakeProc(
      {
        '/proc/10/stat': STAT_LINE(10, 10, 10),
        '/proc/11/stat': STAT_LINE(11, 10, 10, 30, 20),
        '/proc/20/stat': STAT_LINE(20, 99, 20),
        '/proc/10/statm': '100 50 10 5 0 200 0',
        '/proc/11/statm': '100 25 10 5 0 200 0',
        '/proc/20/statm': '100 10 10 5 0 200 0',
        '/proc/10/smaps_rollup': 'Rss:\t50 kB\nPss:\t40 kB\n',
        '/proc/11/smaps_rollup': 'Rss:\t25 kB\nPss:\t20 kB\n',
        '/proc/20/smaps_rollup': 'Rss:\t10 kB\nPss:\t8 kB\n',
        '/proc/10/io': 'rchar: 1\nwchar: 2\nread_bytes: 1000\nwrite_bytes: 2000\n',
        '/proc/11/io': 'rchar: 1\nwchar: 2\nread_bytes: 4000\nwrite_bytes: 8000\n',
        '/proc/20/io': 'rchar: 1\nwchar: 2\nread_bytes: 500\nwrite_bytes: 500\n',
        '/proc/10/fd/0': 'socket:[123]',
        '/proc/10/fd/1': '/dev/null',
        '/proc/11/fd/0': 'pipe:[9]',
        '/proc/20/fd/3': 'anon_inode:foo',
      },
      {
        '/proc': ['10', '11', '20', 'cpuinfo'],
        '/proc/10/fd': ['0', '1'],
        '/proc/11/fd': ['0'],
        '/proc/20/fd': ['3'],
      },
    )
    const buckets = await scanBuckets(new Set([10]), new Set([20]), internals)
    expect(buckets.get('pgid:10')).toEqual({
      pids: [10, 11],
      cpuTicks: 65,
      rssBytes: 75 * 4096,
      readBytes: 5000,
      writeBytes: 10_000,
      fdCount: 3,
      hasSocket: true,
    })
    expect(buckets.get('sid:20')).toEqual({
      pids: [20],
      cpuTicks: 15,
      rssBytes: 10 * 4096,
      readBytes: 500,
      writeBytes: 500,
      fdCount: 1,
      hasSocket: false,
    })
  })

  it('returns empty on an unreadable /proc and skips unreadable pids', async () => {
    const empty = await scanBuckets(new Set([1]), new Set(), fakeProc({}, {}))
    expect(empty.size).toBe(0)
    const internals = fakeProc(
      { '/proc/10/stat': 'garbage without paren' },
      { '/proc': ['10'] },
    )
    const buckets = await scanBuckets(new Set([10]), new Set(), internals)
    expect(buckets.size).toBe(0)
    // A listed pid whose stat read throws is skipped by the catch arm.
    const unreadable = fakeProc({}, { '/proc': ['12'] })
    expect(await scanBuckets(new Set([12]), new Set(), unreadable).then(result => result.size)).toBe(0)
  })

  it('attributes one pid to both a pgid and a sid bucket when both match', async () => {
    const internals = fakeProc(
      {
        '/proc/10/stat': STAT_LINE(10, 10, 10),
        '/proc/10/statm': '10 2 1 1 0 5 0',
        '/proc/10/io': 'read_bytes: 0\nwrite_bytes: 0\n',
      },
      { '/proc': ['10'], '/proc/10/fd': [] },
    )
    const buckets = await scanBuckets(new Set([10]), new Set([10]), internals)
    expect(buckets.get('pgid:10')?.pids).toEqual([10])
    expect(buckets.get('sid:10')?.pids).toEqual([10])
  })
})

describe('detail readers', () => {
  it('readProcMemory returns RSS plus PSS when the rollup parses', async () => {
    const internals = fakeProc({
      '/proc/5/statm': '10 3 1 1 0 9 0',
      '/proc/5/smaps_rollup': 'Rss:\t12 kB\nPss:\t7 kB\n',
    })
    expect(await readProcMemory(5, internals)).toEqual({ rssBytes: 3 * 4096, pssBytes: 7 * 1024 })
  })

  it('readProcMemory tolerates a missing rollup and a broken statm', async () => {
    expect(await readProcMemory(5, fakeProc({ '/proc/5/statm': '10 3 1 1 0 9 0' }))).toEqual({ rssBytes: 3 * 4096 })
    expect(await readProcMemory(5, fakeProc({ '/proc/5/statm': '10 3 1 1 0 9 0', '/proc/5/smaps_rollup': 'Rss:\t12 kB\n' }))).toEqual({ rssBytes: 3 * 4096 })
    expect(await readProcMemory(5, fakeProc({ '/proc/5/statm': 'nope' }))).toEqual({ rssBytes: 0 })
  })

  it('readProcIo parses counters and defaults missing fields to zero', async () => {
    expect(await readProcIo(5, fakeProc({ '/proc/5/io': 'read_bytes: 7\nwrite_bytes: 9\n' }))).toEqual({ readBytes: 7, writeBytes: 9 })
    expect(await readProcIo(5, fakeProc({ '/proc/5/io': '' }))).toEqual({ readBytes: 0, writeBytes: 0 })
  })

  it('readProcFds counts descriptors and detects sockets through links', async () => {
    const internals = fakeProc(
      { '/proc/5/fd/0': 'socket:[1]', '/proc/5/fd/1': 'pipe:[2]' },
      { '/proc/5/fd': ['0', '1'] },
    )
    expect(await readProcFds(5, internals)).toEqual({ count: 2, hasSocket: true })
    const plain = fakeProc({ '/proc/5/fd/0': 'pipe:[2]' }, { '/proc/5/fd': ['0'] })
    expect(await readProcFds(5, plain)).toEqual({ count: 1, hasSocket: false })
  })

  it('readProcFds tolerates links vanishing mid-walk', async () => {
    const internals = fakeProc(
      { '/proc/5/fd/0': 'socket:[1]', '/proc/5/fd/1': 'pipe:[2]', '/proc/5/fd/2': 'socket:[3]' },
      { '/proc/5/fd': ['0', '1', '2'] },
    )
    expect(await readProcFds(5, internals)).toEqual({ count: 3, hasSocket: true })
  })
})

describe('host readers', () => {
  it('readHostMemory layers MemTotal with the own-cgroup ceiling', async () => {
    const read = async (path: string) => {
      if (path === '/proc/meminfo') return 'MemTotal: 1048576 kB\nCached: 1 kB\n'
      if (path === '/sys/fs/cgroup/memory.max') return '1073741824\n'
      throw new Error('ENOENT')
    }
    expect(await readHostMemory(read)).toEqual({ memTotalBytes: 1024 * 1024 * 1024, ownCgroupMaxBytes: 1_073_741_824 })
    const readNoCgroup = async (path: string) => {
      if (path === '/proc/meminfo') return 'MemTotal: 1048576 kB\n'
      throw new Error('ENOENT')
    }
    expect(await readHostMemory(readNoCgroup)).toEqual({ memTotalBytes: 1024 * 1024 * 1024 })
    expect(await readHostMemory(async () => {
      throw new Error('ENOENT')
    })).toBeUndefined()
  })

  it('readHostMemory treats the `max` sentinel as absent', async () => {
    const read = async (path: string) => {
      if (path === '/proc/meminfo') return 'MemTotal: 1048576 kB\n'
      if (path === '/sys/fs/cgroup/memory.max') return 'max\n'
      throw new Error('ENOENT')
    }
    expect(await readHostMemory(read)).toEqual({ memTotalBytes: 1024 * 1024 * 1024 })
  })

  it('readHostNet sums interface counters', async () => {
    const read = async (path: string) => {
      if (path === '/proc/net/dev') return 'Inter-| Receive | Transmit\n face |bytes ... \n lo: 100 0 0 0 0 0 0 0 50 0 0 0 0 0 0 0\n eth0: 200 0 0 0 0 0 0 0 80 0 0 0 0 0 0 0\n'
      throw new Error('ENOENT')
    }
    expect(await readHostNet(read)).toEqual({ rxBytes: 300, txBytes: 130 })
    expect(await readHostNet(async () => {
      throw new Error('ENOENT')
    })).toBeUndefined()
  })

  it('readFreeBytes multiplies free blocks by block size and fails closed', async () => {
    expect(await readFreeBytes('/x', fakeProc({}, {}, { bavail: 10, bsize: 512 }))).toBe(5120)
    expect(await readFreeBytes('/x', fakeProc({}, {}))).toBeUndefined()
  })
})
