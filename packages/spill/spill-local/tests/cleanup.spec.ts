/**
 * Startup cleanup sweep coverage: expired-file reclamation with exact session
 * shape and strict age matching, emptied-session-directory pruning, safety
 * skips (foreign entries, symlinks, unsafe directories), best-effort
 * containment of per-item filesystem failures, and the fiber-owned timing
 * (activation is never delayed; disposal awaits the sweep). Race-only failure
 * paths are forced through a scripted `node:fs/promises` passthrough mock.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionDir, readTextFile } from '../src/store.ts'
import { sweepSpillRoot } from '../src/cleanup.ts'
import type { WarnFn } from '../src/cleanup.ts'
import { isErrno } from '../src/store.ts'
import LocalSpillStore from '../src/index.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const TEST_SIGNAL = new AbortController().signal

const script = vi.hoisted(() => ({
  readdirErrorFor: undefined as { path: string; error: NodeJS.ErrnoException } | undefined,
  lstatErrorFor: undefined as { path: string; error: NodeJS.ErrnoException } | undefined,
  unlinkErrorFor: undefined as { path: string; error: NodeJS.ErrnoException } | undefined,
  rmdirErrorFor: undefined as { path: string; error: NodeJS.ErrnoException } | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const keyed = (slot: { path: string; error: NodeJS.ErrnoException } | undefined, path: string): boolean =>
    slot !== undefined && (path === slot.path || path.startsWith(`${slot.path}/`))
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const path = String(args[0])
      if (keyed(script.readdirErrorFor, path)) throw script.readdirErrorFor!.error
      return await actual.readdir(...args)
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      if (keyed(script.lstatErrorFor, path)) throw script.lstatErrorFor!.error
      return await actual.lstat(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const path = String(args[0])
      if (keyed(script.unlinkErrorFor, path)) throw script.unlinkErrorFor!.error
      await actual.unlink(...args)
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      const path = String(args[0])
      if (keyed(script.rmdirErrorFor, path)) throw script.rmdirErrorFor!.error
      await actual.rmdir(...args)
    },
  }
})

let root: string
const extras: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-spill-sweep-'))
})
afterEach(() => {
  script.readdirErrorFor = undefined
  script.lstatErrorFor = undefined
  script.unlinkErrorFor = undefined
  script.rmdirErrorFor = undefined
  rmSync(root, { recursive: true, force: true })
  for (const path of extras.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** Write a file with an mtime `ageDays` in the past (fractional allowed). */
function writeAged(path: string, content: string, ageDays: number): void {
  writeFileSync(path, content)
  const when = (Date.now() - ageDays * DAY_MS) / 1000
  utimesSync(path, when, when)
}

const warn = (): WarnFn => vi.fn()

/** Sweep one root directly at a `cleanupPeriodDays`-shaped cutoff. */
function sweep(target: string, cleanupPeriodDays = 30, sink: WarnFn = warn()): Promise<void> {
  return sweepSpillRoot({ root: target, cutoffMs: Date.now() - cleanupPeriodDays * DAY_MS, warn: sink })
}

