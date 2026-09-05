/**
 * Cross-process write-lease behavior, exercised through fresh backend
 * instances over one shared root: kernel `flock` locks conflict between two
 * descriptors even inside one process, so a second instance behaves exactly
 * like a second process. Exclusion while a holder is live, admission after
 * disposal, lock-file residue rules, and the inode verification that defeats
 * an unlinked-and-recreated lock path. The Win32 named-semaphore protocol is
 * exercised through the lease's arbitration seam with an injected primitive;
 * filesystem and flock refusals are injected through the module mocks below
 * because an injected error is the only deterministic cross-platform refusal.
 * Real cross-process exclusion and crash release are pinned by
 * lease.two-process.spec.ts.
 */

import { existsSync } from 'node:fs'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '../src/index.ts'
import { LEASE_FILENAME, SessionWriteLease } from '../src/lease.ts'
import type { LeaseArbitration } from '../src/lease.ts'
import { logPath, sessionDir } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

// The lock's base name, duplicated for the hoisted mock factories: they run
// while `../src/lease.ts` is still evaluating, before LEASE_FILENAME exists.
const LOCK = vi.hoisted(() => 'session.lock')

const refuse = vi.hoisted(() => ({
  /** Next open of a lock file fails EACCES (read-only directory). */
  lockOpen: false,
  /** Next stat of a lock file fails EACCES (unreadable path). */
  lockStat: false,
  /** For N further lock-path stats: unlink and recreate the file first, so the locked inode is orphaned. */
  swapLockOnStat: 0,
  /** Next lock-path stat: unlink the file first, so the verify read finds nothing. */
  dropLockOnStat: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const denied = (syscall: string): never => {
    throw Object.assign(new Error(`EACCES: injected ${syscall} refusal`), { code: 'EACCES' })
  }
  return {
    ...actual,
    openSync: ((path: unknown, ...rest: never[]) => {
      if (refuse.lockOpen && String(path).endsWith(LOCK)) {
        refuse.lockOpen = false
        denied('open')
      }
      return (actual.openSync as (path: unknown, ...args: never[]) => number)(path, ...rest)
    }) as typeof actual.openSync,
    statSync: ((path: unknown, ...rest: never[]) => {
      const at = String(path)
      if (at.endsWith(LOCK)) {
        if (refuse.lockStat) {
          refuse.lockStat = false
          denied('stat')
        }
        if (refuse.dropLockOnStat) {
          refuse.dropLockOnStat = false
          actual.unlinkSync(at)
        } else if (refuse.swapLockOnStat > 0) {
          refuse.swapLockOnStat -= 1
          actual.unlinkSync(at)
          actual.writeFileSync(at, '')
        }
      }
      return (actual.statSync as (path: unknown, ...args: never[]) => ReturnType<typeof actual.statSync>)(path, ...rest)
    }) as typeof actual.statSync,
  }
})

const dirs: string[] = []
const mounts: Array<{ ctx: Context; backend: SessionPersistence }> = []

afterEach(async () => {
  refuse.lockOpen = false
  refuse.lockStat = false
  refuse.swapLockOnStat = 0
  refuse.dropLockOnStat = false
  for (const { ctx } of mounts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const EVENTS: readonly SessionEvent[] = oneTurnLog()

/** Two events continuing {@link EVENTS} at the given base seq. */
function continuation(base: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: base, time: base + 1, data: { turn: 2 } },
    { type: 'turn/end', seq: base + 1, time: base + 2, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-lease-'))
  dirs.push(root)
  return root
}

async function mount(root: string): Promise<JsonlSessionPersistence> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const backend = ctx.sessionPersistence as JsonlSessionPersistence
  mounts.push({ ctx, backend })
  return backend
}

/** Dispose exactly one mounted backend (releasing its held leases). */
async function unmount(backend: SessionPersistence): Promise<void> {
  const index = mounts.findIndex(mounted => mounted.backend === backend)
  const [entry] = mounts.splice(index, 1)
  if (entry === undefined) throw new Error('unmount: backend is not mounted')
  await entry.ctx.fiber.dispose()
}

function lockPath(root: string, id: string, cwd = '/work'): string {
  return join(sessionDir(root, cwd, SessionId(id)), LEASE_FILENAME)
}

/** A held lease over the session's directory, as a foreign process would take it. */
function foreignLease(root: string, id: string, cwd = '/work'): Promise<SessionWriteLease> {
  return SessionWriteLease.acquire(sessionDir(root, cwd, SessionId(id)), SessionId(id))
}

/** A torn fragment a crashed writer never fully flushed: a partial line with no newline. */
async function tearTail(root: string, id: string): Promise<void> {
  await appendFile(logPath(root, '/work', SessionId(id), 'none'), '{"type":"assistant/chunk","seq":8,"ti')
}

describe('SessionWriteLease: POSIX kernel lock', () => {
  it.skipIf(process.platform === 'win32')('a second acquire over a held lock rejects as already-owned, and release admits the next', async () => {
    const dir = join(await freshRoot(), 'solo')
    const holder = await SessionWriteLease.acquire(dir, SessionId('solo'))
    await expect(SessionWriteLease.acquire(dir, SessionId('solo'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await holder.release()
    const successor = await SessionWriteLease.acquire(dir, SessionId('solo'))
    await successor.release()
  })

  it.skipIf(process.platform === 'win32')('release is idempotent and never removes the lock file', async () => {
    const dir = join(await freshRoot(), 'solo')
    const lease = await SessionWriteLease.acquire(dir, SessionId('solo'))
    await lease.release()
    await lease.release()
    // The file survives every release, keeping the stable inode later
    // lockers verify against; the kernel lock died with the descriptor.
    expect(existsSync(join(dir, LOCK))).toBe(true)
    const successor = await SessionWriteLease.acquire(dir, SessionId('solo'))
    await successor.release()
    expect(existsSync(join(dir, LOCK))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('removing the lock file forfeits a wedged holder: a fresh inode admits a successor', async () => {
    const dir = join(await freshRoot(), 'wedged')
    const wedged = await SessionWriteLease.acquire(dir, SessionId('wedged'))
    // The documented escape hatch for a live-but-stuck holder: deleting the
    // lock file orphans the held inode, and a successor locks the fresh one.
    await rm(join(dir, LOCK))
    const successor = await SessionWriteLease.acquire(dir, SessionId('wedged'))
    await successor.release()
    await wedged.release()
  })

  it.skipIf(process.platform === 'win32')('retries when the locked inode is no longer the lock path, and wins on a stable pass', async () => {
    const dir = join(await freshRoot(), 'churned')
    // One churn (unlink+recreate under the verify stat) orphans the first
    // locked inode; the retry locks the fresh file and verifies clean.
    refuse.swapLockOnStat = 1
    const lease = await SessionWriteLease.acquire(dir, SessionId('churned'))
    await lease.release()
  })

  it.skipIf(process.platform === 'win32')('retries when the lock path vanishes under the verify read', async () => {
    const dir = join(await freshRoot(), 'vanished')
    refuse.dropLockOnStat = true
    const lease = await SessionWriteLease.acquire(dir, SessionId('vanished'))
    await lease.release()
  })

  it.skipIf(process.platform === 'win32')('gives up as already-owned when the lock path never stabilizes', async () => {
    const dir = join(await freshRoot(), 'unstable')
    // Churn on every attempt: the bounded retry refuses rather than spinning.
    refuse.swapLockOnStat = 3
    await expect(SessionWriteLease.acquire(dir, SessionId('unstable'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })

  it.skipIf(process.platform === 'win32')('surfaces a filesystem refusal opening the lock file', async () => {
    const dir = join(await freshRoot(), 'open-blocked')
    refuse.lockOpen = true
    await expect(SessionWriteLease.acquire(dir, SessionId('open-blocked'))).rejects.toThrow(/EACCES/)
  })

  it.skipIf(process.platform === 'win32')('surfaces a lock-path stat refusal from the inode verification', async () => {
    const dir = join(await freshRoot(), 'stat-blocked')
    refuse.lockStat = true
    await expect(SessionWriteLease.acquire(dir, SessionId('stat-blocked'))).rejects.toThrow(/EACCES/)
  })
})

describe('SessionWriteLease: flock refusal mapping', () => {
  /** Acquire with one injected flock outcome replacing the real kernel call. */
  function withFlock(flockExnb: () => Promise<void>, dir: string): Promise<SessionWriteLease> {
    const arbitration: LeaseArbitration = { flockExnb }
    return SessionWriteLease.acquire(dir, SessionId('refusal'), arbitration)
  }

  it('maps the EWOULDBLOCK contention spelling to already-owned', async () => {
    const busy = Object.assign(new Error('EWOULDBLOCK: injected contention'), { code: 'EWOULDBLOCK' })
    await expect(withFlock(() => Promise.reject(busy), join(await freshRoot(), 'a')))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })

  it('maps the raw Linux EAGAIN errno from the libc binding to already-owned', async () => {
    const busy = Object.assign(new Error('flock errno 11'), { errno: 11 })
    await expect(withFlock(() => Promise.reject(busy), join(await freshRoot(), 'b')))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })

  it('maps the raw Darwin EAGAIN errno from the libc binding to already-owned', async () => {
    const busy = Object.assign(new Error('flock errno 35'), { errno: 35 })
    await expect(withFlock(() => Promise.reject(busy), join(await freshRoot(), 'c')))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })

  it('propagates a non-contention flock failure', async () => {
    const denied = Object.assign(new Error('EACCES: injected flock refusal'), { code: 'EACCES' })
    await expect(withFlock(() => Promise.reject(denied), join(await freshRoot(), 'd')))
      .rejects.toThrow(/EACCES/)
  })
})

describe('SessionWriteLease: Win32 named semaphore (injected arbitration)', () => {
  /** A stateful count-1 semaphore fake: the kernel primitive's protocol. */
  function semaphoreFake(): { arbitration: LeaseArbitration; state: { held: boolean; released: number[] } } {
    const state = { held: false, released: [] as number[] }
    let next = 7
    const arbitration: LeaseArbitration = {
      platform: 'win32',
      acquireLockHandle: () => {
        if (state.held) {
          throw Object.assign(new Error('EBUSY: injected semaphore wait timeout'), { code: 'EBUSY' })
        }
        state.held = true
        return Promise.resolve(next++)
      },
      releaseLockHandle: async (handle) => {
        state.released.push(handle)
        state.held = false
      },
    }
    return { arbitration, state }
  }

  it('a held semaphore excludes a second lease, and release restores admission', async () => {
    const { arbitration, state } = semaphoreFake()
    const dir = join(await freshRoot(), 'sem')
    const holder = await SessionWriteLease.acquire(dir, SessionId('sem'), arbitration)
    await expect(SessionWriteLease.acquire(dir, SessionId('sem'), arbitration))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await holder.release()
    expect(state.released).toEqual([7])
    const successor = await SessionWriteLease.acquire(dir, SessionId('sem'), arbitration)
    await successor.release()
    expect(state.released).toEqual([7, 8])
  })

  it('propagates a non-EBUSY acquisition failure', async () => {
    const denied = Object.assign(new Error('EACCES: injected CreateSemaphoreW refusal'), { code: 'EACCES' })
    const arbitration: LeaseArbitration = {
      platform: 'win32',
      acquireLockHandle: () => Promise.reject(denied),
    }
    await expect(SessionWriteLease.acquire(join(await freshRoot(), 'denied'), SessionId('denied'), arbitration))
      .rejects.toThrow(/EACCES/)
  })

  it('propagates a release failure from the semaphore primitive', async () => {
    const arbitration: LeaseArbitration = {
      platform: 'win32',
      acquireLockHandle: () => Promise.resolve(9),
      releaseLockHandle: () => Promise.reject(new Error('EIO: injected release failure')),
    }
    const lease = await SessionWriteLease.acquire(join(await freshRoot(), 'release-fails'), SessionId('release-fails'), arbitration)
    await expect(lease.release()).rejects.toThrow(/injected release failure/)
  })
})

describe('JSONL backend write lease', () => {
  it('excludes a second backend over the same root while the holder is live, and admits it after disposal', async () => {
    const root = await freshRoot()
    const holder = await mount(root)
    const rival = await mount(root)
    await holder.create(meta('excluded', '/work'))
    await holder.append(SessionId('excluded'), EVENTS)

    // The rival adopts the stored log, then its first durable write refuses:
    // the kernel lock names the same session directory.
    await expect(rival.append(SessionId('excluded'), continuation(EVENTS.length)))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    // The failed attempt leaves the rival's adopted state usable: once the
    // holder's disposal releases the lease, the same append commits.
    await unmount(holder)
    await expect(rival.append(SessionId('excluded'), continuation(EVENTS.length))).resolves.toBeUndefined()
  })

  it('a never-materialized create leaves no filesystem footprint at all', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('erased', '/work'))
    // The lease is taken only at the first materializing write, so an
    // unmaterialized session creates neither its directory nor a lock file.
    expect(existsSync(sessionDir(root, '/work', SessionId('erased')))).toBe(false)
    await unmount(backend)
    expect(existsSync(sessionDir(root, '/work', SessionId('erased')))).toBe(false)
    const rival = await mount(root)
    expect(await rival.list()).toEqual([])
  })

  it('closing an open turn without a torn tail still takes the lease and appends the closers', async () => {
    const root = await freshRoot()
    const holder = await mount(root)
    const rival = await mount(root)
    await holder.create(meta('closers-only', '/work'))
    await holder.append(SessionId('closers-only'), EVENTS)
    // A materialized session whose stored tail is clean but whose last turn never
    // closed: repair carries synthetic closers and NO torn marker.
    const closers = continuation(EVENTS.length)
    await expect(holder.commitRepair(meta('closers-only', '/work'), undefined, closers)).resolves.toBeUndefined()
    // The repair went through the same lease: a rival stays excluded.
    await expect(rival.append(SessionId('closers-only'), continuation(EVENTS.length + 2)))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await unmount(holder)
    const reader = await mount(root)
    const loaded = await reader.load(SessionId('closers-only'))
    expect(loaded.events.map(event => event.seq)).toEqual([...EVENTS.map(event => event.seq), ...closers.map(event => event.seq)])
    await unmount(reader)
    await unmount(rival)
  })

  it('an empty repair takes no lease and touches nothing', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('empty-repair', '/work'))
    // Neither a torn marker nor closers: the call is a no-op that must not
    // materialize the session or publish a lock file.
    await expect(backend.commitRepair(meta('empty-repair', '/work'), undefined, [])).resolves.toBeUndefined()
    expect(existsSync(sessionDir(root, '/work', SessionId('empty-repair')))).toBe(false)
    await unmount(backend)
  })

  it('materialization publishes the lock with the first batch, keeps it through later appends, and never removes the file', async () => {
    const root = await freshRoot()
    const holder = await mount(root)
    const rival = await mount(root)
    await holder.create(meta('lazy-lock', '/work'))
    await holder.append(SessionId('lazy-lock'), EVENTS)
    expect(existsSync(lockPath(root, 'lazy-lock'))).toBe(true)
    await expect(rival.append(SessionId('lazy-lock'), continuation(EVENTS.length)))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    // A later append reuses the held lease rather than re-acquiring.
    await holder.append(SessionId('lazy-lock'), continuation(EVENTS.length))
    await unmount(holder)
    // The lock FILE survives disposal (inode stability); the kernel lock is gone.
    expect(existsSync(lockPath(root, 'lazy-lock'))).toBe(true)
    // A fresh mount adopts the stored log (the rival's adopted cursor predates
    // the holder's second append) and appends past the retained lock file.
    const successor = await mount(root)
    await expect(successor.append(SessionId('lazy-lock'), continuation(EVENTS.length + 2))).resolves.toBeUndefined()
  })

  it('torn-tail repair takes the lease: a foreign holder blocks load, and release admits the repair', async () => {
    const root = await freshRoot()
    const writer = await mount(root)
    await writer.create(meta('torn', '/work'))
    await writer.append(SessionId('torn'), EVENTS)
    await tearTail(root, 'torn')
    await unmount(writer)

    const foreign = await foreignLease(root, 'torn')
    const repairer = await mount(root)
    await expect(repairer.load(SessionId('torn'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await foreign.release()

    const loaded = await repairer.load(SessionId('torn'))
    expect(loaded.events.map(event => event.seq)).toEqual(EVENTS.map(event => event.seq))
    // The repair committed under the lease, which the backend keeps until
    // disposal: a foreign acquirer is still excluded.
    await expect(foreignLease(root, 'torn')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await unmount(repairer)
    const taken = await foreignLease(root, 'torn')
    await taken.release()
  })

  it('loading a clean log takes no lease: readers never touch the lock', async () => {
    const root = await freshRoot()
    const writer = await mount(root)
    await writer.create(meta('clean', '/work'))
    await writer.append(SessionId('clean'), EVENTS)
    await unmount(writer)

    const reader = await mount(root)
    const loaded = await reader.load(SessionId('clean'))
    expect(loaded.events).toHaveLength(EVENTS.length)
    // No lease was taken: a raw acquire over the same directory wins while
    // the reader stays alive.
    const probe = await foreignLease(root, 'clean')
    await probe.release()
  })

  it('delete refuses while a foreign holder keeps the lease, then succeeds and releases', async () => {
    const root = await freshRoot()
    const writer = await mount(root)
    await writer.create(meta('doomed', '/work'))
    await writer.append(SessionId('doomed'), EVENTS)
    await unmount(writer)

    const foreign = await foreignLease(root, 'doomed')
    const deleter = await mount(root)
    await expect(deleter.delete(SessionId('doomed'))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect(existsSync(logPath(root, '/work', SessionId('doomed'), 'none'))).toBe(true)
    await foreign.release()

    await expect(deleter.delete(SessionId('doomed'))).resolves.toBe(true)
    expect(existsSync(logPath(root, '/work', SessionId('doomed'), 'none'))).toBe(false)
    // Deletion released the lease it briefly took; the lock file itself stays.
    expect(existsSync(lockPath(root, 'doomed'))).toBe(true)
    const taken = await foreignLease(root, 'doomed')
    await taken.release()
  })

  it('deleting an absent id acquires no lease and leaves no directory footprint', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await expect(backend.delete(SessionId('never'))).resolves.toBe(false)
    expect(existsSync(sessionDir(root, '/work', SessionId('never')))).toBe(false)
  })

  it('a failing lease release at close surfaces and the remaining leases still release', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await backend.create(meta('close-fails', '/work'))
    await backend.append(SessionId('close-fails'), EVENTS)
    const spy = vi.spyOn(SessionWriteLease.prototype, 'release')
    spy.mockImplementationOnce(async function (this: SessionWriteLease) {
      spy.mockRestore()
      await this.release()
      throw Object.assign(new Error('EIO: injected release failure'), { code: 'EIO' })
    })
    const failure = await backend.close().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(1)
    expect(String((failure as AggregateError).errors[0])).toMatch(/injected release failure/)
    // The failed release still freed the kernel lock (close(2) semantics).
    await expect(foreignLease(root, 'close-fails')).resolves.toBeInstanceOf(SessionWriteLease)
  })
})
