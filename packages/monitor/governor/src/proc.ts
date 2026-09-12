/**
 * Linux `/proc` metering primitives: one-pass process-table scans bucketed by
 * the metered leaders' process groups (shell spawns are detached, so
 * pgid == leader pid) or POSIX sessions (PTY spawns), plus per-pid statm/io
 * readers and host-level counters. All reads are injectable for tests and
 * every reader is total: an unreadable pid contributes nothing rather than
 * failing the tick.
 * @module @deepseek-ai/dsh-governor/proc
 */

import { readFile, readdir, readlink, statfs } from 'node:fs/promises'

/** Kernel clock ticks per second (`sysconf(_SC_CLK_TCK)` on mainstream Linux). */
export const CLK_TCK = 100

/** Page size in bytes on every mainstream Linux architecture we target. */
export const PAGE_SIZE = 4096

/** Fields of `/proc/<pid>/stat` the metering pass consumes. */
export interface ProcStatFields {
  readonly pid: number
  readonly pgrp: number
  readonly session: number
  readonly state: string
  readonly utime: number
  readonly stime: number
  readonly starttime: number
}

/** Per-pid memory facts from `statm` (and optionally `smaps_rollup`). */
export interface ProcMemory {
  readonly rssBytes: number
  readonly pssBytes?: number
}

/** Per-pid cumulative block-layer IO from `/proc/<pid>/io`. */
export interface ProcIo {
  readonly readBytes: number
  readonly writeBytes: number
}

/** Open-descriptor facts for one pid. */
export interface ProcFds {
  readonly count: number
  /** True when at least one descriptor is a socket (triggers TCP attribution). */
  readonly hasSocket: boolean
}

/** Host memory facts from `/proc/meminfo`. */
export interface HostMemory {
  readonly memTotalBytes: number
  /** The host's own cgroup v2 memory ceiling, when finite and readable. */
  readonly ownCgroupMaxBytes?: number
}

/** Host network counters from `/proc/net/dev`. */
export interface HostNetCounters {
  readonly rxBytes: number
  readonly txBytes: number
}

/** Injectable filesystem internals (tests substitute in-memory maps). */
export type { ProcInternals } from './types.ts'
import type { ProcInternals } from './types.ts'

const defaultInternals: ProcInternals = {
  readFile: path => readFile(path, 'utf8'),
  readDir: path => readdir(path),
  readLink: path => readlink(path),
  statfs: async (path) => {
    const stats = await statfs(path)
    return { bavail: stats.bavail, bsize: stats.bsize }
  },
}

/**
 * Parse one `/proc/<pid>/stat` line. The comm field may contain spaces and
 * parentheses, so fields are counted after the LAST closing parenthesis.
 * @param text - the raw stat line.
 * @returns parsed fields, or undefined when the line is malformed.
 */
export function parseProcStat(text: string): ProcStatFields | undefined {
  const close = text.lastIndexOf(')')
  if (close < 0) return undefined
  const rest = text.slice(close + 2).split(' ')
  const number = (index: number): number | undefined => {
    const value = Number(rest[index])
    return Number.isFinite(value) ? value : undefined
  }
  // After `pid (comm) `, field N of the kernel layout sits at rest[N-3]
  // (state=1 → rest[0]); utime/stime/starttime are kernel fields 14/15/22.
  const state = rest[0]
  const pgrp = number(2)
  const session = number(3)
  const utime = number(11)
  const stime = number(12)
  const starttime = number(19)
  const pid = Number(text.slice(0, text.indexOf(' ')))
  if (state === undefined || pgrp === undefined || session === undefined
    || utime === undefined || stime === undefined || starttime === undefined
    || !Number.isInteger(pid)) return undefined
  return { pid, pgrp, session, state, utime, stime, starttime }
}

/** Aggregated bucket totals for one metered tree at one tick. */
export interface BucketAgg {
  readonly pids: readonly number[]
  readonly cpuTicks: number
  readonly rssBytes: number
  readonly readBytes: number
  readonly writeBytes: number
  readonly fdCount: number
  readonly hasSocket: boolean
}