describe('sweepSpillRoot reclamation', () => {
  it('deletes files older than the cutoff and keeps fresh ones', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)
    const fresh = join(dir, 'fresh.txt'); writeAged(fresh, 'y', 1)
    await sweep(root)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('keeps a file exactly at the boundary (only strictly-older expires)', async () => {
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const cutoffMs = Date.now() - 30 * DAY_MS
    const boundary = join(dir, 'boundary.txt')
    writeFileSync(boundary, 'x')
    // Round the boundary mtime UP to the next second: file systems truncate
    // utimes to whole seconds, and a truncated value could land before the
    // cutoff. Rounded up, mtime >= cutoffMs still exercises the boundary.
    const atBoundary = (Math.floor(cutoffMs / 1000) + 1) * 1000
    utimesSync(boundary, atBoundary / 1000, atBoundary / 1000)
    await sweepSpillRoot({ root, cutoffMs, warn: warn() })
    expect(existsSync(boundary)).toBe(true)
  })

  it('prunes an emptied session directory and keeps one holding a fresh file', async () => {
    const emptied = sessionDir(root, 'emptied')
    const kept = sessionDir(root, 'kept')
    mkdirSync(emptied, { recursive: true, mode: 0o700 })
    mkdirSync(kept, { recursive: true, mode: 0o700 })
    writeAged(join(emptied, 'a.txt'), 'x', 40)
    writeAged(join(kept, 'fresh.txt'), 'y', 1)
    await sweep(root)
    expect(existsSync(emptied)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })

  it('sweeps only exact session-<12 hex> names, not lookalikes', async () => {
    const backup = join(root, 'session-backup'); mkdirSync(backup, { recursive: true, mode: 0o700 })
    const backupOld = join(backup, 'old.txt'); writeAged(backupOld, 'x', 40)
    const shortHex = join(root, `session-${'a'.repeat(11)}`); mkdirSync(shortHex, { recursive: true, mode: 0o700 })
    const shortOld = join(shortHex, 'old.txt'); writeAged(shortOld, 'x', 40)
    const real = sessionDir(root, 'sess-1'); mkdirSync(real, { recursive: true, mode: 0o700 })
    const realOld = join(real, 'old.txt'); writeAged(realOld, 'x', 40)
    await sweep(root)
    expect(existsSync(backupOld)).toBe(true)
    expect(existsSync(shortOld)).toBe(true)
    expect(existsSync(realOld)).toBe(false)
  })

  it('never follows a symlinked session directory and keeps non-file entries', async () => {
    // A `session-<12hex>`-NAMED symlink pointing at a directory of old files
    // must never be descended: lstat on the entry sees a link, so the target's
    // files stay intact and the link itself is not removed.
    const victimDir = join(root, 'victim'); mkdirSync(victimDir, { recursive: true, mode: 0o700 })
    const victimOld = join(victimDir, 'old.txt'); writeAged(victimOld, 'x', 40)
    const link = join(root, `session-${'a'.repeat(12)}`)
    symlinkSync(victimDir, link, process.platform === 'win32' ? 'junction' : 'dir')

    // Inside a real session dir, a symlink and a nested directory are not
    // regular files: both survive, so their session dir is not pruned either.
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const target = join(root, 'target.txt'); writeAged(target, 'keep', 40)
    const entryLink = join(dir, 'link.txt'); symlinkSync(target, entryLink)
    const nested = join(dir, 'nested'); mkdirSync(nested)
    writeAged(join(nested, 'old.txt'), 'x', 40)

    await sweep(root)
    expect(existsSync(victimOld)).toBe(true)
    expect(existsSync(link)).toBe(true)
    expect(existsSync(entryLink)).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(existsSync(nested)).toBe(true)
  })

  it('skips a POSIX session directory writable by group or others', async () => {
    if (process.platform === 'win32') return
    const dir = sessionDir(root, 'sess-1')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)
    chmodSync(dir, 0o777)
    const sink = warn()
    await sweepSpillRoot({ root, cutoffMs: Date.now(), warn: sink })
    expect(existsSync(old)).toBe(true)
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('skipped unsafe session directory'))
  })
})

describe('sweepSpillRoot root admission', () => {
  it('skips an unsafe root and reports it', async () => {
    const filePath = join(root, 'not-a-dir'); writeFileSync(filePath, 'x')
    const sink = warn()
    await expect(sweep(filePath, 30, sink)).resolves.toBeUndefined()
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('skipped unsafe root'))
  })

  it('is silent for a root that does not exist yet', async () => {
    const sink = warn()
    await sweep(join(root, 'never-created'), 30, sink)
    expect(sink).not.toHaveBeenCalled()
  })

  it('is silent when an admitted root disappears before its read', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeAged(join(dir, 'old.txt'), 'x', 40)
    script.readdirErrorFor = { path: root, error: Object.assign(new Error('simulated ENOENT'), { code: 'ENOENT' }) }
    const sink = warn()
    await sweep(root, 30, sink)
    expect(sink).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'old.txt'))).toBe(true)
  })

  it('reports a root inspection or read failure other than ENOENT', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeAged(join(dir, 'old.txt'), 'x', 40)
    const sink = warn()
    script.lstatErrorFor = { path: root, error: Object.assign(new Error('simulated EACCES'), { code: 'EACCES' }) }
    await sweep(root, 30, sink)
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('failed to inspect root'))
    script.lstatErrorFor = undefined
    script.readdirErrorFor = { path: root, error: Object.assign(new Error('simulated EACCES'), { code: 'EACCES' }) }
    await sweep(root, 30, sink)
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('failed to read root'))
    expect(existsSync(join(dir, 'old.txt'))).toBe(true)
  })
})

