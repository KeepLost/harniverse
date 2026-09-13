/**
 * The metering engine: tracks live correlated commands, samples their
 * process-tree resources each tick from `/proc`, attributes TCP bytes via
 * `ss` when tree members own sockets, keeps bounded rings, and reports the
 * aggregate overages the watchdog tier acts on. Pure sampling — kill
 * decisions and events belong to the governor service.
 * @module @deepseek-ai/dsh-governor/sampler
 */

import { execFileSync } from 'node:child_process'
import type { SubprocessHandle, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type { CommandView, GovernorBreachRecord, ResourceSample, SamplerOptions } from './types.ts'
import type { BucketAgg, HostNetCounters } from './proc.ts'
import { readFreeBytes, readHostNet, scanBuckets } from './proc.ts'
import type { PidTcpStats } from './net.ts'
import { parseSsOutput } from './net.ts'

/** Live tracking state of one metered command. */
interface LiveCommand {
  readonly sessionId: string
  readonly commandId: string
  readonly kind: 'shell' | 'terminal' | 'other'
  readonly terminal: boolean
  readonly handle: SubprocessHandle | SubprocessTerminalHandle
  readonly startedAt: number
  samples: ResourceSample[]
  peakRssBytes: number
  totalCpuTicks: number
  totalReadBytes: number
  totalWriteBytes: number
  lastCpuTicks: number | undefined
  lastReadBytes: number | undefined
  lastWriteBytes: number | undefined
  lastNetTx: number | undefined
  lastNetRx: number | undefined
  exitedAt: number | undefined
  breach: GovernorBreachRecord | undefined
}

/** One watchdog overage the service must judge a kill for. */
export interface Overage {
  readonly sessionId: string
  /** Sessions with explicit quotas overage against that quota; pool members against the global budget. */
  readonly scope: 'global' | 'session'
  readonly limitBytes: number
  readonly observedBytes: number
}

/** Tick products: per-session aggregates, overages, host facts. */
export interface TickResult {
  readonly sessionRss: ReadonlyMap<string, number>
  readonly sessionCpuTicks: ReadonlyMap<string, number>
  readonly liveCommandCount: number
  readonly overages: readonly Overage[]
  readonly hostFreeBytes?: number
  readonly hostNet?: HostNetCounters
  readonly t: number
}

const RING_CAP = 120
const SETTLED_CAP = 200

/**
 * The metering engine proper. Register commands through {@link track} /
 * {@link settle}; call {@link tick} on the sampling cadence.
 */
export class MeteringEngine {
  private readonly live = new Map<string, LiveCommand>()
  private readonly settled: LiveCommand[] = []
  private readonly breaches: GovernorBreachRecord[] = []
  private readonly overageStreak = new Map<string, number>()
  private readonly options: SamplerOptions
  private lastHostNet: HostNetCounters | undefined

  constructor(options: SamplerOptions) {
    this.options = options
  }

  /** Number of currently live metered commands. */
  get liveCount(): number {
    return this.live.size
  }

  /**
   * Register one metered spawn.
   * @param commandId - caller-stable command id.
   * @param sessionId - owning session id.
   * @param kind - correlation kind.
   * @param handle - the live subprocess or terminal handle.
   */
  track(commandId: string, sessionId: string, kind: 'shell' | 'terminal' | 'other', handle: SubprocessHandle | SubprocessTerminalHandle): void {
    if (this.live.has(commandId) || this.settled.some(entry => entry.commandId === commandId)) return
    this.live.set(commandId, {
      sessionId,
      commandId,
      kind,
      terminal: kind === 'terminal',
      handle,
      startedAt: this.options.now?.() ?? Date.now(),
      samples: [],
      peakRssBytes: 0,
      totalCpuTicks: 0,
      totalReadBytes: 0,
      totalWriteBytes: 0,
      lastCpuTicks: undefined,
      lastReadBytes: undefined,
      lastWriteBytes: undefined,
      lastNetTx: undefined,
      lastNetRx: undefined,
      exitedAt: undefined,
      breach: undefined,
    })
  }

  /**
   * Mark one command settled and freeze its final record.
   * @param commandId - the command id.
   * @returns the frozen record when the command was tracked.
   */
  settle(commandId: string): CommandView | undefined {
    const entry = this.live.get(commandId)
    if (entry === undefined) return undefined
    entry.exitedAt = this.options.now?.() ?? Date.now()
    this.live.delete(commandId)
    this.settled.push(entry)
    if (this.settled.length > SETTLED_CAP) this.settled.splice(0, this.settled.length - SETTLED_CAP)
    this.overageStreak.delete(commandId)
    return viewOf(entry)
  }

  /**
   * The most recent breach recorded for one command, for the tool merge.
   * @param commandId - command id.
   * @returns the breach facts, or undefined when none was recorded.
   */
  breachFor(commandId: string): GovernorBreachRecord | undefined {
    for (let index = this.breaches.length - 1; index >= 0; index -= 1) {
      const breach = this.breaches[index]
      if (breach !== undefined && breach.commandId === commandId) return breach
    }
    return undefined
  }

  /**
   * Record one enforcement kill (the service calls this when it terminates a
   * command for an overage).
   * @param breach - the breach facts.
   */
  recordBreach(breach: GovernorBreachRecord): void {
    this.breaches.push(breach)
    if (this.breaches.length > SETTLED_CAP) this.breaches.splice(0, this.breaches.length - SETTLED_CAP)
    const entry = this.live.get(breach.commandId) ?? this.settled.find(item => item.commandId === breach.commandId)
    if (entry !== undefined) entry.breach = breach
  }

  /**
   * Terminate one live command's process tree (the watchdog kill verb).
   * @param commandId - the command to terminate.
   */
  terminate(commandId: string): void {
    void this.live.get(commandId)?.handle.terminate()
  }

  /**
   * Breaches newest-first, bounded.
   * @returns the reversed bounded breach list.
   */
  recentBreaches(): readonly GovernorBreachRecord[] {
    return [...this.breaches].reverse()
  }

  /**
   * One sampling tick: scan `/proc`, fold buckets into per-command samples,
   * aggregate per-session sums, judge overages, and read host sentinels.
   * @param sustainedTicks - overage ticks before an overage is reported.
   * @returns the tick's aggregates and overages.
   */
  async tick(sustainedTicks = 3): Promise<TickResult> {
    const t = this.options.now?.() ?? Date.now()
    const pgids = new Set<number>()
    const sids = new Set<number>()
    for (const entry of this.live.values()) {
      if (entry.handle.pid <= 0) continue
      if (entry.terminal) sids.add(entry.handle.pid)
      else pgids.add(entry.handle.pid)
    }
    const buckets = await scanBuckets(pgids, sids, this.options.internals)
    let tcp: Map<number, PidTcpStats> | undefined
    const sessionRss = new Map<string, number>()
    const sessionCpu = new Map<string, number>()
    for (const entry of this.live.values()) {
      const bucketKey = entry.terminal ? `sid:${entry.handle.pid}` : `pgid:${entry.handle.pid}`
      const bucket: BucketAgg | undefined = buckets.get(bucketKey)
      if (bucket?.hasSocket === true && tcp === undefined) {
        tcp = this.readTcp()
      }
      const sample = this.fold(entry, bucket, tcp, t)
      sessionRss.set(entry.sessionId, (sessionRss.get(entry.sessionId) ?? 0) + sample.rssBytes)
      sessionCpu.set(entry.sessionId, (sessionCpu.get(entry.sessionId) ?? 0) + sample.cpuTicks)
    }
    const globalLimit = this.options.globalLimitBytes()
    const overages = this.judgeOverages(sessionRss, globalLimit, sustainedTicks)
    const hostFreeBytes = await readFreeBytes(this.options.sentinelPath ?? process.cwd(), this.options.internals)
    const hostNet = await readHostNet(this.options.internals?.readFile)
    const delta = hostNet === undefined || this.lastHostNet === undefined
      ? undefined
      : {
        rxBytes: Math.max(0, hostNet.rxBytes - this.lastHostNet.rxBytes),
        txBytes: Math.max(0, hostNet.txBytes - this.lastHostNet.txBytes),
      }
    this.lastHostNet = hostNet ?? this.lastHostNet
    return {
      sessionRss,
      sessionCpuTicks: sessionCpu,
      liveCommandCount: this.live.size,
      overages,
      ...hostFreeBytes !== undefined ? { hostFreeBytes } : {},
      ...delta !== undefined ? { hostNet: delta } : {},
      t,
    }
  }

  /** Fold one bucket into a command's ring and totals. */
  private fold(entry: LiveCommand, bucket: BucketAgg | undefined, tcp: Map<number, PidTcpStats> | undefined, t: number): ResourceSample {
    const cpuTicks = bucket === undefined || entry.lastCpuTicks === undefined
      ? 0
      : Math.max(0, bucket.cpuTicks - entry.lastCpuTicks)
    const readBytes = bucket === undefined || entry.lastReadBytes === undefined
      ? 0
      : Math.max(0, bucket.readBytes - entry.lastReadBytes)
    const writeBytes = bucket === undefined || entry.lastWriteBytes === undefined
      ? 0
      : Math.max(0, bucket.writeBytes - entry.lastWriteBytes)
    let netTx: number | undefined
    let netRx: number | undefined
    if (bucket !== undefined && tcp !== undefined) {
      let tx = 0
      let rx = 0
      let seen = false
      for (const pid of bucket.pids) {
        const stats = tcp.get(pid)
        if (stats === undefined) continue
        seen = true
        tx += stats.bytesSent
        rx += stats.bytesReceived
      }
      if (seen && entry.lastNetTx !== undefined && entry.lastNetRx !== undefined) {
        netTx = Math.max(0, tx - entry.lastNetTx)
        netRx = Math.max(0, rx - entry.lastNetRx)
      }
      if (seen) {
        entry.lastNetTx = tx
        entry.lastNetRx = rx
      } else {
        entry.lastNetTx = undefined
        entry.lastNetRx = undefined
      }
    }
    const rssBytes = bucket?.rssBytes ?? 0
    if (bucket !== undefined) {
      entry.lastCpuTicks = bucket.cpuTicks
      entry.lastReadBytes = bucket.readBytes
      entry.lastWriteBytes = bucket.writeBytes
    }
    const sample: ResourceSample = {
      t,
      cpuTicks,
      rssBytes,
      readBytes,
      writeBytes,
      fdCount: bucket?.fdCount ?? 0,
      ...netTx !== undefined && netRx !== undefined ? { netTxBytes: netTx, netRxBytes: netRx } : {},
    }
    entry.samples.push(sample)
    if (entry.samples.length > RING_CAP) entry.samples.splice(0, entry.samples.length - RING_CAP)
    entry.peakRssBytes = Math.max(entry.peakRssBytes, rssBytes)
    entry.totalCpuTicks += cpuTicks
    entry.totalReadBytes += readBytes
    entry.totalWriteBytes += writeBytes
    return sample
  }

  /** Judge sustained overages per session and globally; report candidates. */
  private judgeOverages(sessionRss: ReadonlyMap<string, number>, globalLimit: number, sustainedTicks: number): Overage[] {
    const totalRss = [...sessionRss.values()].reduce((sum, value) => sum + value, 0)
    const overages: Overage[] = []
    const streakKey = (scope: 'global' | 'session', id: string): string => `${scope}:${id}`
    const bump = (scope: 'global' | 'session', id: string, over: boolean, limit: number, observed: number): void => {
      const key = streakKey(scope, id)
      const streak = (this.overageStreak.get(key) ?? 0) + (over ? 1 : 0)
      if (over) this.overageStreak.set(key, streak)
      else this.overageStreak.delete(key)
      if (over && streak >= sustainedTicks) overages.push({ sessionId: id, scope, limitBytes: limit, observedBytes: observed })
    }
    for (const [sessionId, rss] of sessionRss) {
      const limit = this.options.effectiveLimitBytes(sessionId)
      bump('session', sessionId, rss > limit, limit, rss)
    }
    bump('global', '*', totalRss > globalLimit, globalLimit, totalRss)
    return overages
  }

  /** Run `ss` once for TCP attribution (injectable for tests). */
  private readTcp(): Map<number, PidTcpStats> {
    const exec = this.options.execSs
    if (exec !== undefined) return parseSsOutput(exec(['-tinp']))
    try {
      return parseSsOutput(execFileSync('ss', ['-tinp'], { encoding: 'utf8' }))
    } catch {
      /* v8 ignore next 2 -- the catch only fires when `ss` is absent from PATH,
         which is environment-dependent (CI images and dev containers carry it). */
      return new Map()
    }
  }

  /**
   * Live command views for the overview (fresh copies, newest last).
   * @returns views of every command still running.
   */
  liveViews(): CommandView[] {
    return [...this.live.values()].map(viewOf)
  }

  /**
   * Settled command views, newest last, bounded.
   * @returns frozen records of commands that exited.
   */
  settledViews(): CommandView[] {
    return this.settled.map(viewOf)
  }

  /**
   * Views of one session's commands (live first, then settled).
   * @param sessionId - session id.
   * @returns the session's command views with sample rings.
   */
  viewsOf(sessionId: string): CommandView[] {
    return [...this.live.values(), ...this.settled]
      .filter(entry => entry.sessionId === sessionId)
      .map(viewOf)
  }
}

/** Project internal tracking state into the public view shape. */
function viewOf(entry: LiveCommand): CommandView {
  return {
    sessionId: entry.sessionId,
    commandId: entry.commandId,
    kind: entry.kind,
    startedAt: entry.startedAt,
    ...entry.exitedAt !== undefined ? { exitedAt: entry.exitedAt } : {},
    samples: [...entry.samples],
    peakRssBytes: entry.peakRssBytes,
    totalCpuTicks: entry.totalCpuTicks,
    totalReadBytes: entry.totalReadBytes,
    totalWriteBytes: entry.totalWriteBytes,
    ...entry.breach !== undefined ? { breach: entry.breach } : {},
  }
}