/**
 * Scan `/proc` once and aggregate every process belonging to the given
 * process groups or POSIX sessions into per-bucket totals. Shell commands
 * bucket under `pgid:<leader>`, terminals under `sid:<leader>`; a pid matching
 * both sets (nested terminals) counts once per matching bucket.
 * @param pgids - detached process-group leaders to aggregate.
 * @param sids - POSIX session leaders to aggregate.
 * @param internals - injectable fs reads.
 * @returns bucket key → aggregate, excluding empty buckets.
 */
export async function scanBuckets(
  pgids: ReadonlySet<number>,
  sids: ReadonlySet<number>,
  internals: ProcInternals = defaultInternals,
): Promise<Map<string, BucketAgg>> {
  const buckets = new Map<string, { pids: number[]; cpu: number; rss: number; read: number; write: number; fds: number; socket: boolean }>()
  let names: string[]
  try {
    names = await internals.readDir('/proc')
  } catch {
    return new Map<string, BucketAgg>()
  }
  const detailReads: Promise<void>[] = []
  for (const name of names) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue
    const pid = Number(name)
    let stat: ProcStatFields | undefined
    try {
      stat = parseProcStat(await internals.readFile(`/proc/${name}/stat`))
    } catch {
      continue
    }
    if (stat === undefined) continue
    const keys: string[] = []
    if (pgids.has(stat.pgrp)) keys.push(`pgid:${stat.pgrp}`)
    if (sids.has(stat.session)) keys.push(`sid:${stat.session}`)
    if (keys.length === 0) continue
    const owned: { pids: number[]; cpu: number; rss: number; read: number; write: number; fds: number; socket: boolean }[] = []
    for (const key of keys) {
      const existing = buckets.get(key)
      if (existing === undefined) {
        const bucket = { pids: [], cpu: 0, rss: 0, read: 0, write: 0, fds: 0, socket: false }
        buckets.set(key, bucket)
        owned.push(bucket)
      } else {
        owned.push(existing)
      }
      const bucket = owned.at(-1) ?? { pids: [], cpu: 0, rss: 0, read: 0, write: 0, fds: 0, socket: false }
      bucket.pids.push(pid)
      bucket.cpu += stat.utime + stat.stime
    }
    // Detail reads happen once per pid, folding straight into owned buckets.
    detailReads.push((async () => {
      const [memory, io, fds] = await Promise.all([
        readProcMemory(pid, internals),
        readProcIo(pid, internals).catch(() => undefined),
        readProcFds(pid, internals).catch(() => undefined),
      ])
      for (const bucket of owned) {
        bucket.rss += memory.rssBytes
        if (io !== undefined) {
          bucket.read += io.readBytes
          bucket.write += io.writeBytes
        }
        if (fds !== undefined) {
          bucket.fds += fds.count
          if (fds.hasSocket) bucket.socket = true
        }
      }
    })())
  }
  await Promise.allSettled(detailReads)
  const result = new Map<string, BucketAgg>()
  for (const [key, bucket] of buckets) {
    result.set(key, {
      pids: bucket.pids,
      cpuTicks: bucket.cpu,
      rssBytes: bucket.rss,
      readBytes: bucket.read,
      writeBytes: bucket.write,
      fdCount: bucket.fds,
      hasSocket: bucket.socket,
    })
  }
  return result
}

/**
 * Read resident and proportional memory for one pid.
 * @param pid - process id.
 * @param internals - injectable fs reads.
 * @returns statm-derived RSS plus smaps_rollup PSS when readable.
 */
export async function readProcMemory(pid: number, internals: ProcInternals = defaultInternals): Promise<ProcMemory> {
  let statm: string
  try {
    statm = await internals.readFile(`/proc/${pid}/statm`)
  } catch {
    // An unreadable pid contributes nothing (the scan already totals this).
    return { rssBytes: 0 }
  }
  const residentPages = Number(statm.split(' ')[1])
  if (!Number.isFinite(residentPages)) return { rssBytes: 0 }
  const memory: ProcMemory = { rssBytes: residentPages * PAGE_SIZE }
  try {
    const rollup = await internals.readFile(`/proc/${pid}/smaps_rollup`)
    const pss = /^Pss:\s+(\d+) kB$/m.exec(rollup)
    if (pss !== null) return { ...memory, pssBytes: Number(pss[1]) * 1024 }
  } catch {
    // PSS is best-effort; RSS alone answers the watchdog.
  }
  return memory
}