describe('sweepSpillRoot best-effort containment', () => {
  it('continues past one failed deletion and still removes the other expired files', async () => {
    const first = sessionDir(root, 'one'); mkdirSync(first, { recursive: true, mode: 0o700 })
    const second = sessionDir(root, 'two'); mkdirSync(second, { recursive: true, mode: 0o700 })
    const stubborn = join(first, 'stubborn.txt'); writeAged(stubborn, 'x', 40)
    const removable = join(second, 'gone.txt'); writeAged(removable, 'x', 40)
    const sink = warn()
    script.unlinkErrorFor = { path: stubborn, error: Object.assign(new Error('simulated EPERM'), { code: 'EPERM' }) }
    await sweep(root, 30, sink)
    expect(existsSync(stubborn)).toBe(true)
    expect(existsSync(removable)).toBe(false)
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('failed to delete'))
  })

  it('treats a concurrent disappearance during deletion as success', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const vanished = join(dir, 'vanished.txt'); writeAged(vanished, 'x', 40)
    const sink = warn()
    script.unlinkErrorFor = { path: vanished, error: Object.assign(new Error('simulated ENOENT'), { code: 'ENOENT' }) }
    await sweep(root, 30, sink)
    expect(sink).not.toHaveBeenCalled()
  })

  it('contains an unreadable session directory and keeps sweeping others', async () => {
    const broken = sessionDir(root, 'broken'); mkdirSync(broken, { recursive: true, mode: 0o700 })
    const healthy = sessionDir(root, 'healthy'); mkdirSync(healthy, { recursive: true, mode: 0o700 })
    writeAged(join(broken, 'old.txt'), 'x', 40)
    const removable = join(healthy, 'gone.txt'); writeAged(removable, 'x', 40)
    const sink = warn()
    script.readdirErrorFor = { path: broken, error: Object.assign(new Error('simulated EACCES'), { code: 'EACCES' }) }
    await sweep(root, 30, sink)
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('failed to read'))
    expect(existsSync(removable)).toBe(false)
    expect(existsSync(broken)).toBe(true)
  })

  it('skips a session entry whose stat fails, silently on disappearance', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const raced = join(dir, 'raced.txt'); writeAged(raced, 'x', 40)
    // Between the session readdir and the entry lstat the file disappears.
    script.lstatErrorFor = { path: raced, error: Object.assign(new Error('simulated ENOENT'), { code: 'ENOENT' }) }
    const sink = warn()
    await sweep(root, 30, sink)
    expect(sink).not.toHaveBeenCalled()
  })

  it('skips a session directory that disappears mid-sweep', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeAged(join(dir, 'old.txt'), 'x', 40)
    script.lstatErrorFor = { path: dir, error: Object.assign(new Error('simulated ENOENT'), { code: 'ENOENT' }) }
    const sink = warn()
    await sweep(root, 30, sink)
    expect(sink).not.toHaveBeenCalled()
  })

  it('reports a session entry or directory whose stat fails otherwise', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const denied = join(dir, 'denied.txt'); writeAged(denied, 'x', 40)
    const sink = warn()
    script.lstatErrorFor = { path: denied, error: Object.assign(new Error('simulated EACCES'), { code: 'EACCES' }) }
    await sweep(root, 30, sink)
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('failed to stat'))

    script.lstatErrorFor = { path: dir, error: Object.assign(new Error('simulated EACCES'), { code: 'EACCES' }) }
    await sweep(root, 30, sink)
    expect(sink).toHaveBeenCalledWith(expect.stringContaining(`failed to stat ${dir}`))
  })

  it('contains a failed session-directory prune, silently on a refill race', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)
    const sink = warn()
    script.rmdirErrorFor = { path: dir, error: Object.assign(new Error('simulated EPERM'), { code: 'EPERM' }) }
    await sweep(root, 30, sink)
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('failed to prune'))
    script.rmdirErrorFor = { path: dir, error: Object.assign(new Error('simulated ENOTEMPTY'), { code: 'ENOTEMPTY' }) }
    await sweep(root, 30, sink)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('contains an exception from the warning sink', async () => {
    const filePath = join(root, 'not-a-dir'); writeFileSync(filePath, 'x')
    const throwing = vi.fn(() => { throw new Error('logger failed') })
    await expect(sweepSpillRoot({ root: filePath, cutoffMs: Date.now(), warn: throwing })).resolves.toBeUndefined()
    expect(throwing).toHaveBeenCalledOnce()
  })
})

