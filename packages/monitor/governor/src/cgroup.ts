/**
 * Cgroup v2 enforcement tier for the governor. Operates a `dsh/` subtree
 * under an injectable cgroup root with injectable fs internals: the parent
 * carries the global memory budget, per-session leaves carry explicit
 * quotas, and the kernel enforces both asynchronously (`memory.max` +
 * `memory.swap.max = 0`). Every operation is best-effort — a failure
 * degrades the host to the rlimit/watchdog tier rather than breaking spawns.
 * No systemd dependency: this tier activates only when the cgroup root is
 * writable.
 * @module @deepseek-ai/dsh-governor/cgroup
 */

import { access, constants, mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'

/** Injectable cgroup filesystem internals (tests substitute in-memory maps). */
export interface CgroupInternals {
  mkdir(path: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  rmdir(path: string): Promise<void>
  readDir(path: string): Promise<string[]>
  accessWrite(path: string): Promise<boolean>
}

const defaultInternals: CgroupInternals = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  readFile: path => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text),
  rmdir: path => rmdir(path),
  readDir: path => readdir(path),
  accessWrite: async (path) => {
    try {
      await access(path, constants.W_OK)
      return true
    } catch {
      return false
    }
  },
}

/** Session cgroup names accept exactly the safe id subset. */
function sessionDirName(sessionId: string): string | undefined {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? `s-${sessionId}` : undefined
}

/** Cgroup v2 subtree the governor manages. */
export class CgroupRoot {
  private readonly root: string
  private readonly internals: CgroupInternals
  private writable: boolean | undefined

  constructor(root = '/sys/fs/cgroup', internals: CgroupInternals = defaultInternals) {
    this.root = root
    this.internals = internals
  }

  /** Cgroupfs root path this subtree manages. */
  get path(): string {
    return `${this.root}/dsh`
  }

  /**
   * Probe writability once: the tier activates only when the root accepts writes.
   * @returns true when cgroup enforcement is available.
   */
  async probe(): Promise<boolean> {
    if (this.writable !== undefined) return this.writable
    this.writable = await this.internals.accessWrite(this.root)
    return this.writable
  }

  /**
   * Ensure the parent group exists with the global budget applied.
   * @param globalLimitBytes - the shared-pool memory budget.
   */
  async ensureParent(globalLimitBytes: number): Promise<void> {
    if (!await this.probe()) return
    try {
      await this.internals.mkdir(this.path)
      await this.internals.writeFile(`${this.path}/memory.max`, String(globalLimitBytes))
      await this.internals.writeFile(`${this.path}/memory.swap.max`, '0')
    } catch {
      this.writable = false
    }
  }

  /**
   * Ensure one session leaf with its explicit quota.
   * @param sessionId - session id (safe-subset characters only).
   * @param memoryBytes - the session's explicit memory quota.
   */
  async ensureSession(sessionId: string, memoryBytes: number): Promise<void> {
    const dir = sessionDirName(sessionId)
    if (dir === undefined || !await this.probe()) return
    try {
      await this.internals.mkdir(`${this.path}/${dir}`)
      await this.internals.writeFile(`${this.path}/${dir}/memory.max`, String(memoryBytes))
      await this.internals.writeFile(`${this.path}/${dir}/memory.swap.max`, '0')
    } catch {
      // Session leaves are an optimization of isolation, not a safety gate.
    }
  }

  /**
   * Move one process (and by inheritance its whole tree) into the session
   * leaf when one exists, else into the parent group.
   * @param pid - process id to attach.
   * @param sessionId - owning session, when a leaf applies.
   */
  async attach(pid: number, sessionId: string | undefined): Promise<void> {
    if (!await this.probe()) return
    const dir = sessionId === undefined ? undefined : sessionDirName(sessionId)
    const target = dir === undefined ? this.path : `${this.path}/${dir}`
    try {
      await this.internals.writeFile(`${target}/cgroup.procs`, String(pid))
    } catch {
      // The child may already have exited; enforcement falls to the watchdog.
    }
  }

  /**
   * Read one session leaf's OOM facts.
   * @param sessionId - session id.
   * @returns oom_kill counter, or undefined when unreadable.
   */
  async readOomKills(sessionId: string): Promise<number | undefined> {
    const dir = sessionDirName(sessionId)
    if (dir === undefined) return undefined
    try {
      const events = await this.internals.readFile(`${this.path}/${dir}/memory.events`)
      const match = /^oom_kill\s+(\d+)$/m.exec(events)
      return match === null ? 0 : Number(match[1])
    } catch {
      return undefined
    }
  }

  /**
   * Read one session leaf's kernel-tracked memory peak.
   * @param sessionId - session id.
   * @returns peak bytes, or undefined when unreadable.
   */
  async readPeak(sessionId: string): Promise<number | undefined> {
    const dir = sessionDirName(sessionId)
    if (dir === undefined) return undefined
    try {
      const peak = await this.internals.readFile(`${this.path}/${dir}/memory.peak`)
      const value = Number(peak.trim())
      return Number.isFinite(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Remove one session leaf (session closed). Fails silently while processes
   * remain — the boot sweep retries later.
   * @param sessionId - session id.
   */
  async cleanupSession(sessionId: string): Promise<void> {
    const dir = sessionDirName(sessionId)
    if (dir === undefined || !await this.probe()) return
    try {
      await this.internals.rmdir(`${this.path}/${dir}`)
    } catch {
      // Occupied or already gone; the next sweep or boot handles it.
    }
  }

  /**
   * Remove every session leaf under the parent (boot-time sweep).
   */
  async sweep(): Promise<void> {
    if (!await this.probe()) return
    try {
      const entries = await this.internals.readDir(this.path)
      for (const entry of entries) {
        if (!entry.startsWith('s-')) continue
        await this.internals.rmdir(`${this.path}/${entry}`).catch(() => {})
      }
    } catch {
      // Parent missing or unreadable; nothing to sweep.
    }
  }
}
