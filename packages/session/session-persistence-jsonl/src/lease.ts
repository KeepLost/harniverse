/**
 * Cross-process write-ownership lease for one session's artifact directory,
 * held from the holder's first durable write until it retires, deletes, or
 * disposes the session. The arbiter is the kernel: POSIX takes a
 * non-blocking `flock(2)` on `session.lock` beside the log, and Windows
 * holds a named kernel semaphore derived from that path — never a file lock
 * or handle, so readers, searches, and directory removal proceed freely
 * while the lease is held. Contention maps to
 * {@link SessionAlreadyOwnedError}; the kernel releases the lease when the
 * holder's descriptor or last object handle closes, including on any process
 * death, so a crashed holder never blocks a successor (the takeover then
 * runs the normal torn-tail recovery). A live but wedged holder keeps the
 * lease until its process exits: there is deliberately no expiry that could
 * expropriate a stalled writer whose resumed appends would tear the log.
 * A POSIX lock names an inode, not a path, so after locking the holder
 * verifies the locked inode is still the file at the lock path and retries
 * otherwise: an unlinked-and-recreated lock file carries a fresh inode, and
 * a lock on the orphaned one proves nothing. Removing a live session's lock
 * file therefore forfeits exclusion on POSIX (nothing in the harness does
 * so); Windows has no lock file at all. Readers never touch the lock.
 * Release never removes the POSIX lock file: every acquired lease belongs
 * to a materialized or materializing session, and the surviving file keeps
 * the stable inode later lockers verify against.
 * The arbitration primitives are injectable ({@link LeaseArbitration}) so
 * each platform's protocol stays testable on every host.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/lease
 */

import { closeSync, fstatSync, openSync, statSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { flockExnbPosix } from './posix.ts'
import { acquireLockHandleWin32, releaseLockHandleWin32 } from './win32.ts'

/** Base name of the kernel lock file inside a session's directory. */
export const LEASE_FILENAME = 'session.lock'

/**
 * The kernel-arbitration primitives one lease uses. Every field is optional:
 * omitted fields fall back to this host's real primitive, and injected
 * replacements keep the other platform's protocol testable locally.
 */
export interface LeaseArbitration {
  /** Which platform's primitive arbitrates; defaults to the host platform. */
  readonly platform?: 'posix' | 'win32'
  /** POSIX non-blocking exclusive flock on an open descriptor. */
  readonly flockExnb?: (fd: number) => Promise<void>
  /** Win32 named-semaphore acquisition returning a kernel handle. */
  readonly acquireLockHandle?: (path: string) => Promise<number>
  /** Win32 release for a handle from {@link LeaseArbitration.acquireLockHandle}. */
  readonly releaseLockHandle?: (handle: number) => Promise<void>
}

/** The held kernel lease: a POSIX descriptor or a Win32 semaphore handle. */
type HeldLease =
  | { readonly kind: 'posix'; readonly fd: number }
  | { readonly kind: 'win32'; readonly handle: number; readonly release: (handle: number) => Promise<void> }

/** Whether a flock failure means another descriptor holds the lock. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  // flock(2) reports EAGAIN; some libcs spell it EWOULDBLOCK.
  if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return true
  // The direct libc binding reports the raw errno without a symbolic code.
  const errno = (error as NodeJS.ErrnoException | null)?.errno
  return errno === 11 /* EAGAIN on Linux */ || errno === 35 /* EAGAIN on Darwin */
}

/** The host platform's arbitration, unless a test injects the other side's. */
function defaultArbitrationPlatform(): 'posix' | 'win32' {
  /* v8 ignore next -- native Windows arbitration picks the semaphore; Linux covers injected win32 and default POSIX */
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/**
 * One held write lease. Constructed only by {@link SessionWriteLease.acquire};
 * `release` closes the descriptor or handle, which is what releases the lease.
 */
export class SessionWriteLease {
  private released = false

  private constructor(private readonly held: HeldLease) {}

  /**
   * Acquire the session directory's kernel write lease.
   * @param dir - the session's artifact directory (created if absent).
   * @param id - the session the lease guards, for error identities.
   * @param arbitration - optional primitive injection for cross-platform tests.
   * @returns the held lease.
   * @throws {SessionAlreadyOwnedError} while another holder keeps the lease.
   */
  static async acquire(dir: string, id: SessionId, arbitration: LeaseArbitration = {}): Promise<SessionWriteLease> {
    const path = join(dir, LEASE_FILENAME)
    // Owner-only like the backend's materialized directories: the lease may
    // create the session directory first, and both creators agree on the mode.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const platform = arbitration.platform ?? defaultArbitrationPlatform()
    if (platform === 'win32') {
      let acquire = arbitration.acquireLockHandle
      /* v8 ignore next -- native Windows coverage loads the default; Linux covers the injected peer */
      if (acquire === undefined) acquire = acquireLockHandleWin32
      let handle: number
      try {
        handle = await acquire(path)
      } catch (error: unknown) {
        // Wait timeout: another handle already holds the write exclusion.
        if ((error as NodeJS.ErrnoException | null)?.code === 'EBUSY') throw new SessionAlreadyOwnedError(id)
        throw error
      }
      let release = arbitration.releaseLockHandle
      /* v8 ignore next -- native Windows coverage loads the default; Linux covers the injected peer */
      if (release === undefined) release = releaseLockHandleWin32
      return new SessionWriteLease({ kind: 'win32', handle, release })
    }
    const flockExnb = arbitration.flockExnb ?? flockExnbPosix
    // Bounded retry: locking an inode a releasing creator just unlinked (or a
    // recreated path) re-opens the fresh file; steady state needs one pass.
    // Raw descriptors, not FileHandles: the lease must outlive every reference
    // except its explicit release, so nothing closes it on garbage collection.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fd = openSync(path, 'w')
      try {
        try {
          await flockExnb(fd)
        } catch (error: unknown) {
          if (isLockContention(error)) throw new SessionAlreadyOwnedError(id)
          throw error
        }
        const held = fstatSync(fd, { bigint: true })
        let current: BigIntStats | undefined
        try {
          current = statSync(path, { bigint: true })
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
        }
        if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
          return new SessionWriteLease({ kind: 'posix', fd })
        }
      } catch (error: unknown) {
        closeSync(fd)
        throw error
      }
      // The locked inode is no longer the file at the lock path: start over
      // against whatever now stands there.
      /* v8 ignore next -- Windows uses the named semaphore branch above. */
      closeSync(fd)
    }
    /* v8 ignore next -- Windows cannot reach the POSIX inode-retry exhaustion. */
    throw new SessionAlreadyOwnedError(id)
  }

  /**
   * Release the kernel lease by closing its descriptor or handle. The POSIX
   * lock file is never removed: every acquired lease belongs to a
   * materialized or materializing session, and keeping the file preserves
   * the stable inode later lockers verify against. Idempotent.
   */
  async release(): Promise<void> {
    /* v8 ignore next -- the idempotent POSIX release path is not loaded on Windows. */
    if (this.released) return
    this.released = true
    if (this.held.kind === 'win32') {
      await this.held.release(this.held.handle)
      return
    }
    /* v8 ignore next -- Windows holds a semaphore handle, not a POSIX fd. */
    closeSync(this.held.fd)
  }
}