describe('LocalSpillStore startup sweep', () => {
  it('deletes expired files at startup and keeps a readable fresh artifact', async () => {
    const dir = sessionDir(root, 'old-sess'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)

    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 30 })
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: 'sess-1' as never },
      source: { toolName: 'web_fetch', callId: 'call-1' as never, label: 'result' },
      suggestedName: 'fresh.txt',
      content: 'live result',
      signal: TEST_SIGNAL,
    })
    await fiber.dispose()
    expect(existsSync(old)).toBe(false)
    // The just-written artifact survives the completed sweep and stays
    // readable — the retention window is what keeps a resumed session's
    // locators valid until they age out.
    await expect(readTextFile({ signal: TEST_SIGNAL, root, locator: ref.locator, maxChars: 100 }))
      .resolves.toEqual({ text: 'live result' })
  })

  it('with cleanupPeriodDays: 0 sweeps nothing', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 400)
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 })
    await fiber.dispose()
    expect(existsSync(old)).toBe(true)
  })

  it('defaults cleanupPeriodDays to 30', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSpillStore, { root })
    const store = ctx.spillStore as LocalSpillStore
    expect(store.config.cleanupPeriodDays).toBe(30)
    await fiber.dispose()
  })

  it('rejects a negative or fractional cleanupPeriodDays at load', async () => {
    await expect(new Context().plugin(LocalSpillStore, { root, cleanupPeriodDays: -1 })).rejects.toThrow()
    await expect(new Context().plugin(LocalSpillStore, { root, cleanupPeriodDays: 1.5 })).rejects.toThrow()
  })

  it('does not delay activation and is awaited on disposal', async () => {
    const dir = sessionDir(root, 'sess-1'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const old = join(dir, 'old.txt'); writeAged(old, 'x', 40)

    let release!: () => void
    HeldStore.barrier = new Promise<void>((resolve) => { release = resolve })
    try {
      const ctx = new Context()
      const fiber = await ctx.plugin(HeldStore, { root, cleanupPeriodDays: 30 })
      // Activation returned while the sweep is still parked: the service is
      // usable and the old file is untouched so far.
      expect(existsSync(old)).toBe(true)
      await ctx.spillStore.saveText({
        owner: { sessionId: 'sess-1' as never },
        source: { toolName: 'web_fetch', callId: 'call-1' as never, label: 'result' },
        suggestedName: 'r.txt',
        content: 'x',
        signal: TEST_SIGNAL,
      })

      // Disposal must AWAIT the sweep: it settles only after the sweep deleted
      // the old file.
      release()
      await fiber.dispose()
      expect(existsSync(old)).toBe(false)
    } finally {
      HeldStore.barrier = undefined
    }
  })

  it('routes a sweep filesystem failure to ctx.logger.warn', async () => {
    const filePath = join(root, 'not-a-dir'); writeFileSync(filePath, 'x')
    const ctx = new Context()
    const logged = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(LocalSpillStore, { root: filePath, cleanupPeriodDays: 30 })
    await fiber.dispose()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('skipped unsafe root'))
    logged.mockRestore()
  })
})

/**
 * A store whose sweep can be held open behind a barrier, proving activation
 * is not delayed and disposal awaits the in-flight sweep.
 */
class HeldStore extends LocalSpillStore {
  static barrier: Promise<void> | undefined

  protected override async runCleanup(warn: WarnFn): Promise<void> {
    if (HeldStore.barrier) await HeldStore.barrier
    await super.runCleanup(warn)
  }
}

describe('isErrno', () => {
  it('matches a Node system error by code and rejects non-matches', () => {
    const err = Object.assign(new Error('boom'), { code: 'ENOENT' })
    expect(isErrno(err, 'ENOENT')).toBe(true)
    expect(isErrno(err, 'EPERM')).toBe(false)
    expect(isErrno('not an error', 'ENOENT')).toBe(false)
    expect(isErrno(new Error('no code'), 'ENOENT')).toBe(false)
  })
})