/**
 * Read cumulative block-layer IO for one pid.
 * @param pid - process id.
 * @param internals - injectable fs reads.
 * @returns read/write byte counters.
 */
export async function readProcIo(pid: number, internals: ProcInternals = defaultInternals): Promise<ProcIo> {
  const io = await internals.readFile(`/proc/${pid}/io`)
  const read = /^read_bytes:\s+(\d+)$/m.exec(io)
  const write = /^write_bytes:\s+(\d+)$/m.exec(io)
  return {
    readBytes: read === null ? 0 : Number(read[1]),
    writeBytes: write === null ? 0 : Number(write[1]),
  }
}

/**
 * Count one pid's open descriptors and detect socket ownership.
 * @param pid - process id.
 * @param internals - injectable fs reads.
 * @returns descriptor count and socket-presence flag.
 */
export async function readProcFds(pid: number, internals: ProcInternals = defaultInternals): Promise<ProcFds> {
  const names = await internals.readDir(`/proc/${pid}/fd`)
  let hasSocket = false
  for (const name of names) {
    try {
      const link = await internals.readLink(`/proc/${pid}/fd/${name}`)
      if (link.startsWith('socket:')) hasSocket = true
    } catch {
      // A descriptor closing mid-walk is not an error for counting purposes.
    }
  }
  return { count: names.length, hasSocket }
}

/**
 * Read host memory facts: MemTotal plus the host's own cgroup ceiling.
 * @param readFile - injectable file reader.
 * @returns memory facts, or undefined when `/proc/meminfo` is unreadable.
 */
export async function readHostMemory(
  readFile: (path: string) => Promise<string> = defaultInternals.readFile,
): Promise<HostMemory | undefined> {
  try {
    const meminfo = await readFile('/proc/meminfo')
    const total = /^MemTotal:\s+(\d+) kB$/m.exec(meminfo)
    if (total === null) return undefined
    const memory: HostMemory = { memTotalBytes: Number(total[1]) * 1024 }
    try {
      const max = await readFile('/sys/fs/cgroup/memory.max')
      const value = Number(max.trim())
      if (Number.isFinite(value) && value > 0) return { ...memory, ownCgroupMaxBytes: value }
    } catch {
      // Bare hosts without cgroup v2 mounted report physical memory only.
    }
    return memory
  } catch {
    return undefined
  }
}

/**
 * Read host network interface counters (all interfaces summed).
 * @param readFile - injectable file reader.
 * @returns rx/tx byte counters, or undefined when unreadable.
 */
export async function readHostNet(
  readFile: (path: string) => Promise<string> = defaultInternals.readFile,
): Promise<HostNetCounters | undefined> {
  let dev: string | undefined
  try {
    dev = await readFile('/proc/net/dev')
  } catch {
    return undefined
  }
  let rxBytes = 0
  let txBytes = 0
  for (const line of dev.split('\n').slice(2)) {
    const [name, counters] = line.split(':')
    if (name === undefined || counters === undefined) continue
    const fields = counters.trim().split(/\s+/)
    const rx = Number(fields[0])
    const tx = Number(fields[8])
    if (Number.isFinite(rx)) rxBytes += rx
    if (Number.isFinite(tx)) txBytes += tx
  }
  return { rxBytes, txBytes }
}

/**
 * Read free bytes for one filesystem path (the disk-space sentinel).
 * @param path - filesystem path to probe.
 * @param internals - injectable fs reads.
 * @returns free bytes available to unprivileged writes, or undefined.
 */
export async function readFreeBytes(path: string, internals: ProcInternals = defaultInternals): Promise<number | undefined> {
  try {
    const stats = await internals.statfs(path)
    return stats.bavail * stats.bsize
  } catch {
    return undefined
  }
}
